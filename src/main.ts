// The Action entrypoint — resolves the baseline, invokes the engine, renders the
// frame, ALWAYS writes the job summary + machine-readable outputs (so the result is
// retrievable whatever the comment config), then posts to the configured surface (PR
// sticky comment / push commit comment, each level-gated) and seeds the next baseline.
// Orchestration only; all content is the engine's and all copy is the frame's
// (sift_action_contract.md § 2.2 / § 3 / § 8).

import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveBaseline } from './baseline';
import { upsertStickyComment, upsertCommitComment } from './comment';
import { publishBaselineLog, writeRenderedComment } from './artifact';
import { renderComment } from './frame';
import { runPoster } from './poster';
import { resolveSift } from './resolve-sift';
import { runSift, type FailOn } from './sift';
import { selectState, shouldComment, State, type CommentLevel } from './verdict';
import {
    CONTEXT_VERSION,
    SIFT_COMMENT_DIR,
    type BuildStatus,
    type SiftCommentContext,
    type SiftReport,
} from './types';

// Three modes (contract § 6.1):
//   comment (default) — render + post the sticky comment inline. Same-repo PRs and
//                       the proven path; the advisory gate fails the build.
//   render            — render the escaped body to $RUNNER_TEMP/sift-comment/ and
//                       NEVER post (no write token, untrusted-parse context). The
//                       consumer's workflow uploads it; the gate does NOT fail the
//                       build (else the upload step is skipped and the comment is
//                       lost). The unprivileged fork build job.
//   post              — run NO engine: download the rendered artifact off the
//                       triggering run and upsert the comment. The privileged
//                       workflow_run poster (→ poster.ts). OFF until a consumer
//                       wires the fork topology.
type Mode = 'comment' | 'render' | 'post';
function readMode(): Mode {
    const raw = (core.getInput('mode') || 'comment').toLowerCase();
    return raw === 'render' || raw === 'post' ? raw : 'comment';
}

function readBuildStatus(): BuildStatus {
    const raw = (core.getInput('build-status') || 'unknown').toLowerCase();
    return raw === 'green' || raw === 'red' ? raw : 'unknown';
}

function readFailOn(): FailOn {
    const raw = (core.getInput('fail-on') || 'none').toLowerCase();
    return raw === 'significant' || raw === 'regression' ? raw : 'none';
}

// Each comment surface carries its OWN level (no shared floor): pr-comment defaults to
// `always` (the green "✅ no change" reassurance stays); commit-comment defaults to
// `never` (quiet on push). Values: never | regression | significant | always.
function readCommentLevel(input: string, fallback: CommentLevel): CommentLevel {
    const raw = (core.getInput(input) || fallback).toLowerCase();
    return raw === 'never' || raw === 'regression' || raw === 'significant' || raw === 'always'
        ? (raw as CommentLevel)
        : fallback;
}

// Machine-readable verdict — set on EVERY run (PR or push), before any comment decision, so a
// later step can branch on Sift's result without parsing a comment (contract § 3).
function setSiftOutputs(state: State, report: SiftReport | null): void {
    core.setOutput('state', state); // cold-start | clean | drift | regression
    core.setOutput('total-changes', report?.summary.total_changes ?? 0);
    core.setOutput('significant-changes', report?.summary.significant_changes ?? 0);
    core.setOutput('regression', state === State.Regression);
}

// A GitHub write that may be denied on a fork PR (read-only token, contract § 6) or for a missing
// scope (e.g. commit comments need contents: write). Surface it — never silently no-op — but don't
// fail the run: the exit-code gate still holds without the comment.
async function tryWrite(label: string, write: () => Promise<unknown>): Promise<void> {
    try {
        await write();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(
            `Sift: could not ${label} (${message}). Likely a fork PR's read-only token or a missing ` +
                `scope (contract § 6) — the advisory gate still applies; the comment/baseline did not update.`,
        );
    }
}

