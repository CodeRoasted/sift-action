// Sticky comment transport (sift_action_contract.md § 4). ONE comment per PR,
// updated in place: list the PR's comments, find the one carrying the hidden
// marker, PATCH it — else POST a new one. Never one comment per push.

import type { getOctokit } from '@actions/github';
import { STICKY_MARKER } from './frame';

type Octokit = ReturnType<typeof getOctokit>;

export interface UpsertParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
}

// Returns the comment id written (for logging). PR comments are issue comments.
export async function upsertStickyComment(params: UpsertParams): Promise<number> {
    const { octokit, owner, repo, prNumber, body } = params;
    const existing = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
    });
    const mine = existing.find((comment) => (comment.body ?? '').includes(STICKY_MARKER));
    if (mine) {
        await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
        return mine.id;
    }
    const created = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
    });
    return created.data.id;
}

export interface UpsertCommitParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    commitSha: string;
    body: string;
}

// Push mode (contract § 3): ONE comment per COMMIT, updated in place — same sticky
// discipline as the PR path, so a re-run of the same commit never duplicates. Commit
// comments live under the Contents permission; the caller wraps this in tryWrite so a
// missing `contents: write` degrades to a warning, not a failed build.
export async function upsertCommitComment(params: UpsertCommitParams): Promise<number> {
    const { octokit, owner, repo, commitSha, body } = params;
    const existing = await octokit.paginate(octokit.rest.repos.listCommentsForCommit, {
        owner,
        repo,
        commit_sha: commitSha,
        per_page: 100,
    });
    const mine = existing.find((comment) => (comment.body ?? '').includes(STICKY_MARKER));
    if (mine) {
        await octokit.rest.repos.updateCommitComment({ owner, repo, comment_id: mine.id, body });
        return mine.id;
    }
    const created = await octokit.rest.repos.createCommitComment({
        owner,
        repo,
        commit_sha: commitSha,
        body,
    });
    return created.data.id;
}
