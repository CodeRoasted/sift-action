// Baseline resolution must DEGRADE to a cold start (return null), never throw, when
// the GitHub runs/artifacts API errors. A fork PR gets a READ-ONLY token that 403s on
// these calls (contract § 6); the README promises graceful degradation, so these tests
// hold the code to it — otherwise an unwrapped throw reddens the render/comment job on
// every fork PR instead of falling back to an honest cold start.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBaseline, type ResolveParams } from '../src/baseline';

function params(octokit: unknown): ResolveParams {
    return {
        octokit: octokit as ResolveParams['octokit'],
        owner: 'CodeRoasted',
        repo: 'insight-canon',
        runId: 1,
        baseBranch: 'main',
        workDir: '/tmp',
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
