// target-job log sourcing: timestamp stripping, SIFT_CAPTURE section slicing
// (exact-line matching so the runner's script-echo can never false-match), and
// the job lookup's fail-loud contract (missing / ambiguous / not-completed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    deriveBuildStatus,
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

test('deriveBuildStatus: success ⇒ green, any other conclusion ⇒ red, none ⇒ unknown', () => {
    assert.equal(deriveBuildStatus('success'), 'green');
    assert.equal(deriveBuildStatus('failure'), 'red');
    assert.equal(deriveBuildStatus('cancelled'), 'red');
    assert.equal(deriveBuildStatus(null), 'unknown');
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