async function run(): Promise<void> {
    const mode = readMode();
    if (mode === 'post') {
        // Privileged poster: no engine, no log — download the rendered artifact and
        // upsert the comment. Fully handled in poster.ts.
        await runPoster();
        return;
    }

    const logInput = core.getInput('log', { required: true });
    const failOn = readFailOn();
    const buildStatus = readBuildStatus();
    const prComment = readCommentLevel('pr-comment', 'always');
    const commitComment = readCommentLevel('commit-comment', 'never');
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-'));
    const changedLog = path.join(workDir, 'changed.log');
    await fs.copyFile(logInput, changedLog); // the captured current-run log = changed.log

    // PR vs push differ ONLY in the comment surface (sticky vs commit), its level, the baseline
    // branch, and the head sha. The diff, the job summary, the outputs, and the gate are shared.
    const pr = github.context.payload.pull_request;
    const baseBranch = pr ? (pr.base.ref as string) : github.context.ref.replace(/^refs\/heads\//, '');
    const headSha = pr ? (pr.head.sha as string) : github.context.sha;

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
        pr_number: pr ? (pr.number as number) : undefined,
        base_branch: baseBranch,
        build_status: buildStatus,
        baseline: baseline?.meta,
    };

    // Diff — or cold start (contract § 3): no baseline ⇒ the engine is NOT invoked.
    let gateExit = 0;
    let report: SiftReport | null = null;
    if (baseline) {
        const siftBin = await resolveSift(core.getInput('sift-binary'), workDir);
        const result = await runSift({
            siftBin,
            baselineLog: baseline.logPath,
            changedLog,
            baselineLabel: baseline.meta.sha.slice(0, 7),
            changedLabel: headSha.slice(0, 7),
            failOn,
            outputPath: path.join(workDir, 'report.json'),
        });
        gateExit = result.exitCode;
        report = result.report;
    } else {
        core.info(`Sift: cold start — no baseline on \`${baseBranch}\` yet.`);
    }
    const body = renderComment(report, context);
    const state = selectState(report);

    // ALWAYS retrievable: the job summary + machine-readable outputs are written every run,
    // before any comment decision — so the result is in the job info whatever the comment config.
    await core.summary.addRaw(body).write();
    setSiftOutputs(state, report);

    if (mode === 'render') {
        // Fork build job (contract § 6.1): write the escaped body for the workflow_run poster;
        // NEVER post or fail the build from here. (The fork path posts unconditionally for now —
        // pr-comment level gating across the render→post boundary is a separate follow-up.)
        const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
        const commentDir = path.join(runnerTemp, SIFT_COMMENT_DIR);
        await writeRenderedComment(body, headSha, commentDir);
        core.info(`Sift: render mode — wrote the comment body to ${commentDir} (the workflow uploads it).`);
        await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog));
        return;
    }

    // Comment surface, level-gated. Below the level ⇒ no comment — the result is still in the job
    // summary + outputs above. Each surface has its own level (req: no shared floor).
    if (pr) {
        if (shouldComment(state, prComment)) {
            await tryWrite('post the PR comment', () =>
                upsertStickyComment({ octokit, owner, repo, prNumber: pr.number as number, body }),
            );
        } else {
            core.info(`Sift: pr-comment=${prComment} — verdict ${state} below threshold, no comment (result in the job summary).`);
        }
    } else if (shouldComment(state, commitComment)) {
        await tryWrite('post the commit comment (needs contents: write)', () =>
            upsertCommitComment({ octokit, owner, repo, commitSha: headSha, body }),
        );
        core.info(`Sift: push — commit comment upserted on ${headSha.slice(0, 7)} (commit-comment: ${commitComment}).`);
    } else {
        core.info(`Sift: push — commit-comment=${commitComment}, verdict ${state} below threshold (result in the job summary).`);
    }

    // Seed the next baseline. A push is GREEN-GATED (a red build never overwrites the last-green
    // baseline — it still diffs against the prior green); a PR seeds as before.
    if (!pr && buildStatus === 'red') {
        core.info('Sift: red build — kept the previous green baseline (did not re-seed).');
    } else {
        await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog));
    }

    // Advisory gate (contract § 8): the exit code carries the verdict; the comment never says "we
    // blocked your merge". Applies to PR and push alike; render mode returned above (failing it
    // would skip the consumer's artifact upload, losing the rendered comment).
    if (gateExit !== 0) {
        core.setFailed(`Sift gate (--fail-on ${failOn}) tripped — see the comment / job summary for what changed.`);
    }
}

run().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
});
