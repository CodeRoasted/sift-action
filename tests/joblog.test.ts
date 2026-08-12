// target-job log sourcing: timestamp stripping, SIFT_CAPTURE section slicing
// (exact-line matching so the runner's script-echo can never false-match), and
// the job lookup's fail-loud contract (missing / ambiguous / not-completed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    extractCaptureSections,
    fetchTargetJobLog,
    sliceJobLog,
    stripRunnerTimestamps,
    type FetchJobLogParams,
} from '../src/joblog.js';

const T = '2026-07-06T12:34:56.7890123Z ';

test('stripRunnerTimestamps: removes the per-line ISO prefix, leaves bare lines alone', () => {
    const lines = stripRunnerTimestamps(`${T}hello\nno-timestamp line\n${T}##[group]Run make ci`);
    assert.deepEqual(lines, ['hello', 'no-timestamp line', '##[group]Run make ci']);
});

test('capture markers match EXACT lines only — the script-echo in the group header never opens a section', () => {
    const log = [
        `${T}##[group]Run echo "SIFT_CAPTURE ci"`,
        `${T}echo "SIFT_CAPTURE ci"`, // the runner's script echo — NOT a marker
        `${T}##[endgroup]`,
        `${T}SIFT_CAPTURE ci`, // the real marker (the echoed output)
        `${T}building`,
        `${T}SIFT_CAPTURE_END`,
        `${T}teardown noise`,
    ].join('\n');
    assert.equal(sliceJobLog(log, 'ci'), 'building');
});

test('capture auto: sections when present (all of them, in order), whole log when none', () => {
    const withSections = [
        `${T}setup noise`,
        `${T}SIFT_CAPTURE ci`,
        `${T}line a`,
        `${T}SIFT_CAPTURE_END`,
        `${T}between noise`,
        `${T}SIFT_CAPTURE release`,
        `${T}line b`,
        `${T}SIFT_CAPTURE_END`,
    ].join('\n');
    assert.equal(sliceJobLog(withSections, 'auto'), 'line a\nline b');
    assert.equal(sliceJobLog(`${T}just a line`, 'auto'), 'just a line');
});

test('capture off: whole log even when sections exist; named: only that name; absent name THROWS', () => {
    const log = [
        `${T}SIFT_CAPTURE ci`,
        `${T}line a`,
        `${T}SIFT_CAPTURE_END`,
        `${T}outside`,
    ].join('\n');
    assert.ok(sliceJobLog(log, 'off').includes('outside'));
    assert.equal(sliceJobLog(log, 'ci'), 'line a');
    assert.throws(() => sliceJobLog(log, 'release'), /capture section "release" not found/);
});

test('an unterminated section still captures its tail (a job that died mid-capture)', () => {
    const sections = extractCaptureSections(['SIFT_CAPTURE ci', 'last gasp']);
    assert.deepEqual(sections, [{ name: 'ci', lines: ['last gasp'] }]);
});

test('anonymous sections (bare SIFT_CAPTURE) work under auto', () => {
    const log = [`${T}SIFT_CAPTURE`, `${T}payload`, `${T}SIFT_CAPTURE_END`].join('\n');
    assert.equal(sliceJobLog(log, 'auto'), 'payload');
});

// ── job lookup ───────────────────────────────────────────────────────────────

function fetchParams(jobs: unknown[], log: string, over: Partial<FetchJobLogParams> = {}): FetchJobLogParams {
    const octokit = {
        paginate: async () => jobs,
        rest: {
            actions: {
                listJobsForWorkflowRun: async () => ({ data: { jobs } }),
                downloadJobLogsForWorkflowRun: async () => ({ data: log }),
            },
        },
    };
    return {
        octokit: octokit as unknown as FetchJobLogParams['octokit'],
        owner: 'o',
        repo: 'r',
        runId: 1,
        jobName: 'build',
        capture: 'auto',
        ...over,
    };
}

test('fetchTargetJobLog: exact name match, completed job, cleaned log + conclusion returned', async () => {
    const jobs = [{ id: 7, name: 'build', status: 'completed', conclusion: 'success' }];
    const out = await fetchTargetJobLog(fetchParams(jobs, `${T}hello\n${T}world`));
    assert.equal(out.text, 'hello\nworld');
    assert.equal(out.conclusion, 'success');
});

test('fetchTargetJobLog: reusable-workflow "caller / name" suffix matches uniquely', async () => {
    const jobs = [
        { id: 7, name: 'ci / build', status: 'completed', conclusion: 'success' },
        { id: 8, name: 'lint', status: 'completed', conclusion: 'success' },
    ];
    const out = await fetchTargetJobLog(fetchParams(jobs, `${T}ok`));
    assert.equal(out.text, 'ok');
});

