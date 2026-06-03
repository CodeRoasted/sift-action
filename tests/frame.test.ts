// Integration tests for the frame renderer: fixture report.json + a
// SiftCommentContext → the expected comment markdown (sift_action_contract.md
// § 8 / handoff). Covers all four states AND both build-green enhancer variants
// (the two hero headlines). The governed-copy lines are asserted VERBATIM
// against web_copy § "Surface: Sift PR comment"; rows are asserted to appear
// VERBATIM from the engine fixture (never re-authored).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { renderComment, STICKY_MARKER, escapeInline } from '../src/frame';
import { selectState, shouldComment, State } from '../src/verdict';
import type { RankedChange, SiftCommentContext, SiftReport } from '../src/types';

const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function load(name: string): SiftReport {
    return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as SiftReport;
}

const HEAD_SHA = 'abc1234def5678';
const BASE_SHA = 'def4567abc1234';

function ctx(over: Partial<SiftCommentContext> = {}): SiftCommentContext {
    return {
        context_version: '0.1.0',
        head_sha: HEAD_SHA,
        pr_number: 42,
        base_branch: 'main',
        build_status: 'unknown',
        baseline: {
            sha: BASE_SHA,
            run_id: '7654321',
            run_url: 'https://github.com/o/r/actions/runs/7654321',
            branch: 'main',
            created_at: '2026-06-01T09:12:00Z',
        },
        ...over,
    };
}

const HEADER = '### 🔬 Sift — structural diff of your CI logs';

// ── Shared frame (every state) ──────────────────────────────────────────────

test('every comment starts with the hidden sticky marker then the header', () => {
    const out = renderComment(load('drift.json'), ctx());
    assert.ok(out.startsWith(`${STICKY_MARKER}\n${HEADER}`), out.slice(0, 120));
});

test('footer carries determinism + privacy + provenance + as-of stamp (verbatim)', () => {
    const out = renderComment(load('drift.json'), ctx());
    assert.match(
        out,
        /<sub>Deterministic — same inputs, same comment\. Runs in your CI; your logs never leave it\. · \[What is this\?\]\(https:\/\/coderoast\.fr\/sift\) · Baseline: last green run on `main` @ \[`def4567`\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7654321\) · as of `abc1234`<\/sub>/,
    );
});

// ── ① Cold start (no baseline ⇒ no report) ──────────────────────────────────

test('① cold start: state, verbatim copy, base branch substituted, no baseline footnote', () => {
    const coldCtx = ctx({ base_branch: 'develop', baseline: undefined });
    assert.equal(selectState(null), State.ColdStart);
    const out = renderComment(null, coldCtx);
    assert.ok(
        out.includes(
            '🔬 No baseline yet. Sift diffs each run against the last green run on `develop`.\n' +
                'Once one lands, every PR gets a structural diff here — nothing to compare this time.',
        ),
        out,
    );
    assert.ok(!out.includes('Baseline: last green run'), 'cold start must omit the provenance footnote');
    assert.ok(out.includes('as of `abc1234`'));
});

// ── ② Clean ─────────────────────────────────────────────────────────────────

test('② clean with suppression: verbatim copy, the 851→0 pitch, no <details>', () => {
    const report = load('clean_suppressed.json');
    assert.equal(selectState(report), State.Clean);
    const out = renderComment(report, ctx());
    assert.ok(out.includes('✅ No structural change. 12,043 → 12,058 log lines, same behaviour.'), out);
    assert.ok(
        out.includes(
            'Sift weighed 851 surface diffs and dropped all 851 as noise — counts, ordering, IDs that carry no signal.',
        ),
        out,
    );
    assert.ok(!out.includes('<details>'), 'clean state has nothing to drill into');
});

test('② clean (no diffs at all): suppression line is omitted, not "dropped all 0"', () => {
    const report = load('clean_empty.json');
    assert.equal(selectState(report), State.Clean);
    const out = renderComment(report, ctx());
    assert.ok(out.includes('✅ No structural change.'), out);
    assert.ok(!out.includes('dropped all 0'), 'must not read "dropped all 0 as noise"');
    assert.ok(!out.includes('weighed'), out);
});

// ── ③ Drift (significant > 0, no regression) ────────────────────────────────

