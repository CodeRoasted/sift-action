// The Action-side producer of the DN-37.D18 wire (jobgraph.ts). These arms pin the pure halves —
// the YAML → declared-jobs parse and the declared ⋈ rendered join — against the contract the
// engine consumes. The acquisition rules mirror the crawler's producer (the same wire, a second
// transport), so every refusal here is a contract clause, not a style choice: verbatim `name:`,
// the exactly-one conclusion rule, key-less quoted renderings, the edge gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    declaresAnEdge,
    joinDeclaredJobs,
    parseWorkflowJobs,
    workflowPathFromRef,
    type RenderedJob,
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

// ── workflowPathFromRef — the one coordinate naming WHICH file this run executed ─

test('workflowPathFromRef: extracts the in-repo path and refuses shapes it cannot read', () => {
    assert.equal(
        workflowPathFromRef('CodeRoasted/sift-action/.github/workflows/ci.yml@refs/heads/main'),
        '.github/workflows/ci.yml',
    );
    assert.equal(
        workflowPathFromRef('o/r/.github/workflows/x.yml@refs/pull/7/merge'),
        '.github/workflows/x.yml',
    );
    assert.equal(workflowPathFromRef(undefined), null, 'absent variable ⇒ a source that cannot answer');
    assert.equal(workflowPathFromRef('not-a-workflow-ref'), null, 'no @refs/ marker ⇒ null, never a guess');
});
