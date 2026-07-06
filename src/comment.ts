// Sticky comment transport (sift_action_contract.md § 4). ONE comment per PR
// (per comment-tag), updated in place: list the PR's comments, find the one
// carrying the hidden marker, PATCH it — else POST a new one. Never one comment
// per push.

import type { getOctokit } from '@actions/github';
import { STICKY_MARKER } from './frame.js';

type Octokit = ReturnType<typeof getOctokit>;

// The body's own first-line marker is the upsert key. renderComment always leads
// with it — tagged (`<!-- sift:pr-comment:vs-prev -->`) or not — so both the
// inline path and the fork-artifact poster (which receives a pre-rendered body)
// patch exactly the comment this body belongs to, tag included, with no extra
// plumbing. `includes` stays exact: the ` -->` / `:tag -->` suffixes make no
// marker a substring of another.
function markerOf(body: string): string {
    const match = body.match(/^<!-- sift:pr-comment[^>]*? -->/);
    return match ? match[0] : STICKY_MARKER;
}

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
    const marker = markerOf(body);
    const mine = existing.find((comment) => (comment.body ?? '').includes(marker));
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
    const marker = markerOf(body);
    const mine = existing.find((comment) => (comment.body ?? '').includes(marker));
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
