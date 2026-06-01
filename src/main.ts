// The Action entrypoint — assembles the SiftCommentContext, resolves the
// baseline, invokes the engine, renders the frame, posts the sticky comment, and
// seeds the next baseline. Orchestration only; all content is the engine's and
// all copy is the frame's (sift_action_contract.md § 2.2 / § 8).

import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveBaseline } from './baseline';
import { upsertStickyComment } from './comment';
import { publishBaselineLog } from './artifact';
import { renderComment } from './frame';
import { resolveSift } from './resolve-sift';
import { runSift, type FailOn } from './sift';
import { CONTEXT_VERSION, type BuildStatus, type SiftCommentContext } from './types';

function readBuildStatus(): BuildStatus {
    const raw = (core.getInput('build-status') || 'unknown').toLowerCase();
    return raw === 'green' || raw === 'red' ? raw : 'unknown';
}

function readFailOn(): FailOn {
    const raw = (core.getInput('fail-on') || 'none').toLowerCase();
    return raw === 'significant' || raw === 'regression' ? raw : 'none';
}

// A GitHub write that may be denied on a fork PR (read-only token, contract § 6).
// Surface it — never silently no-op — but don't fail the run: the exit-code gate
// still holds without the comment.
async function tryWrite(label: string, write: () => Promise<unknown>): Promise<void> {
    try {
        await write();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(
            `Sift: could not ${label} (${message}). Likely a fork PR's read-only token ` +
                `(contract § 6) — the advisory gate still applies; the comment/baseline did not update.`,
        );
    }
}

async function run(): Promise<void> {
    const logInput = core.getInput('log', { required: true });
    const failOn = readFailOn();
    const buildStatus = readBuildStatus();
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-'));
    const changedLog = path.join(workDir, 'changed.log');
    await fs.copyFile(logInput, changedLog); // the captured current-run log = changed.log

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
        // No PR (e.g. a base-branch push): seed the baseline for future PRs; no comment.
        await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog));
        core.info('Sift: no PR context — published the baseline-log seed only (no comment).');
        return;
    }

    const prNumber = pullRequest.number;
    const headSha = pullRequest.head.sha as string;
    const baseBranch = pullRequest.base.ref as string;

    const baseline = await resolveBaseline({
        octokit,
        owner,
        repo,
        runId: github.context.runId,
        baseBranch,
        workDir,
    });

    const context: SiftCommentContext = {
        context_version: CONTEXT_VERSION,
        head_sha: headSha,
        pr_number: prNumber,
        base_branch: baseBranch,
        build_status: buildStatus,
        baseline: baseline?.meta,
    };

    let gateExit = 0;
    let body: string;
    if (!baseline) {
        // Cold start (contract § 3): no baseline ⇒ the engine is NOT invoked.
        body = renderComment(null, context);
        core.info('Sift: cold start — no baseline to diff against.');
    } else {
        // Resolve the binary only now — cold-start and base-branch pushes never
        // invoke the engine, so they skip the download (resolve-sift.ts, Argos lane).
        const siftBin = await resolveSift(core.getInput('sift-binary'), workDir);
        const { report, exitCode } = await runSift({
            siftBin,
            baselineLog: baseline.logPath,
            changedLog,
            baselineLabel: baseline.meta.sha.slice(0, 7),
            changedLabel: headSha.slice(0, 7),
            failOn,
            outputPath: path.join(workDir, 'report.json'),
        });
        gateExit = exitCode;
        body = renderComment(report, context);
    }

    await tryWrite('post the PR comment', () =>
        upsertStickyComment({ octokit, owner, repo, prNumber, body }),
    );
    // Every run seeds future baselines — including this PR's own follow-up pushes.
    await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog));

    // Advisory gate (contract § 8): the exit/check carries the verdict; the COMMENT
    // never says "we blocked your merge".
    if (gateExit !== 0) {
        core.setFailed(`Sift gate (--fail-on ${failOn}) tripped — see the PR comment for what changed.`);
    }
}

run().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
});