test('③ drift, build unknown: verbatim headline + rows verbatim + engine <details>', () => {
    const report = load('drift.json');
    assert.equal(selectState(report), State.Drift);
    const significant = report.summary.significant_changes;
    const suppressed = report.summary.total_changes - significant;
    const out = renderComment(report, ctx({ build_status: 'unknown' }));
    assert.ok(
        out.includes(
            `🔍 ${significant} structural changes worth a look — ${suppressed} of ${report.summary.total_changes} diffs are noise.`,
        ),
        out,
    );
    // Rows are the engine's content, verbatim — safely embedded (escapeInline).
    const firstRow = report.ranked_changes[0]!;
    assert.ok(out.includes(`**[${firstRow.severity.toUpperCase()}]** ${escapeInline(firstRow.summary)}`), out);
    // <details> embeds the engine markdown body, safely embedded.
    assert.ok(out.includes(`<details><summary>Full report — ${report.summary.total_changes} changes, ${significant} significant</summary>`), out);
    assert.ok(report.markdown && out.includes(escapeInline(report.markdown)), 'engine markdown body embedded (safely)');
});

test('③ drift, build GREEN: the cache-died hero headline (verbatim)', () => {
    const report = load('drift.json');
    const significant = report.summary.significant_changes;
    const suppressed = report.summary.total_changes - significant;
    const out = renderComment(report, ctx({ build_status: 'green' }));
    assert.ok(
        out.includes(
            "🔍 Green build, changed behaviour. Your tests passed; the shape of your logs didn't.\n" +
                `${significant} changes worth a look, ${suppressed} are noise.`,
        ),
        out,
    );
});

// ── ④ Regression (a row has polarity === regression) ────────────────────────

test('④ regression, build unknown: verbatim headline + regression row carries · regression', () => {
    const report = load('regression.json');
    assert.equal(selectState(report), State.Regression);
    const out = renderComment(report, ctx({ build_status: 'unknown' }));
    assert.ok(
        out.includes("🚨 Regression flagged. A new error-level pattern that wasn't in the baseline:"),
        out,
    );
    // The regression row renders with the F-1 polarity tag and the content (safely embedded).
    const regressionRow = report.ranked_changes.find((row) => row.polarity === 'regression')!;
    assert.ok(
        out.includes(`**[${regressionRow.severity.toUpperCase()} · regression]** ${escapeInline(regressionRow.summary)}`),
        out,
    );
    // A recovery row (the un-grep-able win) also renders its tag.
    const recoveryRow = report.ranked_changes.find((row) => row.polarity === 'recovery');
    if (recoveryRow) {
        assert.ok(out.includes(`· recovery]** ${escapeInline(recoveryRow.summary)}`), out);
    }
});

test('④ regression, build GREEN: the strongest hero headline (founder-locked, verbatim)', () => {
    const report = load('regression.json');
    const out = renderComment(report, ctx({ build_status: 'green' }));
    assert.ok(out.includes('🚨 Green tests. Real regression. It slipped through:'), out);
});

test('④ regression rows come first (engine ranks regressions at the top tier)', () => {
    const report = load('regression.json');
    const out = renderComment(report, ctx());
    const firstRegression = out.indexOf('· regression]');
    const firstRecovery = out.indexOf('· recovery]');
    assert.ok(firstRegression > -1 && (firstRecovery === -1 || firstRegression < firstRecovery), out);
});

// ── Determinism (contract § 4) ──────────────────────────────────────────────

test('the comment body is deterministic: same (report, context) ⇒ same string', () => {
    const report = load('regression.json');
    const c = ctx({ build_status: 'green' });
    assert.equal(renderComment(report, c), renderComment(report, c));
});

// ── Safe embedding (contract § "Comment-embedding safety") ──────────────────
// Engine content (rows + body) derives from CI logs that, on a fork PR, an
// attacker controls. None of it may break the comment STRUCTURE — verbatim
// content, safely embedded.

// A row summary + body carrying every named vector: a </details> breakout, a raw
// HTML tag, a code fence, a table pipe, an ampersand, a <host>-style token, plus
// a markdown link and image (the bot-comment phishing surface, contract §6.1).
const PHISH_LINK = '[click to verify](https://evil.example/phish)';
const PHISH_IMAGE = '![](https://tracker.example/p.png)';
function maliciousReport(): SiftReport {
    const attack =
        `New error: "</details><script>alert(1)</script> \`\`\` | x & <host> ${PHISH_LINK} ${PHISH_IMAGE}" — 9.0% of changed`;
    const row: RankedChange = {
        kind: 'new_error_pattern',
        severity: 'high',
        significance: 0.9,
        summary: attack,
        polarity: 'regression',
    };
    return {
        report_version: '0.1.0',
        summary: { total_changes: 10, significant_changes: 1 },
        ranked_changes: [row],
        inputs: {
            baseline: { label: 'a', lines_observed: 100, unique_templates: 5 },
            changed: { label: 'b', lines_observed: 100, unique_templates: 5 },
        },
        // The engine's own structure (#, **, lists) plus injected breakout content.
        markdown: `# Sift\n\n## Significant changes\n\n1. **[HIGH · regression]** ${attack}\n\n</details>\n\`\`\`\ntext after an unclosed fence\n`,
    };
}

