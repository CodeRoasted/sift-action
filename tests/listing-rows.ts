// Listing rows for the job-graph arms: the REST job object reduced to what `RenderedJob` reads.
// One shape for every test file, so an arm states only the coordinates it is about — a row's
// name and conclusion — and every other member is the one a completed, runner-assigned job with
// no listed step carries. Ids are assigned in order from `firstId`, so a row's identity on the
// wire is a function of its position and two arms never share one by accident.

import type { RenderedJob } from '../src/jobgraph.js';

export const FIRST_JOB_ID = 1001;

export function listedRows(
    rows: ReadonlyArray<{ name: string; conclusion: string | null }>,
    firstId: number = FIRST_JOB_ID,
): RenderedJob[] {
    return rows.map((row, index) => ({
        id: firstId + index,
        name: row.name,
        conclusion: row.conclusion,
        run_attempt: 1,
        steps: [],
        runner_id: null,
        runner_name: null,
    }));
}
