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

import { buildAnnotationCommands } from './annotations.js';
import { parseBaselineSpec, resolveBaseline, type BaselineSpec } from './baseline.js';
import { upsertStickyComment, upsertCommitComment } from './comment.js';
import { publishBaselineLog, writeRenderedComment } from './artifact.js';
import { renderComment } from './frame.js';
import { runPoster } from './poster.js';
import { resolveSift } from './resolve-sift.js';
import { runSift, runExplainSetup, type FailOn } from './sift.js';
import { selectState, shouldComment, State, type CommentLevel } from './verdict.js';
import {
    BASELINE_ARTIFACT_NAME,
    CONTEXT_VERSION,
    SIFT_COMMENT_DIR,
    type BuildStatus,
    type SiftCommentContext,
    type SiftReport,
} from './types.js';

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

// When (whether) this run PUBLISHES its log as the next baseline (the
// `create_baseline` half of "user King of the baseline"):
//   auto (default) — PRs always seed; pushes are GREEN-GATED (a red build never
//                    overwrites the last-green baseline — it still diffs against
//                    the prior green).
//   always | never — the explicit overrides.
type PublishMode = 'auto' | 'always' | 'never';
function readPublishMode(): PublishMode {
    const raw = (core.getInput('publish-baseline') || 'auto').toLowerCase();
    return raw === 'always' || raw === 'never' ? raw : 'auto';
}

// The human label of a non-default configured source, for the cold-start copy
// ("Sift diffs each run against <source>"). Undefined for auto — the frame's
// default base-branch copy stays.
function baselineSourceLabel(spec: BaselineSpec): string | undefined {
    switch (spec.kind) {
        case 'branch':
            return `the last green run on \`${spec.branch}\``;
        case 'artifact':
            return `the \`${spec.name}\` baseline artifact`;
        case 'path':
            return `the local baseline file \`${spec.file}\``;
        default:
            return undefined;
    }
}

