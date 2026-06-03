// Artifact transport:
//   • publishBaselineLog       — self-publishing the baseline (contract § 3, step 6),
//                                via @actions/artifact's runtime-token path.
//   • writeRenderedComment     — `render` mode: write the escaped comment body + meta
//                                into $RUNNER_TEMP/sift-comment/. The CONSUMER's
//                                workflow uploads that dir (actions/upload-artifact),
//                                so the unprivileged build job needs no API write.
//   • downloadRenderedComment  — `post` mode: pull that body off the TRIGGERING run
//                                via `findBy` (cross-run REST), size-bounded.

import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
    BASELINE_ARTIFACT_NAME,
    CONTEXT_VERSION,
    MAX_RENDERED_ARTIFACT_BYTES,
    MAX_RENDERED_BODY_BYTES,
    RENDERED_BODY_FILE,
    RENDERED_META_FILE,
    SIFT_COMMENT_ARTIFACT_NAME,
    type RenderedCommentMeta,
} from './types';

// GitHub's default artifact retention (90d) bounds baseline availability; older
// base runs fall back to cold start (contract § 3, "Retention caveat").
const RETENTION_DAYS = 90;

export async function publishBaselineLog(logPath: string): Promise<void> {
    const client = new DefaultArtifactClient();
    await client.uploadArtifact(BASELINE_ARTIFACT_NAME, [logPath], path.dirname(logPath), {
        retentionDays: RETENTION_DAYS,
    });
}

// ── render → post cross-boundary body (contract § 6.1) ───────────────────────

// `render` mode: write the already-escaped comment body + its head_sha provenance
// into `dir` (= $RUNNER_TEMP/sift-comment/). The action does NOT upload — the
// consumer's `actions/upload-artifact@v4` step publishes the dir as the
// `sift-comment` artifact (examples/fork-safe/build.yml), keeping the unprivileged
// build job free of any GitHub write.
export async function writeRenderedComment(
    body: string,
    headSha: string,
    dir: string,
    shouldPost: boolean,
): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const meta: RenderedCommentMeta = {
        context_version: CONTEXT_VERSION,
        head_sha: headSha,
        should_post: shouldPost,
    };
    await fs.writeFile(path.join(dir, RENDERED_BODY_FILE), body, 'utf8');
    await fs.writeFile(path.join(dir, RENDERED_META_FILE), JSON.stringify(meta), 'utf8');
}

export interface RenderedComment {
    body: string;
    headSha: string;
    shouldPost: boolean; // the render-side pr-comment verdict (absent in the meta ⇒ true, back-compat)
}

export interface DownloadRenderedParams {
    token: string; // needs actions:read (the privileged poster has it)
    owner: string;
    repo: string;
    workflowRunId: number; // the TRIGGERING run (github.event.workflow_run.id)
    destDir: string;
}

// Poster side: pull the rendered-body artifact off the TRIGGERING run via
// @actions/artifact `findBy` (cross-run REST). Bounds the size BEFORE downloading
// (gate on the metadata `size`), then again on the inflated body, and verifies the
// artifact digest. Returns the inert body + its stamped head_sha, or null (with a
// warning) on absence / oversize / digest mismatch — the poster then posts
// nothing. Runs no engine, parses no log.
export async function downloadRenderedComment(
    params: DownloadRenderedParams,
): Promise<RenderedComment | null> {
    const { token, owner, repo, workflowRunId, destDir } = params;
    const client = new DefaultArtifactClient();
    const findBy = {
        token,
        workflowRunId,
        repositoryOwner: owner,
        repositoryName: repo,
    };

    let artifact: { id: number; size?: number; digest?: string };
    try {
        ({ artifact } = await client.getArtifact(SIFT_COMMENT_ARTIFACT_NAME, { findBy }));
    } catch {
        core.info(
            `Sift poster: no "${SIFT_COMMENT_ARTIFACT_NAME}" artifact on run ${workflowRunId} — nothing to post.`,
        );
        return null;
    }

    // Pre-download bound: refuse on the metadata size, before any bytes transfer.
    if (artifact.size !== undefined && artifact.size > MAX_RENDERED_ARTIFACT_BYTES) {
        core.warning(
            `Sift poster: rendered artifact is ${artifact.size}B (compressed), over the ` +
                `${MAX_RENDERED_ARTIFACT_BYTES}B cap — refusing to download.`,
        );
        return null;
    }

    const { digestMismatch } = await client.downloadArtifact(artifact.id, {
        path: destDir,
        expectedHash: artifact.digest,
        findBy,
    });
    if (digestMismatch) {
        core.warning('Sift poster: rendered artifact digest mismatch — refusing to post.');
        return null;
    }

    const body = await fs.readFile(path.join(destDir, RENDERED_BODY_FILE), 'utf8');
    // Post-inflate bound: a body over GitHub's comment limit could not post anyway.
    if (Buffer.byteLength(body, 'utf8') > MAX_RENDERED_BODY_BYTES) {
        core.warning(
            `Sift poster: rendered body exceeds GitHub's ${MAX_RENDERED_BODY_BYTES}-char ` +
                'comment limit — refusing to post.',
        );
        return null;
    }
    const meta = JSON.parse(
        await fs.readFile(path.join(destDir, RENDERED_META_FILE), 'utf8'),
    ) as RenderedCommentMeta;
    return { body, headSha: meta.head_sha, shouldPost: meta.should_post ?? true };
}