test('fetchTargetJobLog: missing, ambiguous, and not-completed jobs all THROW with actionable messages', async () => {
    await assert.rejects(
        fetchTargetJobLog(fetchParams([{ id: 1, name: 'other', status: 'completed' }], '')),
        /not found in this run/,
    );
    await assert.rejects(
        fetchTargetJobLog(
            fetchParams(
                [
                    { id: 1, name: 'a / build', status: 'completed' },
                    { id: 2, name: 'b / build', status: 'completed' },
                ],
                '',
            ),
        ),
        /ambiguous/,
    );
    await assert.rejects(
        fetchTargetJobLog(fetchParams([{ id: 1, name: 'build', status: 'in_progress' }], '')),
        /has not completed .* `needs:`/,
    );
});

// ── DN-37.D14 — the RENDERING GRAMMAR, mirrored ──────────────────────────────
//
// A reusable-workflow job renders as `"<caller job> / <inner name>"`. That grammar is
// stated ONCE (DN-37.D14) and consumed here and in the engine, and the two consumers
// cannot share a literal: this repo is PUBLIC, the engine repo is PRIVATE, and the only
// artifact they both hold is the published binary — which carries no source text. Literal
// single-sourcing was costed and is unreachable.
//
// So the mechanism is TWO INDEPENDENT WITNESSES OVER THE SAME LITERAL EXAMPLE. The engine
// side is `SiftCrawlJobGraph.TheAnchorMatchesItsExactRenderingAndEveryFanOutRowUnderIt`,
// on these exact names, measured off a real run. If GitHub changes the rendering, both go
// red, and neither repo depends on the other to notice.
//
// ⚠ THE HONEST BOUND, AND IT MUST NOT BE SOFTENED: two witnesses catch a PLATFORM change.
// They do NOT catch one lane editing one comment out of agreement with the other — nothing
// reachable does, short of a shared artifact, which was named with its cost and refused.
// Do not describe this pair as "keeping the two repos in sync". It keeps them both honest
// about GitHub.
//
// ⚠ AND IT PINS IDENTITY, NEVER A COUNT. "one match" is satisfied by matching the WRONG
// job, and the sibling arm above cannot tell the difference: its mock returns the same log
// for every `job_id`. Here the log is keyed by id and the two fan-out siblings declare
// OPPOSITE conclusions, so resolving the wrong one fails on both axes.

const RUST_CI_FAN_OUT = [
    { id: 11, name: 'Lint', status: 'completed', conclusion: 'success' },
    { id: 12, name: 'unit', status: 'completed', conclusion: 'failure' },
    { id: 13, name: 'rust-ci / Format', status: 'completed', conclusion: 'success' },
    { id: 14, name: 'rust-ci / cargo shear', status: 'completed', conclusion: 'failure' },
];

function fanOutParams(jobName: string): FetchJobLogParams {
    const octokit = {
        paginate: async () => RUST_CI_FAN_OUT,
        rest: {
            actions: {
                listJobsForWorkflowRun: async () => ({ data: { jobs: RUST_CI_FAN_OUT } }),
                // The log IS the identity: keyed by job_id, so the returned text names which
                // row the lookup actually resolved.
                downloadJobLogsForWorkflowRun: async ({ job_id }: { job_id: number }) => ({
                    data: `${T}log-of-job-${job_id}`,
                }),
            },
        },
    };
    return {
        octokit: octokit as unknown as FetchJobLogParams['octokit'],
        owner: 'o',
        repo: 'r',
        runId: 1,
        jobName,
        capture: 'off',
    };
}

test('DN-37.D14 mirror: an inner name resolves through the "<caller> / <inner>" rendering, and it is THAT job', async () => {
    const out = await fetchTargetJobLog(fanOutParams('cargo shear'));
    // Identity, twice, on two independent axes. `rust-ci / Format` is the sibling under the
    // same anchor and declares the OPPOSITE conclusion, so a wrong pick cannot pass both.
    assert.equal(out.text, 'log-of-job-14');
    assert.equal(out.conclusion, 'failure');
});

test('DN-37.D14 mirror: the full rendering resolves exactly, and the separator is load-bearing', async () => {
    // The exact-name path takes precedence and lands on the same row — the anchor's own
    // rendering is a legal name in its own right.
    const exact = await fetchTargetJobLog(fanOutParams('rust-ci / Format'));
    assert.equal(exact.text, 'log-of-job-13');
    assert.equal(exact.conclusion, 'success');

    // ⚠ AND THE GRAMMAR IS A SEPARATOR, NOT A SUFFIX. Were the fallback a bare `endsWith`,
    // any job whose name merely ENDS in the inner name would match — the fan-out would stop
    // being a declared containment and become a substring coincidence. Nothing else in this
    // repo states that the separator carries the meaning.
    await assert.rejects(fetchTargetJobLog(fanOutParams('shear')), /not found in this run/);
});
