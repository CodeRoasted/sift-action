// The `post`-mode poster (sift_action_contract.md § 6.1, job 2) — the privileged
// half of the credential-free fork-comment topology. main.ts dispatches to
// runPoster() when `mode: post`; this module is side-effect-free at import so its
// security predicates are unit-testable.
//
// The poster runs with a WRITE token but RUNS NO ENGINE and PARSES NO LOG: it
// downloads the already-escaped comment body that the UNPRIVILEGED fork build job
// rendered (`render` mode, main.ts), re-derives `pr_number` from the TRUSTED
// `workflow_run` head_sha (never a fork-supplied value), and upserts the sticky
// comment. The Gate-B escaping is the trust boundary — the body is inert; the
// poster only moves a text blob to a GitHub-provided PR number.
//
// Perimeter (contract § 6.1): the poster must (a) confirm the triggering run is
// the expected build workflow on a PR; (b) resolve pr_number via the event
// head_sha (API), never a fork-written number; (c) bound the artifact size.

import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { downloadRenderedComment } from './artifact';
import { upsertStickyComment } from './comment';

type Octokit = ReturnType<typeof github.getOctokit>;

// The subset of the workflow_run event payload the poster trusts (GitHub-provided).
export interface WorkflowRunPayload {
    id: number;
    head_sha: string;
    event: string;
    name?: string;
    path?: string;
}

function readWorkflowRun(): WorkflowRunPayload | null {
    const wr = github.context.payload.workflow_run as WorkflowRunPayload | undefined;
    return wr ?? null;
}

// A pull request as returned by listPullRequestsAssociatedWithCommit — the minimal
// shape selectPrNumber reads (octokit's richer type is structurally assignable).
export interface AssociatedPr {
    number: number;
    state: string;
    head: { sha: string };
}

// (b, pure) Choose pr_number from the PRs associated with the TRUSTED head_sha:
// prefer an OPEN PR whose head is exactly this sha, else any PR with that head.
// Never keyed on a fork-uploaded number — only on the GitHub-provided head_sha.
export function selectPrNumber(prs: AssociatedPr[], headSha: string): number | null {
    const exact =
        prs.find((pr) => pr.head.sha === headSha && pr.state === 'open') ??
        prs.find((pr) => pr.head.sha === headSha);
    return exact?.number ?? null;
}

// (a) Confirm the triggering run is the EXPECTED build workflow on a PR. The
// event check is mandatory (only fork `pull_request` builds feed this path); the
// workflow-identity check is applied when `build-workflow` is configured and
// warns when it is not (a weaker perimeter — the consumer template should set it).
export function triggeringRunIsTrusted(wr: WorkflowRunPayload, expectedWorkflow: string): boolean {
    if (wr.event !== 'pull_request') {
        core.info(`Sift poster: triggering run event is "${wr.event}", not pull_request — skipping.`);
        return false;
    }
    if (!expectedWorkflow) {
        // The consumer's `workflow_run.workflows: [...]` trigger filter already
        // pins the upstream workflow identity (examples/fork-safe/post.yml); the
        // optional `build-workflow` input is belt-and-suspenders on top of it.
        core.info(
            'Sift poster: no `build-workflow` input — relying on the workflow_run trigger filter ' +
                'for workflow identity. Set `build-workflow` for an in-code double-check.',
        );
        return true;
    }
    const fileName = wr.path?.split('/').pop();
    const matches = wr.name === expectedWorkflow || fileName === expectedWorkflow || wr.path === expectedWorkflow;
    if (!matches) {
        core.info(
            `Sift poster: triggering workflow "${wr.name ?? wr.path ?? '?'}" is not the expected ` +
                `"${expectedWorkflow}" — skipping.`,
        );
        return false;
    }
    return true;
}

// (b) Resolve pr_number from the TRUSTED event head_sha via the PRs API — never a
// fork-uploaded number.
async function resolvePrNumber(
    octokit: Octokit,
    owner: string,
    repo: string,
    headSha: string,
): Promise<number | null> {
    const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: headSha,
    });
    return selectPrNumber(data, headSha);
}

export async function runPoster(): Promise<void> {
    const token = core.getInput('github-token', { required: true });
    const expectedWorkflow = core.getInput('build-workflow');
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const wr = readWorkflowRun();
    if (!wr) {
        core.setFailed('Sift `mode: post` must run on a `workflow_run` event.');
        return;
    }
    if (!triggeringRunIsTrusted(wr, expectedWorkflow)) {
        return;
    }

    const headSha = wr.head_sha; // GitHub-provided, trusted
    // The triggering run whose artifact we read. The consumer passes
    // `run-id: ${{ github.event.workflow_run.id }}` (trusted); fall back to the
    // event payload's id if the input is omitted.
    const runIdInput = core.getInput('run-id');
    const workflowRunId = runIdInput ? Number(runIdInput) : wr.id;
    if (!Number.isInteger(workflowRunId) || workflowRunId <= 0) {
        core.setFailed(`Sift poster: invalid run-id "${runIdInput}".`);
        return;
    }

    // (c) Download the rendered body off the triggering run (size-bounded).
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-poster-'));
    const rendered = await downloadRenderedComment({
        token,
        owner,
        repo,
        workflowRunId,
        destDir,
    });
    if (!rendered) {
        return; // absent / oversize / digest mismatch — already logged
    }

    // Honour the render-side pr-comment verdict: the unprivileged build job already decided whether
    // this result clears the threshold (contract § 3). Below it ⇒ post nothing — the diff still lives
    // in the build run's job summary + outputs.
    if (!rendered.shouldPost) {
        core.info(
            'Sift poster: render verdict is below the pr-comment threshold — nothing to post.',
        );
        return;
    }

    // Defence in depth: the body's stamped head_sha must agree with the trusted
    // event head_sha. A mismatch means a confused or forged artifact — refuse.
    if (rendered.headSha !== headSha) {
        core.warning(
            `Sift poster: artifact head_sha (${rendered.headSha}) disagrees with the workflow_run ` +
                `event (${headSha}) — refusing to post.`,
        );
        return;
    }

    const prNumber = await resolvePrNumber(octokit, owner, repo, headSha);
    if (prNumber === null) {
        core.info(`Sift poster: no PR found for ${headSha} — nothing to post.`);
        return;
    }

    const id = await upsertStickyComment({ octokit, owner, repo, prNumber, body: rendered.body });
    core.info(`Sift poster: upserted sticky comment ${id} on PR #${prNumber}.`);
}
