// Baseline resolution (bibles/sift_action.md § 3) — the user is King of the
// baseline. The `baseline` input selects the source; the default (`auto`) stays
// the turnkey zero-config behavior: the latest `success` run of THIS workflow on
// the PR's base branch (push: the pushed branch; tag: the repo default branch),
// pulling its baseline-log artifact. No source ⇒ honest cold start (null).
//
// Grammar (the `baseline` input):
//   auto                — last green same-workflow run on the contextual branch
//                         (PR base / pushed branch / default branch for tag refs).
//   branch=<name>       — same resolver, explicit branch.
//   artifact=<name>     — newest non-expired artifact with that exact name,
//                         repo-wide. Decouples the baseline from "this workflow
//                         ran on that branch": named baselines (a main-seeded
//                         `sift-baseline-main-build`, a per-PR
//                         `sift-baseline-build-pr-123`) resolve from ANY event —
//                         tags and PRs included.
//   path=<file>         — a local file (self-hosted / bring-your-own baseline).
//   none                — forced cold start (seed-only runs).

import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
    BASELINE_META_FILE,
    MAX_BASELINE_ARTIFACT_BYTES,
    MAX_BASELINE_UNPACKED_BYTES,
    type BaselineMeta,
    type BaselineProvenance,
} from './types.js';

type Octokit = ReturnType<typeof getOctokit>;

export type BaselineSpec =
    | { kind: 'auto' }
    | { kind: 'none' }
    | { kind: 'branch'; branch: string }
    | { kind: 'artifact'; name: string }
    | { kind: 'path'; file: string };

// A malformed selector is a CONFIG error — fail loud at parse time, never a
// silent fallback to auto (the caller `core.setFailed`s on the throw). Distinct
// from the API-error degrade below, which protects fork PRs' read-only tokens.
export function parseBaselineSpec(raw: string): BaselineSpec {
    const value = (raw || 'auto').trim();
    if (value === 'auto') return { kind: 'auto' };
    if (value === 'none') return { kind: 'none' };
    const eq = value.indexOf('=');
    if (eq > 0) {
        const key = value.slice(0, eq).trim();
        const arg = value.slice(eq + 1).trim();
        if (arg) {
            if (key === 'branch') return { kind: 'branch', branch: arg };
            if (key === 'artifact') return { kind: 'artifact', name: arg };
            if (key === 'path') return { kind: 'path', file: arg };
        }
    }
    throw new Error(
        `invalid \`baseline\` input "${raw}" — expected auto | none | branch=<name> | ` +
            `artifact=<name> | path=<file>`,
    );
}

// The `baseline-max-age` grammar: `<n>h` | `<n>d` (hours | days), n a positive
// integer. Empty ⇒ no bound (null). Malformed is a CONFIG error — fail loud at
// parse time, same posture as parseBaselineSpec, never a silent "unbounded".
export function parseMaxAgeHours(raw: string): number | null {
    const value = (raw || '').trim().toLowerCase();
    if (!value) return null;
    const match = /^(\d+)(h|d)$/.exec(value);
    if (!match) {
        throw new Error(
            `invalid \`baseline-max-age\` input "${raw}" — expected <n>h or <n>d (e.g. 72h, 7d), ` +
                'or empty for no bound',
        );
    }
    const amount = Number(match[1]);
    if (amount <= 0) {
        throw new Error(`invalid \`baseline-max-age\` input "${raw}" — the bound must be positive`);
    }
    return match[2] === 'd' ? amount * 24 : amount;
}

// Whole hours between the baseline's created_at stamp and `nowMs`, floored; null
// when the stamp is absent/unparseable (a `path=` baseline, a pre-sidecar
// artifact) — an UNKNOWN age is reported as unknown, never coerced to 0 (which
// would read as "fresh", the exact silent degradation this exists to kill).
export function baselineAgeHours(createdAt: string, nowMs: number): number | null {
    if (!createdAt) return null;
    const stamp = Date.parse(createdAt);
    if (Number.isNaN(stamp)) return null;
    const deltaMs = nowMs - stamp;
    if (deltaMs < 0) return 0; // clock skew between GitHub and the runner — clamp, don't go negative
    return Math.floor(deltaMs / (60 * 60 * 1000));
}

