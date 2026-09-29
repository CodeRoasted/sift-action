// The Action-side producer of the ADR-22.D13 wire (jobgraph.ts). These arms pin the pure halves —
// the YAML → declared-jobs parse and the declared ⋈ rendered join — against the contract the
// engine consumes, and the choice of WHICH workflow file is read (ADR-22.D17; the entry-level arms
// are in entry-jobgraph.test.ts). The acquisition rules mirror the crawler's producer (the same wire, a second
// transport), so every refusal here is a contract clause, not a style choice: verbatim `name:`,
// the exactly-one conclusion rule, key-less quoted renderings, the edge gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    declaresAnEdge,
    executedWorkflowCoordinate,
    joinDeclaredJobs,
    parseWorkflowJobs,
    resolveChangedJobGraph,
    type DeclaredJobWire,
    type RenderedJob,
    type ResolveJobGraphParams,
} from '../src/jobgraph.js';

// ── parseWorkflowJobs — the workflow file's declarations, verbatim ───────────

test('parseWorkflowJobs: keys, verbatim names, and both `needs:` shapes — scalar and sequence, one meaning', () => {
    const jobs = parseWorkflowJobs(
        [
            'name: CI',
            'jobs:',
            '  build:',
            '    name: Build',
            '  gate:',
            '    needs: build',
            '  release:',
            '    needs: [build, gate]',
        ].join('\n'),
    );
    assert.equal(jobs.length, 3, `expected 3 declared jobs, got ${jobs.length}: ${JSON.stringify(jobs)}`);
    assert.deepEqual(jobs[0], { key: 'build', name: 'Build', needs: [] });
    assert.deepEqual(jobs[1], { key: 'gate', name: '', needs: ['build'] }, 'a bare scalar `needs:` is one edge');
    assert.deepEqual(jobs[2], { key: 'release', name: '', needs: ['build', 'gate'] });
});

test('parseWorkflowJobs: a `${{ }}` name is kept AS WRITTEN — the producer renders no expression', () => {
    // The verbatim name fails the join downstream, deliberately: a job whose rendering the
    // acquirer cannot know stays UNRESOLVED rather than guessed.
    const jobs = parseWorkflowJobs(
        ['jobs:', '  matrixed:', "    name: build ${{ matrix.os }}", '    needs: []'].join('\n'),
    );
    assert.equal(jobs[0]!.name, 'build ${{ matrix.os }}', 'the expression must survive unrendered');
});

test('parseWorkflowJobs: a null-body job is KEPT — its key is a legitimate `needs:` target', () => {
    const jobs = parseWorkflowJobs(['jobs:', '  stub:', '  gate:', '    needs: stub'].join('\n'));
    assert.deepEqual(jobs[0], { key: 'stub', name: '', needs: [] });
});

test('parseWorkflowJobs: unreadable YAML and a jobs-less file THROW the reason — the caller logs it as ABSENT', () => {
    assert.throws(() => parseWorkflowJobs('a: [unclosed'), /workflow YAML is unreadable/);
    assert.throws(() => parseWorkflowJobs('- a list, not a workflow'), /not a YAML mapping/);
    assert.throws(() => parseWorkflowJobs('name: CI\non: push'), /declares no `jobs:` mapping/);
});

// ── joinDeclaredJobs — the acquirer resolves the mapping, both halves travel ─

const RENDERED_FANOUT: RenderedJob[] = [
    { name: 'Build', conclusion: 'success' },
    { name: 'Bazel / test linux', conclusion: 'success' },
    { name: 'Bazel / test windows', conclusion: 'failure' },
];

test('joinDeclaredJobs: the anchor is the `name:` when present, else the key — GitHub\'s own rendering rule', () => {
    const joined = joinDeclaredJobs(
        [
            { key: 'build', name: 'Build', needs: [] },
            { key: 'bazel', name: 'Bazel', needs: ['build'] },
        ],
        RENDERED_FANOUT,
    );
    assert.equal(joined[0]!.display, 'Build', 'named job anchors on its name');
    assert.equal(joined[1]!.display, 'Bazel', 'the fan-out prefix still resolves the anchor');
});

test('joinDeclaredJobs: a conclusion is declared for EXACTLY ONE rendered job, or not at all', () => {
    // A fan-out has N conclusions and NO caller row; rolling them into one would author a verdict
    // the platform never stated. Empty = NOT DECLARED — a third state, not success.
    const joined = joinDeclaredJobs(
        [
            { key: 'build', name: 'Build', needs: [] },
            { key: 'bazel', name: 'Bazel', needs: ['build'] },
        ],
        RENDERED_FANOUT,
    );
    assert.equal(joined[0]!.conclusion, 'success', 'rendered exactly once ⇒ that row\'s conclusion IS its conclusion');
    assert.equal(
        joined[1]!.conclusion,
        '',
        'a fan-out (2 rendered rows) must NOT be rolled into one caller-grain verdict',
    );
});