// Opt-in `--explain` provisioning (adr/0009 §6.2). Runs the engine's idempotent `explain-setup`:
// download + SHA-256-verify the pinned model + inference server from the public CodeRoasted/sift-explain-model HF
// repo (NO credential — anonymous, fork-safe). Best-effort + fail-soft: a provisioning failure is a
// WARNING, never an Action failure — `sift --explain` then degrades to no-narrative on the non-TTY CI
// run and the deterministic report + gate are unaffected. Cross-run caching of the ~2.4 GB asset dir
// (`${XDG_CACHE_HOME:-~/.cache}/coderoast`) is the caller's one-line `actions/cache` step — see the
// README explain example. (Deliberately NOT a bundled @actions/cache: it pulls a heavy SDK + extra
// advisories into this fork-reachable Action; the maintained `actions/cache` action is the clean path.)
async function provisionExplain(siftBin: string): Promise<void> {
    if (!(await runExplainSetup(siftBin))) {
        core.warning(
            'explain: model/server provisioning failed; emitting the deterministic report without a narrative.',
        );
    }
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
    const isTagRef = github.context.ref.startsWith('refs/tags/');
    // The contextual branch for `auto` baseline resolution: the PR's base, the pushed
    // branch — or, on a TAG ref (no branch to resolve against), the repo's default
    // branch, so a tag-on-main run diffs against main's last green out of the box.
    const defaultBranch =
        (github.context.payload.repository?.default_branch as string | undefined) ?? 'main';
    const baseBranch = pr
        ? (pr.base.ref as string)
        : isTagRef
          ? defaultBranch
          : github.context.ref.replace(/^refs\/heads\//, '');
    const headSha = pr ? (pr.head.sha as string) : github.context.sha;

    // Baseline selection + publication — the user is King of the baseline. A malformed
    // selector throws here (config error → failed run), never a silent auto fallback.
    const baselineSpec = parseBaselineSpec(core.getInput('baseline'));
    const baselineName = core.getInput('baseline-name') || BASELINE_ARTIFACT_NAME;
    const publishMode = readPublishMode();
    const commentTag = core.getInput('comment-tag') || undefined;

    const baseline = await resolveBaseline({
        octokit,
        owner,
        repo,
        runId: github.context.runId,
        spec: baselineSpec,
        contextBranch: baseBranch,
        artifactName: baselineName,
        workDir,
    });

    const context: SiftCommentContext = {
        context_version: CONTEXT_VERSION,
        head_sha: headSha,
        pr_number: pr ? (pr.number as number) : undefined,
        base_branch: baseBranch,
        build_status: buildStatus,
        baseline: baseline?.meta,
        baseline_source: baselineSourceLabel(baselineSpec),
        comment_tag: commentTag,
    };

    // Diff — or cold start (contract § 3): no baseline ⇒ the engine is NOT invoked.
    let gateExit = 0;
    let report: SiftReport | null = null;
    const reportJsonPath = path.join(workDir, 'report.json');
    if (baseline) {
        const siftBin = await resolveSift(core.getInput('sift-binary'), workDir);
        const explain = core.getBooleanInput('explain');
        const explainModel = core.getInput('explain-model') || undefined;
        if (explain) {
            await provisionExplain(siftBin);
        }
        const result = await runSift({
            siftBin,
            baselineLog: baseline.logPath,
            changedLog,
            baselineLabel: baseline.meta.sha.slice(0, 7),
            changedLabel: headSha.slice(0, 7),
            failOn,
            outputPath: reportJsonPath,
            explain,
            explainModel,
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

    // Expose the deterministic report.json on a STABLE, cross-step path (workDir is an
    // mkdtemp that's gone after this step). A later step on the SAME runner can then
    // narrate it via `sift explain --report` — so the narrative explains THIS run's real
    // diff, not a re-diff against an empty baseline (the §3.6 decoupled-narration seam).
    // §3.6-safe: report.json is exactly the content already in the comment/summary — no
    // credential, no courtesy. Empty `report-path` on cold start (no report produced).
    let reportPathOut = '';
    if (report) {
        reportPathOut = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'sift-report.json');
        await fs.copyFile(reportJsonPath, reportPathOut);
    }
    core.setOutput('report-path', reportPathOut);

    // Inline check-run annotations (contract § B / sift_conversion_surface § B.3): emit the
    // level-gated `::error|warning|notice::` workflow commands on stdout. They carry no write
    // token, so this fires in BOTH the inline `comment` job and the UNPRIVILEGED fork `render`
    // job (mode=post returned at the top — no report), surfacing drift on a fork PR's checks
    // where GitHub's failure-explain is silent. The encode in annotations.ts is the trust
    // boundary; nothing privileged happens here. Own axis (default `significant`): a clean run
    // has no significant rows ⇒ no annotations.
    const annotationsLevel = readCommentLevel('annotations', 'significant');
    for (const command of buildAnnotationCommands(report, annotationsLevel)) {
        process.stdout.write(`${command}\n`);
    }

    // One seeding rule for BOTH modes (the `create_baseline` half): `auto` keeps
    // the proven semantics — PRs always seed, pushes/tags are GREEN-GATED (a red
    // build never overwrites the last-green baseline — it still diffed against
    // the prior green); `always`/`never` are the explicit overrides.
    const shouldSeed =
        publishMode === 'always' ? true : publishMode === 'never' ? false : pr ? true : buildStatus !== 'red';

    if (mode === 'render') {
        // Fork build job (contract § 6.1): write the escaped body for the workflow_run poster; NEVER
        // post or fail the build from here. The fork build is always a PR, so gate on `pr-comment` and
        // STAMP the verdict into the artifact — the poster honours it, so pr-comment controls fork-PR
        // comments exactly like inline ones (no shared floor; render always writes so the upload never
        // errors — the poster simply skips when the flag is false).
        const shouldPost = shouldComment(state, prComment);
        const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
        const commentDir = path.join(runnerTemp, SIFT_COMMENT_DIR);
        await writeRenderedComment(body, headSha, commentDir, shouldPost);
        core.info(`Sift: render mode — wrote the comment body (pr-comment=${prComment} ⇒ post=${shouldPost}); the workflow uploads it.`);
        if (shouldSeed) {
            await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog, baselineName));
        } else {
            core.info(`Sift: publish-baseline=${publishMode}${buildStatus === 'red' ? ' (red build)' : ''} — did not re-seed \`${baselineName}\`.`);
        }
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

    // Seed the next baseline under `baseline-name` (rule computed above).
    if (shouldSeed) {
        await tryWrite('publish the baseline artifact', () => publishBaselineLog(changedLog, baselineName));
    } else {
        core.info(`Sift: publish-baseline=${publishMode}${buildStatus === 'red' ? ' (red build)' : ''} — kept the previous \`${baselineName}\` baseline (did not re-seed).`);
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
