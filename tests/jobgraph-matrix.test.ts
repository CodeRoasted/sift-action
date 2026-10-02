// DN-127 slice S1 at the Action's producer (jobgraph.ts): the matrix species is read from the
// workflow file and travels on the ADR-22.D13 wire, and the one containment predicate gains arms M
// and T. These are the crawl producer's arms (insight-eidos sift/tests/crawl/job_graph_matrix_test.cpp)
// over the SAME workflow and listing — a divergence between the two producers is a fork of one wire.
//
// L10, producer half: every KEYED entry carries `declares_matrix`, true exactly when the job body
// declares `strategy.matrix` (a literal or an expression value alike), and no KEYLESS rendering
// carries it. The engine refuses either violation, naming the entry (sift_cli_matrix_leg_test.cpp).
// L2, S1 half: arm M admits `<anchor> (` and never parses the rest; arm T reads the declared
// `name:` as a glob template, each `${{ … }}` span matching any bytes; an anchor made only of
// expressions claims nothing; a rendering byte-equal to the anchor joins by arm E. Amended
// 2026-10-02: arm T reads any declaration, matrix or not, and arms M and T reach a rendering only
// when no other declaration claims it, while arm E keeps a job's own rendering (`zig-vt` and
// `examples` are ghostty-org/ghostty's measured collision).
//
// Every arm reads the wire through `parseWorkflowJobs` → `joinDeclaredJobs` and reads the new field
// by name off the emitted object, so the file type-checks at the S1 base (sift-action 29de46a).
// RED there where a test says so; the tests marked GREEN there are guards an S1 build keeps green.
// Conclusions are asserted only where the platform's token is copied verbatim (one rendering), so
// these arms do not depend on the spelling of a withheld conclusion (DN-89.D26).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { joinDeclaredJobs, parseWorkflowJobs, type DeclaredJobWire, type RenderedJob } from '../src/jobgraph.js';

const MATRIX_WORKFLOW = [
    'name: ci',
    'on: push',
    'jobs:',
    '  unit:',
    '    name: unit (${{ matrix.os }})',
    '    strategy:',
    '      matrix:',
    '        os: [linux, windows]',
    '  build:',
    '    strategy:',
    '      fail-fast: false',
    '      matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}',
    '  plain:',
    '    runs-on: ubuntu-latest',
    '  nomatrix:',
    '    strategy:',
    '      fail-fast: false',
    '  lint:',
    '    strategy:',
    '      matrix:',
    '        tool: [ruff]',
    '  pure:',
    '    name: ${{ matrix.name }}',
    '    strategy:',
    '      matrix:',
    '        name: [alpha, beta]',
    '  spaced:',
    '    name: ${{ matrix.a }} ${{ matrix.b }}',
    '    strategy:',
    '      matrix:',
    '        a: [x]',
    '        b: [y]',
    '  literal:',
    '    name: Test [${{ matrix.n }}] .*',
    '    strategy:',
    '      matrix:',
    '        n: [1, 2]',
    '  regexish:',
    '    name: Run (${{ matrix.n }}).*',
    '    strategy:',
    '      matrix:',
    '        n: [5]',
    '  empty:',
    '    name: probe (${{ matrix.tag }})',
    '    strategy:',
    '      matrix:',
    "        tag: ['']",
    '  shard:',
    '    name: Shard ${{ matrix.k }}',
    '    strategy:',
    '      matrix:',
    '        k: [1, 2]',
    '  deploy:',
    '    name: Deploy ${{ inputs.env }}',
    '    runs-on: ubuntu-latest',
    '  zig-vt:',
    '    name: Example zig-vt (macOS, no SDK)',
    '    runs-on: macos-latest',
    '  examples:',
    '    name: Example ${{ matrix.dir }}',
    '    strategy:',
    '      matrix:',
    '        dir: [lib-a]',
].join('\n');

const MATRIX_LISTING: RenderedJob[] = [
    { name: 'unit (linux)', conclusion: 'failure' },
    { name: 'unit (windows)', conclusion: 'success' },
    { name: 'build (ubuntu-latest, 3.12, a-matrix-value-the-platform-cut-at-100-...', conclusion: 'failure' },
    { name: 'build (macos-latest)', conclusion: 'success' },
    { name: 'plain', conclusion: 'success' },
    { name: 'plain (x)', conclusion: 'success' },
    { name: 'nomatrix (y)', conclusion: 'success' },
    { name: 'lint(ruff)', conclusion: 'success' },
    { name: 'linter (ruff)', conclusion: 'success' },
    { name: 'alpha', conclusion: 'success' },
    { name: 'beta', conclusion: 'success' },
    { name: 'x y', conclusion: 'success' },
    { name: 'Test [1] .*', conclusion: 'success' },
    { name: 'Test [2] .*', conclusion: 'failure' },
    { name: 'Run (5)xyz', conclusion: 'success' },
    { name: 'probe ()', conclusion: 'success' },
    { name: 'Shard ${{ matrix.k }}', conclusion: 'skipped' },
    { name: 'Deploy prod', conclusion: 'success' },
    { name: 'Example zig-vt (macOS, no SDK)', conclusion: 'skipped' },
    { name: 'Example lib-a', conclusion: 'failure' },
];

function joinedMatrixGraph(): DeclaredJobWire[] {
    return joinDeclaredJobs(parseWorkflowJobs(MATRIX_WORKFLOW), MATRIX_LISTING);
}

