// DN-127.D1's rendering grammar, read off the ONE case table both repositories copy byte for byte,
// through this producer's own join (`joinDeclaredJobs`). The table is tests/fixtures/job_rendering_cases.json;
// insight-eidos drives its copy at sift/tests/crawl/fixtures/job_rendering_cases.json through the
// crawl's `join_declared_jobs`, and a superproject check reds on any byte between the two copies.
//
// Each case's declarations become a workflow file `parseWorkflowJobs` reads, so the species reach
// the join as the shipped reader sets them. REACH is read one rendering at a time: the join runs
// with the case's every declaration and a listing of that rendering alone, and the keyed entries it
// resolves are the declarations that reach it. That isolation is exact, because the collision
// refusal asks whether another DECLARATION claims the rendering, which no other rendering changes.
// The join returns no arm, so the `arm` column is read through the grammar's `reach`, the function
// the join calls, over the same declarations.
//
// RED at sift-action 29de46a (the S1 base) on every rendering only arm M or T reaches; the arm E
// and arm R rows, and every row the collision refusal leaves unreached, are GREEN there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { joinDeclaredJobs, parseWorkflowJobs, reach } from '../src/jobgraph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLE = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'job_rendering_cases.json');

interface TableDeclaration {
    key: string;
    name: string;
    calls_workflow: boolean;
    declares_matrix: boolean;
}

interface TableRendering {
    name: string;
    reached_by: string[];
    arm: 'E' | 'R' | 'M' | 'T' | null;
}

interface TableCase {
    name: string;
    source: string;
    declarations: TableDeclaration[];
    renderings: TableRendering[];
}

const CASES = (JSON.parse(readFileSync(TABLE, 'utf8')) as { cases: TableCase[] }).cases;

// The workflow file declaring the case's jobs: the name when the table gives one, `uses:` for a
// caller, and a one-value `strategy.matrix` for a matrix job.
function workflowOf(entry: TableCase): string {
    const lines = ['jobs:'];
    for (const job of entry.declarations) {
        lines.push(`  ${JSON.stringify(job.key)}:`);
        if (job.name) lines.push(`    name: ${JSON.stringify(job.name)}`);
        lines.push(job.calls_workflow ? '    uses: ./.github/workflows/called.yml' : '    runs-on: ubuntu-latest');
        if (job.declares_matrix) lines.push('    strategy:', '      matrix:', '        leg: [one]');
    }
    return lines.join('\n');
}

test('case table: it holds cases, and every row is well formed', () => {
    assert.ok(CASES.length > 0, 'the case table holds no case, so no row below runs');
    for (const entry of CASES) {
        const keys = new Set(entry.declarations.map((job) => job.key));
        for (const rendering of entry.renderings) {
            const where = `${entry.name}: \`${rendering.name}\``;
            assert.equal(rendering.arm !== null, rendering.reached_by.length > 0, where);
            if (rendering.arm !== null) assert.ok(['E', 'R', 'M', 'T'].includes(rendering.arm), where);
            for (const key of rendering.reached_by) assert.ok(keys.has(key), `${where} names no declaration ${key}`);
        }
    }
});

for (const entry of CASES) {
    test(`case table (DN-127 S1): ${entry.name}`, () => {
        const declared = parseWorkflowJobs(workflowOf(entry));
        const failures: string[] = [];
        for (const rendering of entry.renderings) {
            const joined = joinDeclaredJobs(declared, [{ name: rendering.name, conclusion: 'success' }]);
            const reached = joined.slice(0, declared.length).filter((job) => job.display !== '').map((job) => job.key);
            if (JSON.stringify(reached) !== JSON.stringify(rendering.reached_by)) {
                failures.push(
                    `\`${rendering.name}\`: reached by ${JSON.stringify(reached)}, the table states ` +
                        `${JSON.stringify(rendering.reached_by)} by arm ${rendering.arm ?? 'none'}`,
                );
            }
        }
        assert.deepEqual(failures, [], `${entry.source}\n${workflowOf(entry)}`);
    });
}

for (const entry of CASES) {
    test(`case table (DN-127 S1), the arm: ${entry.name}`, () => {
        const declarations = entry.declarations.map((job) => ({
            anchor: job.name || job.key,
            callsWorkflow: job.calls_workflow,
            declaresMatrix: job.declares_matrix,
        }));
        const failures: string[] = [];
        for (const rendering of entry.renderings) {
            const reached = reach(rendering.name, declarations);
            const keys = reached.map((each) => entry.declarations[each.declaration]!.key);
            const wrongArms = reached.filter((each) => each.arm !== rendering.arm);
            if (JSON.stringify(keys) !== JSON.stringify(rendering.reached_by) || wrongArms.length > 0) {
                failures.push(
                    `\`${rendering.name}\`: reach gives ${JSON.stringify(reached)}, the table states ` +
                        `${JSON.stringify(rendering.reached_by)} by arm ${rendering.arm ?? 'none'}`,
                );
            }
        }
        assert.deepEqual(failures, [], entry.source);
    });
}
