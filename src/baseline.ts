// Turnkey baseline resolution (sift_action_contract.md § 3). Zero-config for
// baseline SELECTION: ask the GitHub API for the latest `success` run of THIS
// workflow on the PR's base branch, pull its `sift-baseline-log` artifact — that
// is baseline.log. No such run/artifact ⇒ honest cold start (return null).

import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import * as path from 'path';
import { BASELINE_ARTIFACT_NAME, type BaselineProvenance } from './types';

type Octokit = ReturnType<typeof getOctokit>;

export interface ResolvedBaseline {
    logPath: string;
    meta: BaselineProvenance;
}

export interface ResolveParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    runId: number; // this run, to discover this workflow's id
    baseBranch: string;
    workDir: string;
}

export async function resolveBaseline(params: ResolveParams): Promise<ResolvedBaseline | null> {
    const { octokit, owner, repo, runId, baseBranch, workDir } = params;

    // Resolve the last green run of THE SAME workflow (not just any workflow) on
    // the base branch — so a PR diffs against its own pipeline's last green run.
    const thisRun = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
    const workflowId = thisRun.data.workflow_id;

    const runs = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowId,
        branch: baseBranch,
        status: 'success',
        per_page: 1,
    });
    const baseRun = runs.data.workflow_runs[0];
    if (!baseRun) {
        core.info(`Sift: no green run of this workflow on \`${baseBranch}\` yet — cold start.`);
        return null;
    }

    const artifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: baseRun.id,
        per_page: 100,
    });
    const artifact = artifacts.data.artifacts.find(
        (candidate) => candidate.name === BASELINE_ARTIFACT_NAME && !candidate.expired,
    );
    if (!artifact) {
        core.info(
            `Sift: green base run ${baseRun.id} has no live \`${BASELINE_ARTIFACT_NAME}\` artifact ` +
                `(first adoption, or aged past retention) — cold start.`,
        );
        return null;
    }

    const download = await octokit.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifact.id,
        archive_format: 'zip',
    });
    const zip = new AdmZip(Buffer.from(download.data as ArrayBuffer));
    const entry = zip.getEntries().find((candidate) => !candidate.isDirectory);
    if (!entry) {
        core.warning(
            `Sift: \`${BASELINE_ARTIFACT_NAME}\` artifact ${artifact.id} is empty — cold start.`,
        );
        return null;
    }

    const logPath = path.join(workDir, 'baseline.log');
    await fs.writeFile(logPath, entry.getData());

    const meta: BaselineProvenance = {
        sha: baseRun.head_sha,
        run_id: String(baseRun.id),
        run_url: baseRun.html_url,
        branch: baseBranch,
        created_at: baseRun.created_at,
    };
    return { logPath, meta };
}
