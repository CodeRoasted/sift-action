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