function keyedEntry(graph: DeclaredJobWire[], key: string): DeclaredJobWire {
    const entry = graph.find((job) => job.key === key);
    assert.ok(entry, `no keyed entry "${key}" in ${JSON.stringify(graph)}`);
    return entry;
}

// The new wire field, read by name off the object the producer emits.
function speciesOf(entry: DeclaredJobWire): unknown {
    return (entry as unknown as Record<string, unknown>)['declares_matrix'];
}

function displays(graph: DeclaredJobWire[], keys: string[]): Record<string, string> {
    return Object.fromEntries(keys.map((key) => [key, keyedEntry(graph, key).display]));
}

test('L10 (DN-127 S1): every keyed entry carries `declares_matrix` — `strategy.matrix` present, whatever its value — RED at 29de46a', () => {
    const graph = joinedMatrixGraph();
    const species = Object.fromEntries(
        graph.filter((job) => job.key !== '').map((job) => [job.key, speciesOf(job)]),
    );
    assert.deepEqual(
        species,
        {
            unit: true,
            build: true,
            plain: false,
            nomatrix: false,
            lint: true,
            pure: true,
            spaced: true,
            literal: true,
            regexish: true,
            empty: true,
            shard: true,
            deploy: false,
            'zig-vt': false,
            examples: true,
        },
        'the species is the key\'s PRESENCE: a literal mapping and a `${{ }}` value both declare a matrix, and a ' +
            '`strategy:` without `matrix:` declares none',
    );
});

test('L10 (DN-127 S1): no keyless rendering carries `declares_matrix` — a rendering declares no species — GREEN at 29de46a', () => {
    const carriers = joinedMatrixGraph()
        .filter((job) => job.key === '' && Object.prototype.hasOwnProperty.call(job, 'declares_matrix'))
        .map((job) => job.display);
    assert.deepEqual(carriers, [], 'the engine refuses a keyless entry carrying the field');
});

test('L2 (DN-127 S1): arm M reads the legs `<anchor> (` of a declared matrix and never parses the rest — RED at 29de46a', () => {
    // `build`'s first leg is cut before its closing parenthesis, as the listing cuts a name at 100
    // characters, and it still belongs.
    assert.equal(keyedEntry(joinedMatrixGraph(), 'build').display, 'build');
});

test('L2 (DN-127 S1): arm M needs the species and the separator — GREEN at 29de46a', () => {
    const graph = joinedMatrixGraph();
    assert.deepEqual(
        displays(graph, ['plain', 'nomatrix', 'lint']),
        { plain: 'plain', nomatrix: '', lint: '' },
        '`plain (x)` is no leg of the plain job `plain`; `nomatrix (y)` is no leg of a `strategy:` without ' +
            '`matrix:`; `lint(ruff)` and `linter (ruff)` do not begin with `lint (`',
    );
    assert.equal(keyedEntry(graph, 'plain').conclusion, 'success', '`plain` keeps the one conclusion it rendered with');
});

test('L2 (DN-127 S1): arm T reads the declared `name:` as a glob template, a span matching any bytes, the empty one included — RED at 29de46a', () => {
    assert.deepEqual(displays(joinedMatrixGraph(), ['unit', 'literal', 'empty']), {
        unit: 'unit (${{ matrix.os }})',
        literal: 'Test [${{ matrix.n }}] .*',
        empty: 'probe (${{ matrix.tag }})',
    });
});

test('L2 (DN-127 S1): arm T claims nothing without a literal byte, and `.*` is two literal bytes, never a pattern — GREEN at 29de46a', () => {
    assert.deepEqual(displays(joinedMatrixGraph(), ['pure', 'spaced', 'regexish']), {
        pure: '',
        spaced: '',
        regexish: '',
    });
});

test('L2 (DN-127 S1): a rendering byte-equal to a template anchor joins its declaration by arm E — GREEN at 29de46a', () => {
    const shard = keyedEntry(joinedMatrixGraph(), 'shard');
    assert.equal(shard.display, 'Shard ${{ matrix.k }}');
    assert.equal(shard.conclusion, 'skipped', 'one rendering: its conclusion is the declaration\'s');
});

test('L2 (DN-127 S1): arm T resolves a declaration WITHOUT a matrix on its one rendering, whose conclusion is its own — RED at 29de46a', () => {
    const deploy = keyedEntry(joinedMatrixGraph(), 'deploy');
    assert.equal(deploy.display, 'Deploy ${{ inputs.env }}');
    assert.equal(deploy.conclusion, 'success', 'one rendering: its conclusion is the declaration\'s');
});

test('L2 (DN-127 S1): a template never reaches another job\'s literal rendering — arm E keeps it — `examples` RED at 29de46a', () => {
    const graph = joinedMatrixGraph();
    const zigVt = keyedEntry(graph, 'zig-vt');
    assert.equal(zigVt.display, 'Example zig-vt (macOS, no SDK)');
    assert.equal(zigVt.conclusion, 'skipped');
    const examples = keyedEntry(graph, 'examples');
    assert.equal(examples.display, 'Example ${{ matrix.dir }}');
    // Reaching only `Example lib-a`, it carries that one rendering's verdict; reaching the literal
    // job's rendering too would make it a fan-out with no verdict of its own.
    assert.equal(examples.conclusion, 'failure');
});