test('joinDeclaredJobs: rendered NOWHERE ⇒ display stays EMPTY — the coverage coordinate, never filled speculatively', () => {
    const joined = joinDeclaredJobs([{ key: 'ghost', name: 'Ghost', needs: [] }], RENDERED_FANOUT);
    assert.equal(joined[0]!.display, '', 'an unresolved key is a first-class statement the engine counts');
    assert.equal(joined[0]!.conclusion, '', 'no rendering ⇒ no conclusion to read');
});

test('joinDeclaredJobs: every rendered row is QUOTED key-less — a rendering is not referenceable', () => {
    // `key` is what `needs:` references; nothing may declare an edge to a rendering. The quoted
    // rows carry the platform's verdicts at the platform's own grain.
    const joined = joinDeclaredJobs([{ key: 'bazel', name: 'Bazel', needs: [] }], RENDERED_FANOUT);
    const quoted = joined.filter((job) => job.key === '');
    assert.equal(quoted.length, RENDERED_FANOUT.length, 'every rendered row travels in its own right');
    assert.deepEqual(
        quoted.map((job) => [job.display, job.conclusion]),
        RENDERED_FANOUT.map((row) => [row.name, row.conclusion]),
        'quoted rows carry the platform\'s name and NATIVE conclusion, verbatim',
    );
    assert.ok(
        quoted.every((job) => job.needs.length === 0),
        'a quoted rendering declares no edges — the causal graph stays exactly as big as declared',
    );
});

test('declaresAnEdge: the jobs-listing gate — no edge anywhere means the listing is pure cost', () => {
    assert.equal(declaresAnEdge([{ key: 'a', name: '', needs: [] }]), false);
    assert.equal(declaresAnEdge([{ key: 'a', name: '', needs: ['b'] }]), true);
});

// ── executedWorkflowCoordinate — the runner names the executed file (ADR-22.D17) ──

const EXECUTED_SHA = 'e'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const WORKFLOW_REF = 'octo/demo/.github/workflows/ci.yml@refs/pull/7/merge';

test('executedWorkflowCoordinate: the path from GITHUB_WORKFLOW_REF, the commit from GITHUB_WORKFLOW_SHA', () => {
    assert.deepEqual(
        executedWorkflowCoordinate({ GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_WORKFLOW_SHA: EXECUTED_SHA }),
        { kind: 'executed', path: '.github/workflows/ci.yml', sha: EXECUTED_SHA },
    );
    assert.deepEqual(
        executedWorkflowCoordinate({
            GITHUB_WORKFLOW_REF: 'CodeRoasted/sift-action/.github/workflows/ci.yml@refs/heads/main',
            GITHUB_WORKFLOW_SHA: 'A'.repeat(64),
        }),
        { kind: 'executed', path: '.github/workflows/ci.yml', sha: 'A'.repeat(64) },
        'a SHA-256 commit id is a commit id too',
    );
});

// (A4) Each malformed input is refused with a reason naming the variable at fault — never a guess,
// never a substitute.
test('executedWorkflowCoordinate (A4): refuses each malformed input, with a reason naming the variable', () => {
    const cells: ReadonlyArray<{ what: string; ref?: string; sha?: string; reason: RegExp }> = [
        { what: 'a ref with no @refs/ marker', ref: 'not-a-workflow-ref', sha: EXECUTED_SHA, reason: /^GITHUB_WORKFLOW_REF "not-a-workflow-ref" names no workflow path$/ },
        { what: 'a ref naming only owner/repo', ref: 'octo/demo@refs/heads/main', sha: EXECUTED_SHA, reason: /^GITHUB_WORKFLOW_REF "octo\/demo@refs\/heads\/main" names no workflow path$/ },
        { what: 'an empty SHA', ref: WORKFLOW_REF, sha: '', reason: /^GITHUB_WORKFLOW_SHA is absent or empty$/ },
        { what: 'an unset SHA', ref: WORKFLOW_REF, reason: /^GITHUB_WORKFLOW_SHA is absent or empty$/ },
        { what: 'a SHA without a path', sha: EXECUTED_SHA, reason: /^GITHUB_WORKFLOW_REF is absent or empty$/ },
        { what: 'a branch name in the SHA slot', ref: WORKFLOW_REF, sha: 'main', reason: /^GITHUB_WORKFLOW_SHA "main" is not a commit id$/ },
        { what: 'a truncated SHA', ref: WORKFLOW_REF, sha: EXECUTED_SHA.slice(0, 12), reason: /is not a commit id$/ },
        { what: 'neither variable', reason: /^GITHUB_WORKFLOW_REF is absent or empty; GITHUB_WORKFLOW_SHA is absent or empty$/ },
    ];
    for (const cell of cells) {
        const coordinate = executedWorkflowCoordinate({ GITHUB_WORKFLOW_REF: cell.ref, GITHUB_WORKFLOW_SHA: cell.sha });
        assert.equal(coordinate.kind, 'refused', `${cell.what}: expected a refusal, got ${JSON.stringify(coordinate)}`);
        if (coordinate.kind === 'refused') {
            assert.match(coordinate.reason, cell.reason, `${cell.what}: reason was "${coordinate.reason}"`);
        }
    }
});

