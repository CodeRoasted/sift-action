// Unit tests for the workflow_run poster's security predicates (contract § 6.1).
// The two load-bearing decisions are pure and tested here: (a) only the expected
// build workflow on a PR is trusted; (b) pr_number is chosen from the PRs
// associated with the TRUSTED head_sha, never a fork-supplied number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { selectPrNumber, triggeringRunIsTrusted, type AssociatedPr } from '../src/poster';
import { writeRenderedComment } from '../src/artifact';
import { RENDERED_META_FILE, type RenderedCommentMeta } from '../src/types';

// ── (a) triggeringRunIsTrusted ──────────────────────────────────────────────

test('rejects a triggering run whose event is not pull_request', () => {
    assert.equal(
        triggeringRunIsTrusted({ id: 1, head_sha: 'a', event: 'push', name: 'CI', path: '.github/workflows/ci.yml' }, 'ci.yml'),
        false,
    );
});

test('accepts the expected build workflow on a PR (matched by file name)', () => {
    assert.equal(
        triggeringRunIsTrusted(
            { id: 1, head_sha: 'a', event: 'pull_request', name: 'Build', path: '.github/workflows/sift.yml' },
            'sift.yml',
        ),
        true,
    );
});

test('accepts the expected build workflow on a PR (matched by display name)', () => {
    assert.equal(
        triggeringRunIsTrusted(
            { id: 1, head_sha: 'a', event: 'pull_request', name: 'Build', path: '.github/workflows/sift.yml' },
            'Build',
        ),
        true,
    );
});

test('rejects a PR-triggered run from a DIFFERENT workflow than expected', () => {
    assert.equal(
        triggeringRunIsTrusted(
            { id: 1, head_sha: 'a', event: 'pull_request', name: 'Release', path: '.github/workflows/release.yml' },
            'sift.yml',
        ),
        false,
    );
});

test('with no expected workflow configured, still requires a PR event (trigger filter guards identity)', () => {
    assert.equal(
        triggeringRunIsTrusted({ id: 1, head_sha: 'a', event: 'pull_request', name: 'CI', path: 'x' }, ''),
        true,
    );
    assert.equal(triggeringRunIsTrusted({ id: 1, head_sha: 'a', event: 'push', name: 'CI', path: 'x' }, ''), false);
});

// ── (b) selectPrNumber — only the trusted head_sha keys the choice ───────────

const prs = (over: Partial<AssociatedPr>[] = []): AssociatedPr[] =>
    over.map((o, i) => ({ number: i + 1, state: 'open', head: { sha: 'x' }, ...o }));

test('picks the open PR whose head is exactly the trusted sha', () => {
    const data = prs([
        { number: 7, state: 'closed', head: { sha: 'deadbeef' } },
        { number: 9, state: 'open', head: { sha: 'deadbeef' } },
    ]);
    assert.equal(selectPrNumber(data, 'deadbeef'), 9);
});

test('falls back to a non-open PR with the exact sha when none is open', () => {
    const data = prs([{ number: 4, state: 'closed', head: { sha: 'cafe' } }]);
    assert.equal(selectPrNumber(data, 'cafe'), 4);
});

test('returns null when no associated PR has the trusted head sha', () => {
    const data = prs([{ number: 4, state: 'open', head: { sha: 'other' } }]);
    assert.equal(selectPrNumber(data, 'wanted'), null);
});

test('a PR with a different head sha is never selected, even if listed first', () => {
    // Models the attack: a fork commit associated with an unrelated PR must not
    // pull that PR's number — only the exact head_sha match counts.
    const data = prs([
        { number: 1, state: 'open', head: { sha: 'attacker-controlled' } },
        { number: 2, state: 'open', head: { sha: 'trusted-head' } },
    ]);
    assert.equal(selectPrNumber(data, 'trusted-head'), 2);
});

// ── render → post: pr-comment verdict crosses the boundary via the meta ──────

test('writeRenderedComment stamps should_post so the poster can honour pr-comment on fork PRs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-render-'));
    const read = async () =>
        JSON.parse(await fs.readFile(path.join(dir, RENDERED_META_FILE), 'utf8')) as RenderedCommentMeta;

    await writeRenderedComment('body', 'abc1234', dir, false);
    assert.equal((await read()).should_post, false, 'below-threshold render must stamp should_post=false');

    await writeRenderedComment('body', 'abc1234', dir, true);
    assert.equal((await read()).should_post, true, 'at/above-threshold render must stamp should_post=true');
});
