// Self-publishing the baseline (sift_action_contract.md § 3, step 6). EVERY run
// uploads the log it ingested as the `sift-baseline-log` artifact — esp.
// base-branch pushes, which seed the baseline future PRs resolve against
// (self-bootstrapping: the first green base run after adoption goes live).

import { DefaultArtifactClient } from '@actions/artifact';
import * as path from 'path';
import { BASELINE_ARTIFACT_NAME } from './types';

// GitHub's default artifact retention (90d) bounds baseline availability; older
// base runs fall back to cold start (contract § 3, "Retention caveat").
const RETENTION_DAYS = 90;

export async function publishBaselineLog(logPath: string): Promise<void> {
    const client = new DefaultArtifactClient();
    await client.uploadArtifact(BASELINE_ARTIFACT_NAME, [logPath], path.dirname(logPath), {
        retentionDays: RETENTION_DAYS,
    });
}