// ── resolveChangedJobGraph — the read is at the coordinate, and nowhere else ─

// A stand-in for the two REST calls the resolver makes, serving the workflow file PER COMMIT and
// recording every call, so an arm can say both what was read and what was not.
const REWIRED_AT: Record<string, string> = {
    [BASE_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [a]'].join('\n'),
    [EXECUTED_SHA]: ['jobs:', '  a: {}', '  b: {}', '  gate:', '    needs: [b]'].join('\n'),
};
const REWIRED_LISTING = [
    { name: 'a', conclusion: 'success' },
    { name: 'b', conclusion: 'failure' },
    { name: 'gate', conclusion: 'failure' },
];

function standIn() {
    const calls: string[] = [];
    const octokit = {
        rest: {
            repos: {
                getContent: async (request: { path: string; ref: string }) => {
                    calls.push(`getContent ${request.path} @ ${request.ref}`);
                    const yaml = REWIRED_AT[request.ref];
                    if (yaml === undefined) throw new Error(`Not Found (${request.ref})`);
                    return { data: yaml };
                },
            },
            actions: { listJobsForWorkflowRun: 'listJobsForWorkflowRun' },
        },
        paginate: async (route: unknown) => {
            calls.push(`paginate ${String(route)}`);
            return REWIRED_LISTING;
        },
    };
    return { octokit: octokit as unknown as ResolveJobGraphParams['octokit'], calls };
}

async function resolveAt(sha: string | undefined) {
    const { octokit, calls } = standIn();
    const lines: string[] = [];
    const graph = await resolveChangedJobGraph({
        octokit,
        owner: 'octo',
        repo: 'demo',
        runId: 4242,
        workflow: executedWorkflowCoordinate({ GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_WORKFLOW_SHA: sha }),
        info: (line) => lines.push(line),
    });
    return { graph, calls, lines };
}

// The members of `aggregator` whose own conclusion is a failure — what a fold of its red can name.
function failedMembers(graph: DeclaredJobWire[], aggregator: string): string[] {
    const byKey = new Map(graph.filter((job) => job.key !== '').map((job) => [job.key, job]));
    return (byKey.get(aggregator)?.needs ?? []).filter((key) => byKey.get(key)?.conclusion === 'failure');
}

test('resolveChangedJobGraph (A1): the only contents read is at the coordinate\'s commit, and the log names it', async () => {
    const { calls, lines } = await resolveAt(EXECUTED_SHA);
    assert.deepEqual(
        calls.filter((call) => call.startsWith('getContent')),
        [`getContent .github/workflows/ci.yml @ ${EXECUTED_SHA}`],
        `expected one read at the runner's commit; calls: ${JSON.stringify(calls)}`,
    );
    assert.ok(
        lines.some((line) => line.includes(`.github/workflows/ci.yml at ${EXECUTED_SHA}`)),
        `a successful read must log its coordinate; log: ${JSON.stringify(lines)}`,
    );
});

test('resolveChangedJobGraph (A2): a re-wired `needs:` folds along the executed edge — and the base graph would have folded differently', async () => {
    const executed = await resolveAt(EXECUTED_SHA);
    assert.ok(executed.graph, `no graph at the executed commit; log: ${JSON.stringify(executed.lines)}`);
    const executedGate = executed.graph.find((job) => job.key === 'gate');
    assert.deepEqual(executedGate?.needs, ['b'], `executed gate: ${JSON.stringify(executedGate)}`);
    assert.deepEqual(failedMembers(executed.graph, 'gate'), ['b'], 'the executed graph lets gate\'s red fold into b');

    // Anti-vacuity: the SAME stand-in, read at the base commit, answers differently — so the arm
    // above can only pass by reading the executed commit.
    const base = await resolveAt(BASE_SHA);
    assert.ok(base.graph, `no graph at the base commit; log: ${JSON.stringify(base.lines)}`);
    const baseGate = base.graph.find((job) => job.key === 'gate');
    assert.deepEqual(baseGate?.needs, ['a'], `base gate: ${JSON.stringify(baseGate)}`);
    assert.deepEqual(
        failedMembers(base.graph, 'gate'),
        [],
        'on the base graph gate\'s red has no failed member: the fold that the executed graph makes would not fire',
    );
});

test('resolveChangedJobGraph (A3): no runner commit ⇒ ABSENT, zero requests, one log line naming GITHUB_WORKFLOW_SHA', async () => {
    const { graph, calls, lines } = await resolveAt(undefined);
    assert.equal(graph, null, `expected ABSENT, got ${JSON.stringify(graph)}`);
    assert.deepEqual(calls, [], `no request may be made without the runner's commit; calls: ${JSON.stringify(calls)}`);
    assert.equal(lines.length, 1, `expected exactly one log line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /^Sift: no declared job graph — GITHUB_WORKFLOW_SHA is absent or empty\./);
});