export interface ResolvedBaseline {
    logPath: string;
    meta: BaselineProvenance;
    /**
     * The baseline run's native CI verdict token, read from the artifact's stamped
     * sidecar (ADR 0025 §3.1) — forwarded verbatim as `--baseline-outcome`. Empty when
     * the sidecar is absent (a `path=` baseline, or an artifact stamped before the
     * sidecar existed): the engine's ladder then falls to the console tail → Unknown.
     */
    outcomeToken: string;
}

export interface ResolveParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    runId: number; // this run, to discover this workflow's id (and to never self-resolve)
    spec: BaselineSpec;
    /** Branch for `auto`: PR base / pushed branch / default branch on tag refs. */
    contextBranch: string;
    /** Artifact name the branch-run resolvers look for (= what this pipeline publishes). */
    artifactName: string;
    workDir: string;
}

export async function resolveBaseline(params: ResolveParams): Promise<ResolvedBaseline | null> {
    if (params.spec.kind === 'none') {
        core.info('Sift: baseline=none — forced cold start (seed-only run).');
        return null;
    }
    if (params.spec.kind === 'path') {
        // An explicit local file is a hard contract: missing/unreadable is a config
        // error, not a cold start — the user pointed at it deliberately.
        const logPath = path.join(params.workDir, 'baseline.log');
        await fs.copyFile(params.spec.file, logPath);
        return {
            logPath,
            meta: {
                kind: 'path',
                sha: '',
                run_id: '',
                run_url: '',
                branch: '',
                created_at: '',
                label: params.spec.file,
            },
            outcomeToken: '', // no provenance sidecar for a local file — console tail / Unknown
        };
    }
    // Remote resolution is ADVISORY (contract § 3, § 6 fork posture). A fork PR gets a
    // READ-ONLY token that 403s on the runs/artifacts API, and any transient API/transport
    // error must degrade to an honest cold start — NEVER fail the render/comment job (which
    // would turn a green PR red). The diff is an enhancement; its absence is a cold start,
    // not an error. The strict resolver below throws on such errors; we swallow them here.
    try {
        return await resolveRemoteStrict(params);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        core.warning(
            `Sift: baseline lookup failed (${reason}) — proceeding cold start (current log only, ` +
                `no diff). On a fork PR this is expected: the read-only token cannot read the ` +
                `repo's run/artifact history.`,
        );
        return null;
    }
}

// Strict resolution: THROWS on an API/transport error (the caller degrades to cold start).
// Returns null for the legitimately-empty cases (no green base run, no/expired/empty baseline
// artifact) — those are normal cold starts, distinct from an error.
async function resolveRemoteStrict(params: ResolveParams): Promise<ResolvedBaseline | null> {
    const { octokit, owner, repo, runId, spec, contextBranch, artifactName, workDir } = params;

    if (spec.kind === 'artifact') {
        // Named baseline: newest non-expired artifact with that exact name, repo-wide,
        // never one this very run published (re-run safety).
        const listed = await octokit.rest.actions.listArtifactsForRepo({
            owner,
            repo,
            name: spec.name,
            per_page: 20,
        });
        const artifact = listed.data.artifacts.find(
            (candidate) => !candidate.expired && candidate.workflow_run?.id !== runId,
        );
        if (!artifact) {
            core.info(`Sift: no live \`${spec.name}\` baseline artifact in the repo yet — cold start.`);
            return null;
        }
        const producerRun = artifact.workflow_run;
        const meta: BaselineProvenance = {
            kind: 'artifact',
            sha: producerRun?.head_sha ?? '',
            run_id: producerRun ? String(producerRun.id) : '',
            run_url: producerRun
                ? `https://github.com/${owner}/${repo}/actions/runs/${producerRun.id}`
                : '',
            branch: producerRun?.head_branch ?? '',
            created_at: artifact.created_at ?? '',
            label: spec.name,
        };
        return {
        ...(await extractBaseline(octokit, owner, repo, artifact.id, workDir, artifact.size_in_bytes)),
        meta,
    };
    }

    // Branch-run resolution (auto / branch=<name>): the last green run of THE SAME
    // workflow (not just any workflow) on the branch — a PR diffs against its own
    // pipeline's last green run.
    const branch = spec.kind === 'branch' ? spec.branch : contextBranch;
    const thisRun = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
    const workflowId = thisRun.data.workflow_id;

    const runs = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowId,
        branch,
        status: 'success',
        per_page: 1,
    });
    const baseRun = runs.data.workflow_runs[0];
    if (!baseRun) {
        core.info(`Sift: no green run of this workflow on \`${branch}\` yet — cold start.`);
        return null;
    }

    const artifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: baseRun.id,
        per_page: 100,
    });
    const artifact = artifacts.data.artifacts.find(
        (candidate) => candidate.name === artifactName && !candidate.expired,
    );
    if (!artifact) {
        core.info(
            `Sift: green base run ${baseRun.id} has no live \`${artifactName}\` artifact ` +
                `(first adoption, or aged past retention) — cold start.`,
        );
        return null;
    }

    const meta: BaselineProvenance = {
        kind: 'run',
        sha: baseRun.head_sha,
        run_id: String(baseRun.id),
        run_url: baseRun.html_url,
        branch,
        created_at: baseRun.created_at,
    };
    return {
        ...(await extractBaseline(octokit, owner, repo, artifact.id, workDir, artifact.size_in_bytes)),
        meta,
    };
}

