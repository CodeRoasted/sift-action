// Baseline resolution must DEGRADE to a cold start (return null), never throw, when
// the GitHub runs/artifacts API errors. A fork PR gets a READ-ONLY token that 403s on
// these calls (contract § 6); the README promises graceful degradation, so these tests
// hold the code to it — otherwise an unwrapped throw reddens the render/comment job on
// every fork PR instead of falling back to an honest cold start.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBaseline, type ResolveParams } from '../src/baseline.js';

function params(octokit: unknown, over: Partial<ResolveParams> = {}): ResolveParams {
    return {
        octokit: octokit as ResolveParams['octokit'],
        owner: 'CodeRoasted',
        repo: 'insight-canon',
        runId: 1,
        spec: { kind: 'auto' },
        contextBranch: 'main',
        artifactName: 'sift-baseline-log',
        workDir: '/tmp',
        ...over,
    };
}

// Calls that must NOT be reached once an earlier call has failed.
const unreached = (): never => {
    throw new Error('resolveBaseline kept calling the API after an earlier failure');
};

test('a 403 on the first API call degrades to cold start (null), never throws', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => {
                    throw new Error('HttpError: Resource not accessible by integration (403)');
                },
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit)), null);
});

test('a 403 mid-resolution (runs list) also degrades to cold start, never throws', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 42 } }),
                listWorkflowRuns: async () => {
                    throw new Error('HttpError: 403');
                },
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit)), null);
});

test('no green base run is a normal cold start (null), distinct from an error', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 42 } }),
                listWorkflowRuns: async () => ({ data: { workflow_runs: [] } }),
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit)), null);
});

// ── Baseline selection grammar + the new sources (user King of the baseline) ─

import { parseBaselineSpec } from '../src/baseline.js';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

test('parseBaselineSpec: the full grammar parses; malformed input THROWS (config error)', () => {
    assert.deepEqual(parseBaselineSpec(''), { kind: 'auto' });
    assert.deepEqual(parseBaselineSpec('auto'), { kind: 'auto' });
    assert.deepEqual(parseBaselineSpec('none'), { kind: 'none' });
    assert.deepEqual(parseBaselineSpec('branch=develop'), { kind: 'branch', branch: 'develop' });
    assert.deepEqual(parseBaselineSpec('artifact=sift-baseline-main-build'), {
        kind: 'artifact',
        name: 'sift-baseline-main-build',
    });
    assert.deepEqual(parseBaselineSpec('path=/tmp/base.log'), { kind: 'path', file: '/tmp/base.log' });
    assert.throws(() => parseBaselineSpec('previous-run'));
    assert.throws(() => parseBaselineSpec('artifact='));
    assert.throws(() => parseBaselineSpec('bogus=x'));
});

test('baseline=none: forced cold start, NO API call', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: unreached,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(await resolveBaseline(params(octokit, { spec: { kind: 'none' } })), null);
});

test('branch=<name>: the run resolver targets the EXPLICIT branch, not the contextual one', async () => {
    let asked = '';
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: async () => ({ data: { workflow_id: 42 } }),
                listWorkflowRuns: async (args: { branch: string }) => {
                    asked = args.branch;
                    return { data: { workflow_runs: [] } };
                },
                listWorkflowRunArtifacts: unreached,
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(
        await resolveBaseline(params(octokit, { spec: { kind: 'branch', branch: 'release' } })),
        null,
    );
    assert.equal(asked, 'release');
});

// A named-baseline zip the artifact source can inflate.
function baselineZip(content: string): { data: ArrayBuffer } {
    const zip = new AdmZip();
    zip.addFile('baseline.log', Buffer.from(content, 'utf8'));
    const buffer = zip.toBuffer();
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

test('artifact=<name>: newest live artifact resolves repo-wide; expired + own-run artifacts are skipped', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-test-'));
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: unreached,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async (args: { name: string }) => {
                    assert.equal(args.name, 'sift-baseline-main-build');
                    return {
                        data: {
                            artifacts: [
                                // newest first, as the API returns them
                                { id: 3, expired: false, workflow_run: { id: 1 } }, // THIS run — skip
                                { id: 2, expired: true, workflow_run: { id: 90 } }, // expired — skip
                                {
                                    id: 1,
                                    expired: false,
                                    created_at: '2026-07-01T00:00:00Z',
                                    workflow_run: { id: 80, head_sha: 'abc1234def', head_branch: 'main' },
                                },
                            ],
                        },
                    };
                },
                downloadArtifact: async (args: { artifact_id: number }) => {
                    assert.equal(args.artifact_id, 1);
                    return baselineZip('hello baseline\n');
                },
            },
        },
    };
    const resolved = await resolveBaseline(
        params(octokit, { spec: { kind: 'artifact', name: 'sift-baseline-main-build' }, workDir }),
    );
    assert.ok(resolved);
    assert.equal(resolved.meta.kind, 'artifact');
    assert.equal(resolved.meta.label, 'sift-baseline-main-build');
    assert.equal(resolved.meta.sha, 'abc1234def');
    assert.equal(await fs.readFile(resolved.logPath, 'utf8'), 'hello baseline\n');
});

test('artifact=<name>: no live artifact is a normal cold start (null)', async () => {
    const octokit = {
        rest: {
            actions: {
                getWorkflowRun: unreached,
                listWorkflowRuns: unreached,
                listWorkflowRunArtifacts: unreached,
                listArtifactsForRepo: async () => ({ data: { artifacts: [] } }),
                downloadArtifact: unreached,
            },
        },
    };
    assert.equal(
        await resolveBaseline(params(octokit, { spec: { kind: 'artifact', name: 'x' } })),
        null,
    );
});

test('path=<file>: local baseline resolves with path provenance; a MISSING file throws (config error)', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-test-'));
    const file = path.join(workDir, 'my-baseline.log');
    await fs.writeFile(file, 'local\n');
    const octokit = { rest: { actions: {} } };
    const resolved = await resolveBaseline(
        params(octokit, { spec: { kind: 'path', file }, workDir }),
    );
    assert.ok(resolved);
    assert.equal(resolved.meta.kind, 'path');
    assert.equal(resolved.meta.label, file);
    assert.equal(await fs.readFile(resolved.logPath, 'utf8'), 'local\n');

    await assert.rejects(
        resolveBaseline(params(octokit, { spec: { kind: 'path', file: path.join(workDir, 'absent.log') }, workDir })),
    );
});