test('safe embedding: content cannot break out of the <details> block', () => {
    const out = renderComment(maliciousReport(), ctx());
    // Exactly ONE real <details> and </details> — the frame's own. The content's
    // </details> (in the row AND the body) are escaped, so they do not count.
    assert.equal((out.match(/<details>/g) ?? []).length, 1, out);
    assert.equal((out.match(/<\/details>/g) ?? []).length, 1, out);
    // The footer renders after the body — proof a fence/tag in the body did not
    // swallow the trailing </details> + footer.
    assert.ok(out.trimEnd().endsWith('</sub>'), out);
});

test('safe embedding: HTML/backtick/pipe render inert, content survives as escaped text', () => {
    const out = renderComment(maliciousReport(), ctx());
    assert.ok(!out.includes('<script>'), 'no raw <script> tag survives');
    assert.ok(out.includes('&lt;script&gt;'), 'the script tag survives as escaped, inert text');
    assert.ok(out.includes('&lt;/details&gt;'), 'the content </details> survives as escaped text');
    assert.ok(out.includes('&lt;host&gt;'), 'the <host> token is shown, not eaten as a phantom tag');
    assert.ok(out.includes('&#96;'), 'backticks are inert (no code fence/span)');
    assert.ok(out.includes('&#124;'), 'pipes are inert (no table cell)');
    assert.ok(out.includes('&amp;'), 'ampersands are escaped');
});

test('safe embedding: markdown link/image syntax is neutralized (no phishing under the bot)', () => {
    const out = renderComment(maliciousReport(), ctx());
    // Neither the link's `](url)` bridge nor the image's `![](url)` can parse —
    // the brackets/parens are entity-encoded, so no hidden-destination link or
    // auto-loading tracking pixel renders under our bot's identity.
    assert.ok(!out.includes('](https://evil.example/phish)'), 'no parseable link bridge survives');
    assert.ok(!out.includes('![](https://tracker.example/p.png)'), 'no parseable image survives');
    assert.ok(out.includes('&#91;') && out.includes('&#93;'), 'square brackets are inert');
    assert.ok(out.includes('&#40;') && out.includes('&#41;'), 'parens are inert');
    // Content is preserved — the URL still SHOWS as inert text. The visible href
    // is the proof there is no deceptive hidden destination.
    assert.ok(out.includes('https://evil.example/phish'), 'the URL survives as visible, inert text');
    // The frame's OWN links (footer "What is this?" + provenance) are trusted and
    // composed raw, so they stay live — neutralization touches only engine content.
    assert.ok(out.includes('[What is this?](https://coderoast.fr/sift)'), 'frame links stay live');
});

// ── Push mode: the renderer must not depend on pr_number (contract § 3) ─────

test('push context (no pr_number) renders identically — the frame never reads pr_number', () => {
    const report = load('drift.json');
    const withPr = renderComment(report, ctx({ pr_number: 42 }));
    const withoutPr = renderComment(report, ctx({ pr_number: undefined }));
    assert.equal(
        withoutPr,
        withPr,
        'render must be independent of pr_number so push mode (no PR) reuses the same body',
    );
});

// ── Comment threshold per surface — never|regression|significant|always (contract § 3) ──

test('shouldComment honours each level; only `always` fires on clean / cold-start', () => {
    const all = [State.ColdStart, State.Clean, State.Drift, State.Regression];
    // never: off everywhere
    for (const s of all) assert.equal(shouldComment(s, 'never'), false, `never must not comment (${s})`);
    // always: every state — incl. the green "✅ no change" reassurance and cold start
    for (const s of all) assert.equal(shouldComment(s, 'always'), true, `always must comment (${s})`);
    // significant: drift OR regression — never clean / cold-start
    assert.equal(shouldComment(State.ColdStart, 'significant'), false);
    assert.equal(shouldComment(State.Clean, 'significant'), false, 'clean is not "notable" — no noise');
    assert.equal(shouldComment(State.Drift, 'significant'), true);
    assert.equal(shouldComment(State.Regression, 'significant'), true);
    // regression: only a flagged regression
    assert.equal(shouldComment(State.Clean, 'regression'), false);
    assert.equal(shouldComment(State.Drift, 'regression'), false, 'drift alone is below the regression bar');
    assert.equal(shouldComment(State.Regression, 'regression'), true);
});
