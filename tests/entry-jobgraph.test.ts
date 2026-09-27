// The job-graph read as the SHIPPED ENTRY performs it (DN-118.D1). jobgraph.test.ts executes the
// coordinate function and the resolver; these arms execute src/main.ts itself, because a ref chosen
// at the call site is invisible to both: until 2026-09-27 main.ts took the ref from the event
// payload (a PR's `base.sha`, a file that did not run), and no test ran it.
//
// The entry runs as a child process against a local stand-in for the REST API (GITHUB_API_URL),
// with a `pull_request` event payload whose `base.sha` differs from the runner's
// GITHUB_WORKFLOW_SHA. The stand-in serves the workflow file per ref, so the graph the engine
// receives says WHICH commit was read. The fake engine copies the `--changed-job-graph` file out,
// then exits 4: the graph read happens before the engine, and a failing engine ends the entry
// before any comment, summary or artifact surface needs a stand-in of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeclaredJobWire } from '../src/jobgraph.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js');

const OWNER = 'octo';
const REPO = 'demo';
const RUN_ID = 4242;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
// The runner's commit (on `pull_request`, the merge commit it executed) and the PR's base tip.
const EXECUTED_SHA = 'e'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);

// The re-wired aggregator: the base declares `gate` needs `a`; the PR re-wires it to `b`.
const WORKFLOW_AT: Record<string, string> = {
    [BASE_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [a]'].join('\n'),
    [EXECUTED_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [b]'].join('\n'),
};
const LISTING = [
    { name: 'a', conclusion: 'success' },
    { name: 'b', conclusion: 'failure' },
    { name: 'gate', conclusion: 'failure' },
];

interface RecordedRequest {
    method: string;
    pathname: string;
    ref: string | null;
}

interface EntryRun {
    requests: RecordedRequest[];
    stdout: string;
    graph: DeclaredJobWire[] | null;
    exitCode: number | null;
}

function serve(recorded: RecordedRequest[]) {
    return createServer((request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? '/', 'http://stand-in');
        recorded.push({
            method: request.method ?? '',
            pathname: decodeURIComponent(url.pathname),
            ref: url.searchParams.get('ref'),
        });
        const contentsPrefix = `/repos/${OWNER}/${REPO}/contents/`;
        const pathname = decodeURIComponent(url.pathname);
        if (pathname === `${contentsPrefix}${WORKFLOW_PATH}`) {
            const yaml = WORKFLOW_AT[url.searchParams.get('ref') ?? ''];
            if (yaml !== undefined) {
                response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                response.end(yaml);
                return;
            }
        }
        if (pathname === `/repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}/jobs`) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ total_count: LISTING.length, jobs: LISTING }));
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message: 'Not Found' }));
    });
}

// One entry run under a `pull_request` event. `workflowSha` undefined = the variable is UNSET.
async function runEntry(workflowSha: string | undefined): Promise<EntryRun> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sift-entry-'));
    const captured = path.join(dir, 'captured-graph.json');
    const engine = path.join(dir, 'fake-sift');
    await fsp.writeFile(
        engine,
        [
            `#!${process.execPath}`,
            "const args = process.argv.slice(2);",
            "const at = args.indexOf('--changed-job-graph');",
            `if (at >= 0) require('fs').copyFileSync(args[at + 1], ${JSON.stringify(captured)});`,
            'process.exit(4);',
        ].join('\n'),
    );
    await fsp.chmod(engine, 0o755);
    const log = path.join(dir, 'build.log');
    await fsp.writeFile(log, 'compile\nok\n');
    const eventPath = path.join(dir, 'event.json');
    await fsp.writeFile(
        eventPath,
        JSON.stringify({
            pull_request: {
                number: 7,
                base: { ref: 'main', sha: BASE_SHA },
                head: { ref: 'rewire', sha: HEAD_SHA },
            },
            repository: { default_branch: 'main' },
        }),
    );

    const recorded: RecordedRequest[] = [];
    const server = serve(recorded);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // A hermetic environment, built from nothing: no proxy variable and no ambient GITHUB_* can
    // leak in from the shell running the suite.
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        RUNNER_TEMP: dir,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
        GITHUB_RUN_ID: String(RUN_ID),
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: 'refs/pull/7/merge',
        GITHUB_SHA: EXECUTED_SHA,
        GITHUB_WORKFLOW_REF: `${OWNER}/${REPO}/${WORKFLOW_PATH}@refs/pull/7/merge`,
        'INPUT_GITHUB-TOKEN': 'stand-in-token',
        INPUT_LOG: log,
        INPUT_BASELINE: `path=${log}`,
        'INPUT_SIFT-BINARY': engine,
        INPUT_EXPLAIN: 'false',
    };
    if (workflowSha !== undefined) env.GITHUB_WORKFLOW_SHA = workflowSha;

    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    let graph: DeclaredJobWire[] | null = null;
    try {
        graph = JSON.parse(await fsp.readFile(captured, 'utf8')) as DeclaredJobWire[];
    } catch {
        graph = null;
    }
    await fsp.rm(dir, { recursive: true, force: true });
    return { requests: recorded, stdout, graph, exitCode };
}