// Extracts the baseline LOG plus the stamped provenance sidecar. The log entry is
// "the one file that is not the sidecar" — the artifact carries exactly the log and
// (since the sidecar was introduced) BASELINE_META_FILE. A sidecar-less artifact
// resolves with an empty token: the engine ladder's honest absence rung.
async function extractBaseline(
    octokit: Octokit,
    owner: string,
    repo: string,
    artifactId: number,
    workDir: string,
    artifactSize: number | undefined,
): Promise<{ logPath: string; outcomeToken: string }> {
    // BOUND 1 — pre-download, on the METADATA, so oversized bytes never transfer. Mirrors the
    // poster's pre-download gate rather than inventing a second shape.
    if (artifactSize !== undefined && artifactSize > MAX_BASELINE_ARTIFACT_BYTES) {
        throw new Error(
            `baseline artifact ${artifactId} is ${artifactSize}B compressed, over the ` +
                `${MAX_BASELINE_ARTIFACT_BYTES}B cap — refusing to download`,
        );
    }

    const download = await octokit.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifactId,
        archive_format: 'zip',
    });

    // BOUND 2 — on the BYTES WE ACTUALLY GOT, before the parser sees them. Not redundant with
    // bound 1: `size` is absent on some listings, and this is the gate that stands between a
    // crafted archive and the allocation the advisory describes, which happens DURING parsing.
    const raw = Buffer.from(download.data as ArrayBuffer);
    if (raw.byteLength > MAX_BASELINE_ARTIFACT_BYTES) {
        throw new Error(
            `baseline artifact ${artifactId} downloaded ${raw.byteLength}B compressed, over the ` +
                `${MAX_BASELINE_ARTIFACT_BYTES}B cap — refusing to parse`,
        );
    }

    const zip = new AdmZip(raw);
    const files = zip.getEntries().filter((candidate) => !candidate.isDirectory);

    // BOUND 3 — on the DECLARED UNPACKED TOTAL, before any `getData()` expands anything. The
    // hazard is expansion ratio, so a compressed cap alone does not cover it: a small archive
    // may declare an enormous unpacked size.
    const unpacked = files.reduce((sum, candidate) => sum + (candidate.header?.size ?? 0), 0);
    if (unpacked > MAX_BASELINE_UNPACKED_BYTES) {
        throw new Error(
            `baseline artifact ${artifactId} declares ${unpacked}B unpacked across ${files.length} ` +
                `entries, over the ${MAX_BASELINE_UNPACKED_BYTES}B cap — refusing to extract`,
        );
    }
    const logEntry = files.find((candidate) => path.basename(candidate.entryName) !== BASELINE_META_FILE);
    if (!logEntry) {
        throw new Error(`baseline artifact ${artifactId} carries no log file`);
    }
    const logPath = path.join(workDir, 'baseline.log');
    await fs.writeFile(logPath, logEntry.getData());

    let outcomeToken = '';
    const metaEntry = files.find((candidate) => path.basename(candidate.entryName) === BASELINE_META_FILE);
    if (metaEntry) {
        try {
            const meta = JSON.parse(metaEntry.getData().toString('utf8')) as BaselineMeta;
            outcomeToken = typeof meta.outcome_token === 'string' ? meta.outcome_token : '';
        } catch {
            core.warning(
                `Sift: baseline artifact ${artifactId} has an unreadable ${BASELINE_META_FILE} — ` +
                    'proceeding without a baseline verdict (console tail / Unknown).',
            );
        }
    }
    return { logPath, outcomeToken };
}
