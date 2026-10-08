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

import { joinDeclaredJobs, parseWorkflowJobs, reach, type DeclaredJobWire } from '../src/jobgraph.js';
import { listedRows } from './listing-rows.js';

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
            const joined = joinDeclaredJobs(declared, listedRows([{ name: rendering.name, conclusion: 'success' }]));
            // A keyed entry reaching the one listed rendering copies its conclusion; one reaching
            // nothing withholds it as `no_rendering`. Its display is its anchor either way (DN-127.D7).
            const reached = joined
                .slice(0, declared.length)
                .filter((job) => typeof job.conclusion === 'string')
                .map((job) => job.key);
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

// L14 (d), DN-127.D7: the round trip. Per case, this producer joins the WHOLE listing, and its wire,
// read as the engine reads it — each keyed entry a declaration anchored at its display, every
// keyless entry reached through `reach` — reaches what the table states. Every keyed entry carries
// its anchor, resolved or not, and its conclusion agrees with what it places: a copied token for
// exactly one, withheld `no_rendering` for none and `concluded_per_rendering` for two or more
// (DN-89.D26). Unlike the arms above the listing is whole, since a declaration reaching nothing is
// one whose every claim another contests.
for (const entry of CASES) {
    test(`case table (DN-127.D7), the producer's wire read by the engine: ${entry.name}`, () => {
        const declared = parseWorkflowJobs(workflowOf(entry));
        const wire = joinDeclaredJobs(
            declared,
            listedRows(entry.renderings.map((rendering) => ({ name: rendering.name, conclusion: 'success' }))),
        );
        const keyed = wire.slice(0, declared.length);
        const failures: string[] = [];
        entry.declarations.forEach((job, index) => {
            const anchor = job.name || job.key;
            if (keyed[index]?.key !== job.key || keyed[index]?.display !== anchor) {
                failures.push(
                    `keyed \`${keyed[index]?.key}\` travels display ${JSON.stringify(keyed[index]?.display)}; ` +
                        `its anchor is ${JSON.stringify(anchor)}`,
                );
            }
        });
        const declarations = keyed.map((job) => {
            const entryOf = job as Extract<DeclaredJobWire, { calls_workflow: boolean }>;
            return { anchor: job.display, callsWorkflow: entryOf.calls_workflow, declaresMatrix: entryOf.declares_matrix };
        });
        const placed = keyed.map(() => 0);
        for (const rendering of entry.renderings) {
            const reached = reach(rendering.name, declarations).map((each) => {
                placed[each.declaration]! += 1;
                return keyed[each.declaration]!.key;
            });
            if (JSON.stringify(reached) !== JSON.stringify(rendering.reached_by)) {
                failures.push(
                    `\`${rendering.name}\`: the engine's reading reaches ${JSON.stringify(reached)}, the table ` +
                        `states ${JSON.stringify(rendering.reached_by)}`,
                );
            }
        }
        keyed.forEach((job, index) => {
            const count = placed[index]!;
            const state = typeof job.conclusion === 'string' ? 'stated' : job.conclusion.withheld;
            const agrees =
                state === 'stated' || state === 'not_concluded'
                    ? count === 1
                    : state === 'concluded_per_rendering'
                      ? count >= 2
                      : count === 0;
            if (!agrees) {
                failures.push(
                    `keyed \`${job.key}\`: its conclusion ${JSON.stringify(job.conclusion)} disagrees with the ` +
                        `${count} it places under the engine's reading`,
                );
            }
        });
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
