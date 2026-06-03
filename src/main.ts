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
import { upsertStickyComment, upsertCommitComment } from './comment';
import { publishBaselineLog, writeRenderedComment } from './artifact';
import { renderComment } from './frame';
import { runPoster } from './poster';
import { resolveSift } from './resolve-sift';
import { runSift, type FailOn } from './sift';
import { selectState, shouldCommitComment, State, type CommitCommentLevel } from './verdict';
import {
    CONTEXT_VERSION,
    SIFT_COMMENT_DIR,
    type BuildStatus,
    type SiftCommentContext,
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

// Push mode only (contract § 3): on a push, ALSO post a commit comment when the verdict clears
// this level. Default `none` = job summary only (quiet). Mirrors `fail-on`'s vocabulary.
function readCommitCommentLevel(): CommitCommentLevel {
    const raw = (core.getInput('commit-comment') || 'none').toLowerCase();
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
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-'));
    const changedLog = path.join(workDir, 'changed.log');
    await fs.copyFile(logInput, changedLog); // the captured current-run log = changed.log

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
        // PUSH (trunk commit, e.g. to main): no PR to comment on. Diff this run against the
        // last-green baseline and report to the JOB SUMMARY ($GITHUB_STEP_SUMMARY), then re-seed
        // GREEN-GATED — a red build still diffs against last-green but never overwrites the
        // baseline. This is what makes Sift useful on a trunk / push-to-main workflow with no PRs
        // (contract § 3). `render`/`post` modes are PR-only and never reach here.
        const branch = github.context.ref.replace(/^refs\/heads\//, '');
        const pushSha = github.context.sha;
        const baseline = await resolveBaseline({
            octokit,
            owner,
            repo,
            runId: github.context.runId,
            baseBranch: branch,
            workDir,
        });
        const pushContext: SiftCommentContext = {
            context_version: CONTEXT_VERSION,
            head_sha: pushSha,
            base_branch: branch,
            build_status: buildStatus,
            baseline: baseline?.meta,
        };
        let pushGateExit = 0;
        let pushState: State = State.ColdStart;
        let summaryBody: string;
        if (!baseline) {
            summaryBody = renderComment(null, pushContext); // cold start (contract § 3): no diff yet
            core.info(`Sift: push to \`${branch}\` — cold start, no baseline yet (seeding below).`);
        } else {
            const siftBin = await resolveSift(core.getInput('sift-binary'), workDir);
            const { report, exitCode } = await runSift({
                siftBin,
                baselineLog: baseline.logPath,
                changedLog,
                baselineLabel: baseline.meta.sha.slice(0, 7),
                changedLabel: pushSha.slice(0, 7),
                failOn,
                outputPath: path.join(workDir, 'report.json'),
            });
            pushGateExit = exitCode;
            pushState = selectState(report);
            summaryBody = renderComment(report, pushContext);
            core.info(`Sift: push to \`${branch}\` — diffed against last-green ${baseline.meta.sha.slice(0, 7)}.`);
        }
        // Report to the job summary — there is no PR comment surface on a push. The body is the same
        // markdown the PR comment uses (the STICKY_MARKER is an inert HTML comment in a summary).
        await core.summary.addRaw(summaryBody).write();
        // Opt-in commit comment (contract § 3): post on the pushed SHA only when the verdict clears the
        // chosen threshold — never on a clean / cold-start run, so the commit timeline can't drown in
        // noise. Upserted per-commit (re-runs don't duplicate). Default `none` = job summary only.
        const commitLevel = readCommitCommentLevel();
        if (shouldCommitComment(pushState, commitLevel)) {
            await tryWrite('post the commit comment (needs contents: write)', () =>
                upsertCommitComment({ octokit, owner, repo, commitSha: pushSha, body: summaryBody }),
            );
            core.info(`Sift: push — commit comment upserted on ${pushSha.slice(0, 7)} (commit-comment: ${commitLevel}).`);
        }
        // Re-seed GREEN-GATED: only a green (or status-unknown) build advances the last-green baseline,
        // so a red push diffs against the prior green but never poisons the baseline.
        if (buildStatus === 'red') {
            core.info('Sift: red build — kept the previous green baseline (did not re-seed).');
        } else {
            await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog));
        }
        // Advisory gate applies on push too — a real trunk CI gate when fail-on is set (no-op for none).
        if (pushGateExit !== 0) {
            core.setFailed(`Sift gate (--fail-on ${failOn}) tripped — see the job summary for what changed.`);
        }
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
        // Resolve the binary only now — cold starts never invoke the engine, so they skip the
        // download (resolve-sift.ts, Argos lane). A push WITH a baseline does invoke it (above).
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

    if (mode === 'render') {
        // Fork build job (contract § 6.1): write the escaped body to
        // $RUNNER_TEMP/sift-comment/; the consumer's upload-artifact step publishes
        // it, and the workflow_run poster posts it. NEVER post from here.
        const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
        const commentDir = path.join(runnerTemp, SIFT_COMMENT_DIR);
        await writeRenderedComment(body, headSha, commentDir);
        core.info(`Sift: render mode — wrote the comment body to ${commentDir} (the workflow uploads it).`);
    } else {
        await tryWrite('post the PR comment', () =>
            upsertStickyComment({ octokit, owner, repo, prNumber, body }),
        );
    }
    // Every run seeds future baselines — including this PR's own follow-up pushes.
    await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog));

    // Advisory gate (contract § 8): the exit/check carries the verdict; the COMMENT
    // never says "we blocked your merge". NOT applied in `render` mode — failing the
    // build job there would skip the consumer's artifact-upload step (no `if:
    // always()`), losing the very regression comment we just rendered. On the fork
    // path the verdict lives in the posted comment (state ④), not a build failure.
    if (mode !== 'render' && gateExit !== 0) {
        core.setFailed(`Sift gate (--fail-on ${failOn}) tripped — see the PR comment for what changed.`);
    }
}

run().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
});