function graphRequests(run: EntryRun): RecordedRequest[] {
    return run.requests.filter(
        (request) =>
            request.pathname.startsWith(`/repos/${OWNER}/${REPO}/contents/`) ||
            request.pathname === `/repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}/jobs`,
    );
}

function describeRun(run: EntryRun): string {
    return (
        `\n  requests: ${JSON.stringify(run.requests)}` +
        `\n  graph: ${JSON.stringify(run.graph)}` +
        `\n  exit: ${run.exitCode}` +
        `\n  entry output:\n${run.stdout}`
    );
}

// DN-118.D1 (A1): the runner names the executed file; a payload's `base.sha` never picks the commit.
test('entry (A1): on a pull_request run the ONLY contents read is at GITHUB_WORKFLOW_SHA, never the payload base.sha', async () => {
    const run = await runEntry(EXECUTED_SHA);
    const contents = run.requests.filter((request) => request.pathname.includes('/contents/'));
    assert.deepEqual(
        contents.map((request) => [request.pathname, request.ref]),
        [[`/repos/${OWNER}/${REPO}/contents/${WORKFLOW_PATH}`, EXECUTED_SHA]],
        `expected exactly one contents read, at the runner's commit ${EXECUTED_SHA}; ` +
            `a read at ${BASE_SHA} is the payload's base.sha${describeRun(run)}`,
    );
});

// DN-118.D1 (A2): the fold's edge is the one the run executed. The anti-vacuity half — the same
// stand-in read at the base commit yields `a` — lives in jobgraph.test.ts, where the resolver can be
// pointed at either commit directly.
test('entry (A2): a PR that re-wires `needs:` hands the engine the EXECUTED edge (gate → b), not the base edge (gate → a)', async () => {
    const run = await runEntry(EXECUTED_SHA);
    assert.ok(run.graph, `the engine received no --changed-job-graph${describeRun(run)}`);
    const gate = run.graph.find((job) => job.key === 'gate');
    assert.deepEqual(
        gate?.needs,
        ['b'],
        `gate.needs must be the merge commit's edge ["b"]; ["a"] is the base branch's${describeRun(run)}`,
    );
});

// DN-118.D1 (A3): no runner commit, no graph — and no substitute commit either.
test('entry (A3): GITHUB_WORKFLOW_SHA unset ⇒ no graph, zero graph requests, one log line naming the variable', async () => {
    const run = await runEntry(undefined);
    assert.equal(run.graph, null, `the engine must receive no graph flag${describeRun(run)}`);
    assert.deepEqual(graphRequests(run), [], `no contents or jobs request may be made${describeRun(run)}`);
    const naming = run.stdout.split('\n').filter((line) => line.includes('GITHUB_WORKFLOW_SHA'));
    assert.equal(
        naming.length,
        1,
        `expected exactly one log line naming GITHUB_WORKFLOW_SHA, got ${naming.length}${describeRun(run)}`,
    );
    assert.match(naming[0]!, /no declared job graph/, `the line must say the graph is absent${describeRun(run)}`);
});
