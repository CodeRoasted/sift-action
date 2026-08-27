// Integration tests for the frame renderer: fixture report.json + a
// SiftCommentContext → the expected comment markdown (bibles/sift_action.md
// § 8 / handoff). Covers all four states AND both verdict variants of the hero
// headlines — the "green" predicate is the ENGINE-resolved `summary.changed_outcome`
// (ADR-17.D5), never a context flag. The governed-copy lines are asserted VERBATIM
// against PRD-6 § "Surface: Sift PR comment"; rows are asserted to appear
// VERBATIM from the engine fixture (never re-authored).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderComment, STICKY_MARKER, escapeInline } from '../src/frame.js';
import { polarityGlyph, severityGlyph } from '../src/glyph.js';
import { selectState, shouldComment, State } from '../src/verdict.js';
import type { RankedChange, SiftCommentContext, SiftReport } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function load(name: string): SiftReport {
    return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as SiftReport;
}

const HEAD_SHA = 'abc1234def5678';
const BASE_SHA = 'def4567abc1234';

function ctx(over: Partial<SiftCommentContext> = {}): SiftCommentContext {
    return {
        context_version: '0.2.0',
        head_sha: HEAD_SHA,
        pr_number: 42,
        base_branch: 'main',
        baseline: {
            kind: 'run',
            sha: BASE_SHA,
            run_id: '7654321',
            run_url: 'https://github.com/o/r/actions/runs/7654321',
            branch: 'main',
            created_at: '2026-06-01T09:12:00Z',
        },
        ...over,
    };
}

// Stamp the engine-resolved run verdicts onto a fixture report (the fixtures are
// outcome-free = Unknown; the wire omits the fields).
function withOutcomes(
    report: SiftReport,
    outcomes: Partial<Pick<SiftReport['summary'], 'baseline_outcome' | 'changed_outcome' | 'outcome_regressed'>>,
): SiftReport {
    return { ...report, summary: { ...report.summary, ...outcomes } };
}

const HEADER = '### 🔬 Sift — structural diff of your CI logs';

// The <details> embed SLOT — the exact span `renderDetails` fills with the engine's
// body. Extracted rather than searched, for two reasons an `out.includes(...)` cannot
// reach: an arm can state what the slot holds EXACTLY (nothing dropped, nothing
// appended, nothing else in it), and a "this must not survive RAW" check cannot be
// satisfied by the frame's own trusted `</details>` closing tag sitting outside it.
//
// It is anchored on the FULL REPORT's own <summary> line, not on the first `</summary>`
// in the comment: the severity sections are <details> blocks too and they come first,
// so a positional anchor would silently extract a section's rows and every arm below
// would then hold a claim about the wrong block.
const FULL_REPORT_OPEN = '<details><summary>Full report — ';
const SLOT_OPEN = '</summary>\n\n';
const SLOT_CLOSE = '\n\n</details>';
function fullReportAt(out: string): number {
    const at = out.indexOf(FULL_REPORT_OPEN);
    assert.ok(at >= 0, `no full-report <details> in the comment:\n${out}`);
    return at;
}
function detailsBody(out: string): string {
    const open = out.indexOf(SLOT_OPEN, fullReportAt(out));
    assert.ok(open >= 0, `no <details> slot in the comment:\n${out}`);
    const start = open + SLOT_OPEN.length;
    const end = out.indexOf(SLOT_CLOSE, start);
    assert.ok(end >= start, `unterminated <details> slot:\n${out}`);
    return out.slice(start, end);
}

// The severity-section heading the frame composes for `severity` holding `count` rows.
// `disclosed` selects the open spelling — the hottest section ships disclosed, every
// other section collapsed (asserted on its own below).
function sectionHeading(severity: string, count: number, disclosed = false): string {
    const noun = count === 1 ? 'change' : 'changes';
    const tag = disclosed ? '<details open>' : '<details>';
    return `${tag}<summary>${severityGlyph(severity)} <b>${severity.toUpperCase()}</b> — ${count} ${noun}</summary>`;
}

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

test('③ drift, verdict unknown: verbatim headline + rows verbatim + engine <details>', () => {
    const report = load('drift.json'); // outcome-free fixture = Unknown verdict
    assert.equal(selectState(report), State.Drift);
    const significant = report.summary.significant_changes;
    const suppressed = report.summary.total_changes - significant;
    const out = renderComment(report, ctx());
    assert.ok(
        out.includes(
            `🔍 ${significant} structural changes worth a look — ${suppressed} of ${report.summary.total_changes} diffs are noise.`,
        ),
        out,
    );
    // Rows are the engine's content, verbatim — safely embedded (escapeInline). A
    // neutral-polarity row is now the summary ALONE behind its ordinal: the severity
    // rides the section heading and the row carries no badge of its own.
    const firstRow = report.ranked_changes[0]!;
    assert.ok(out.includes(`1. ${escapeInline(firstRow.summary)}`), out);
    assert.ok(out.includes(sectionHeading(firstRow.severity, report.ranked_changes.length, true)), out);
    // <details> embeds the engine markdown body.
    assert.ok(out.includes(`<details><summary>Full report — ${report.summary.total_changes} changes, ${significant} significant</summary>`), out);
    // COMPLETENESS, and only completeness. Equality on the slot, not `includes`, so a
    // truncation, a dropped line or an interpolated extra is all visible — measured:
    // dropping the body's first line reds this arm and NOTHING else in the suite, which
    // is why it is repaired rather than replaced.
    //
    // What it deliberately does NOT prove is the ESCAPING. Its expectation is computed
    // by calling the transform under test, so it is green for every definition of
    // `escapeInline`, correct or not — measured: entity-encoding `•` inside
    // `escapeInline` leaves the whole suite green, and collapsing space runs leaves
    // this arm green. Read as a safety guarantee it is a mirror; read as an embed-site
    // arm it holds a property nothing else does. The transform's own table is pinned by
    // hand below ("escapeInline: each declared substitution"); the body's USE of that
    // table by "the <details> BODY rides escapeInline".
    const markdown = report.markdown ?? '';
    assert.notEqual(markdown, '', 'fixture must carry a body, else the embed claim is vacuously true');
    assert.equal(
        detailsBody(out),
        escapeInline(markdown),
        'the engine body must arrive whole and alone in the <details> slot',
    );
});

test('③ drift, verdict SUCCESS: the cache-died hero headline (verbatim)', () => {
    const report = withOutcomes(load('drift.json'), {
        baseline_outcome: 'SUCCESS',
        changed_outcome: 'SUCCESS',
    });
    const significant = report.summary.significant_changes;
    const suppressed = report.summary.total_changes - significant;
    const out = renderComment(report, ctx());
    assert.ok(
        out.includes(
            "🔍 Green build, changed behaviour. Your tests passed; the shape of your logs didn't.\n" +
                `${significant} changes worth a look, ${suppressed} are noise.`,
        ),
        out,
    );
});

// ── ③ bis — the suppression gap at CENSUS-ERA numbers (DN-37.D31) ───────────
//
// Until `total_changes` was restored as the pre-cut census, the aligned spine — the
// one THIS Action consumes, via the CLI's `diff_logs_aligned` — assigned
// `significant_changes` into `total_changes`. So on real bytes the gap was a
// structural zero and this headline printed "0 of 22 diffs are noise": the
// suppression half of the pitch was dead output. Measured after the restore, same
// pair: total 973, significant 22.
//
// The two drift arms above compute their expectation as `total - significant`, which
// is the render's own formula — they hold the SHAPE of the sentence and are green for
// any arithmetic, right or wrong. This arm pins LITERALS at the measured numbers, and
// pins the other side of the boundary with them: the same fixture at significant ===
// total must print the zero-gap sentence. One of the two strings is wrong the moment
// the subtraction, the grouping or the census itself moves, and neither can be
// satisfied by printing a constant.
test('③ drift: the census-era gap renders literally, and the zero-gap boundary with it', () => {
    const base = load('drift.json');
    const at = (total: number, significant: number): SiftReport => ({
        ...base,
        summary: { ...base.summary, total_changes: total, significant_changes: significant },
    });

    // The measured post-restore pair. 973 − 22 = 951, three digits, ungrouped.
    assert.ok(
        renderComment(at(973, 22), ctx()).includes(
            '🔍 22 structural changes worth a look — 951 of 973 diffs are noise.',
        ),
        renderComment(at(973, 22), ctx()),
    );

    // The pre-restore shape, which is what a regression of DN-37.D31 would print again.
    assert.ok(
        renderComment(at(22, 22), ctx()).includes(
            '🔍 22 structural changes worth a look — 0 of 22 diffs are noise.',
        ),
        renderComment(at(22, 22), ctx()),
    );

    // The census routinely clears a thousand on a real CI log, and the suppressed value
    // rides `groupThousands` at a call site no fixture has ever pushed past three digits
    // (the function's comma path is proven elsewhere, on line counts — this pins the SITE).
    assert.ok(
        renderComment(at(12043, 22), ctx()).includes(
            '🔍 22 structural changes worth a look — 12,021 of 12,043 diffs are noise.',
        ),
        renderComment(at(12043, 22), ctx()),
    );
});

// The invariant `significant <= total` is the ENGINE's, asserted where each spine
// finalizes its summary and deliberately NOWHERE downstream (DN-37.D31: a defensive
// clamp at a render site converts an invariant break into a plausible number). This
// arm does not re-litigate that ruling — it CHARACTERIZES what this surface does if
// the invariant is ever breached upstream, because the answer differs from the two
// unsigned C++ render sites by construction: a JS number is a double, so the
// subtraction yields a visible negative and never the ~1.8e19 an unsigned wrap
// produces. Visibly wrong, not plausibly wrong — which is why no clamp is owed here
// either, and the reason is a language fact worth pinning rather than assuming.
test('a breached census invariant surfaces as a visible negative, never a wrapped magnitude', () => {
    const base = load('drift.json');
    const breached: SiftReport = {
        ...base,
        summary: { ...base.summary, total_changes: 22, significant_changes: 973 },
    };
    const out = renderComment(breached, ctx());
    assert.ok(out.includes('-951 of 22 diffs are noise.'), out);
    assert.ok(!/\d{15,}/.test(out), `an unsigned-wrap-sized magnitude reached the comment:\n${out}`);
});

// ── ④ Regression (a row has polarity === regression) ────────────────────────

test('④ regression, verdict unknown: verbatim headline + regression row carries · regression', () => {
    const report = load('regression.json');
    assert.equal(selectState(report), State.Regression);
    const out = renderComment(report, ctx());
    assert.ok(
        out.includes("🚨 Regression flagged. A new error-level pattern that wasn't in the baseline:"),
        out,
    );
    // The regression row renders with the F-1 polarity tag and the content (safely
    // embedded). The tag is polarity ALONE — severity moved to the section heading.
    const regressionRow = report.ranked_changes.find((row) => row.polarity === 'regression')!;
    assert.ok(
        out.includes(`**[regression]** ${escapeInline(regressionRow.summary)}`),
        out,
    );
    // A recovery row (the un-grep-able win) also renders its tag.
    const recoveryRow = report.ranked_changes.find((row) => row.polarity === 'recovery');
    if (recoveryRow) {
        assert.ok(out.includes(`**[recovery]** ${escapeInline(recoveryRow.summary)}`), out);
    }
});

test('④ two independent axes, at two altitudes: heat on the SECTION, green circle on the ROW', () => {
    // §B.4 (PRD-6 § "Badge glyphs"): severity = a heat square; recovery = a green circle,
    // and the two must never collapse into a git red/green diff. Since the rows are grouped
    // by severity the square rides the SECTION heading (once) and the circle rides the ROW —
    // the heat axis is not lost, so a HIGH recovery and a LOW recovery still differ.
    const report = load('regression.json');
    const out = renderComment(report, ctx());
    const recoveryRow = report.ranked_changes.find((row) => row.polarity === 'recovery')!;
    const regressionRow = report.ranked_changes.find((row) => row.polarity === 'regression')!;

    const recSquare = severityGlyph(recoveryRow.severity);
    // The severity glyph is a heat SQUARE (not a circle), and it sits on the heading.
    assert.ok(['🟥', '🟧', '🟨', '🟦'].includes(recSquare), `severity must be a heat square: ${recSquare}`);
    assert.ok(out.includes(`<summary>${recSquare} <b>${recoveryRow.severity.toUpperCase()}</b>`), out);

    // The recovery ROW carries the green circle, and only the recovery row.
    assert.equal(polarityGlyph(recoveryRow.polarity), '🟢', 'recovery = the green circle');
    assert.ok(out.includes(`🟢 **[recovery]** ${escapeInline(recoveryRow.summary)}`), out);
    assert.equal((out.match(/🟢/g) ?? []).length, 1, `exactly one green circle, on the recovery row:\n${out}`);

    // A regression rides the section's hot square + the word ALONE — no circle, never green.
    assert.equal(polarityGlyph(regressionRow.polarity), '', 'regression = no circle');
    assert.ok(out.includes(`**[regression]** ${escapeInline(regressionRow.summary)}`), out);

    // The heat square is stated ONCE, on the heading — never repeated per row. Both
    // fixture rows are `high`, so a surviving per-row square would show up twice.
    assert.equal((out.match(new RegExp(recSquare, 'g')) ?? []).length, 1, out);
});

// WHERE attribution (SRC-D-WHERE-7): the functional location renders as inline code
// after the summary, composing with the badge. Engine CONTENT → escapeInline.
function whereReport(where: string): SiftReport {
    const row: RankedChange = {
        kind: 'new_error_pattern',
        severity: 'high',
        significance: 0.9,
        summary: 'new error appeared',
        polarity: 'regression',
        where,
    };
    return {
        report_version: '0.1.0',
        summary: { total_changes: 1, significant_changes: 1 },
        ranked_changes: [row],
        inputs: {
            baseline: { label: 'a', lines_observed: 100, unique_templates: 5 },
            changed: { label: 'b', lines_observed: 100, unique_templates: 5 },
        },
    };
}

test('a row WHERE renders as inline code after the summary', () => {
    const out = renderComment(whereReport('src/auth'), ctx());
    assert.ok(out.includes('· in `src/auth`'), out);
});

test('a forged WHERE is escapeInline-defanged (no HTML / inline-code breakout)', () => {
    const attack = '`</details><script>alert(1)</script>';
    const out = renderComment(whereReport(attack), ctx());
    assert.ok(!out.includes('<script>'), out); // HTML escaped
    assert.ok(out.includes(escapeInline(attack)), out); // the WHERE rode escapeInline
});

test('④ regression, verdict SUCCESS: the strongest hero headline (founder-locked, verbatim)', () => {
    const report = withOutcomes(load('regression.json'), { changed_outcome: 'SUCCESS' });
    const out = renderComment(report, ctx());
    assert.ok(out.includes('🚨 Green tests. Real regression. It slipped through:'), out);
});

// ── ④bis Run-verdict regression (ADR-17.D5 — UNSTABLE never folds) ───────────

test('④ a pure verdict regression (SUCCESS → UNSTABLE, zero rows) is Regression, not Clean', () => {
    // Steady templates, worse verdict: the engine emits outcome_regressed with no
    // regression row and possibly zero significant changes.
    const report = withOutcomes(load('clean_suppressed.json'), {
        baseline_outcome: 'SUCCESS',
        changed_outcome: 'UNSTABLE',
        outcome_regressed: true,
    });
    assert.equal(selectState(report), State.Regression, 'outcome_regressed must be loud, never ✅');
    const out = renderComment(report, ctx());
    assert.ok(out.includes('🚨 Run verdict regressed: **SUCCESS → UNSTABLE**.'), out);
    assert.ok(!out.includes('✅ No structural change'), out);
    // Zero ranked rows ⇒ no empty rows block; the <details> body still renders.
    assert.ok(out.includes('<details>'), out);
});

test('④ an outcome regression alongside structural rows keeps the verdict-led headline', () => {
    const report = withOutcomes(load('drift.json'), {
        baseline_outcome: 'SUCCESS',
        changed_outcome: 'FAILURE',
        outcome_regressed: true,
    });
    assert.equal(selectState(report), State.Regression);
    const out = renderComment(report, ctx());
    assert.ok(out.includes('🚨 Run verdict regressed: **SUCCESS → FAILURE**.'), out);
});

test('recovery (FAILURE → SUCCESS) is NOT a regression — outcome_regressed absent', () => {
    const report = withOutcomes(load('drift.json'), {
        baseline_outcome: 'FAILURE',
        changed_outcome: 'SUCCESS',
    });
    assert.equal(selectState(report), State.Drift, 'a recovery must not alarm');
});

test('④ the engine ranking survives grouping: a regression precedes a recovery in its section', () => {
    // Grouping reorders NOTHING inside a section — it partitions the already-ranked list
    // and keeps each part in the engine's own order. Both fixture rows are `high`, so they
    // land in one section and their relative order is directly observable.
    const report = load('regression.json');
    const out = renderComment(report, ctx());
    const firstRegression = out.indexOf('**[regression]**');
    const firstRecovery = out.indexOf('**[recovery]**');
    assert.ok(firstRegression > -1 && (firstRecovery === -1 || firstRegression < firstRecovery), out);
    assert.ok(out.includes('1. **[regression]**'), out);
});

// ── Severity sections (the triage layout) ───────────────────────────────────
//
// The ranked rows are partitioned into ONE collapsible <details> per severity,
// hottest first, with the heat badge stated once on the section heading. It is
// FRAMING only: no row's text is re-authored, and the engine's ranking survives
// inside each section (asserted in the ④ arm above).

// Sections in the order the frame must emit them, whatever order the rows arrive in.
const LADDER = ['critical', 'high', 'medium', 'low'];

test('sections run hottest-first, and that order is NOT the engine\'s row order', () => {
    const report = load('multi_severity.json');
    const out = renderComment(report, ctx());

    // The fixture's rows arrive critical, medium, high, low, medium — so an identity
    // "group in first-appearance order" would put MEDIUM before HIGH, and an inverted
    // ladder would put LOW first. Both are red here; only the ruled order passes.
    const engineOrder = report.ranked_changes.map((row) => row.severity);
    assert.deepEqual(
        engineOrder,
        ['critical', 'medium', 'high', 'low', 'medium'],
        'the fixture must arrive OUT of ladder order, else this arm cannot see the sort',
    );

    const at = LADDER.map((severity) => {
        const index = out.indexOf(`<b>${severity.toUpperCase()}</b>`);
        assert.ok(index > -1, `no ${severity.toUpperCase()} section in:\n${out}`);
        return index;
    });
    for (let i = 1; i < at.length; i += 1) {
        assert.ok(
            at[i - 1]! < at[i]!,
            `${LADDER[i - 1]!.toUpperCase()} must precede ${LADDER[i]!.toUpperCase()} — got offsets ` +
                `${at[i - 1]} and ${at[i]} in:\n${out}`,
        );
    }
});

test('one badge per section: the heading carries severity, no row repeats it', () => {
    const report = load('multi_severity.json');
    const out = renderComment(report, ctx());
    const inline = out.slice(0, fullReportAt(out)); // the row block, not the engine body

    // Counts, per severity: exactly one heading, exactly one heat square, and the
    // per-row chip the old layout printed (`**[HIGH]**`, `**[HIGH · recovery]**`) gone.
    for (const severity of LADDER) {
        const rows = report.ranked_changes.filter((row) => row.severity === severity);
        assert.ok(rows.length > 0, `fixture must exercise ${severity}`);
        assert.equal(
            (inline.match(new RegExp(sectionHeading(severity, rows.length, severity === LADDER[0]).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'), 'g')) ?? []).length,
            1,
            `${severity}: one heading, with its own count:\n${inline}`,
        );
        assert.equal(
            (inline.match(new RegExp(severityGlyph(severity), 'g')) ?? []).length,
            1,
            `${severity}: the heat square is stated once, on the heading:\n${inline}`,
        );
        assert.ok(
            !inline.includes(`**[${severity.toUpperCase()}]**`) &&
                !inline.includes(`**[${severity.toUpperCase()} · `),
            `${severity}: a row still repeats the severity chip:\n${inline}`,
        );
    }

    // What a row DOES keep is the axis the heading cannot carry — its direction.
    assert.ok(inline.includes('**[regression]**'), inline);
    assert.ok(inline.includes('🟢 **[recovery]**'), inline);
});

test('the HOTTEST section is disclosed, exactly one, and everything below it is collapsed', () => {
    // The affordance is the full report's own disclosure triangle for every section; what
    // differs is the STARTING state, and only for index 0. The reason is the product's
    // contract, not taste: the governed headline copy ends in a colon, so an all-collapsed
    // comment opens with a sentence pointing at nothing — the incident must be readable at
    // the top. Below index 0, and for the full report, collapsed is the shipped state.
    const report = load('multi_severity.json');
    const out = renderComment(report, ctx());
    const severities = new Set(report.ranked_changes.map((row) => row.severity));
    assert.equal(severities.size, 4, 'fixture must span four severities');

    // One <details> per section plus the full report's, opening and closing balanced —
    // counted across BOTH spellings, so an `open` block still counts as a block.
    const opens = out.match(/<details(?: open)?>/g) ?? [];
    assert.equal(opens.length, severities.size + 1, out);
    assert.equal((out.match(/<\/details>/g) ?? []).length, severities.size + 1, out);

    // EXACTLY ONE is disclosed. Two arms, and they fail for different reasons: the count
    // reds if the open state spreads (or is lost), and the position reds if the ladder
    // sort inverts under it — which would disclose the COOLEST section, a strictly worse
    // failure than a merely reordered list, because the comment would then open on the
    // least urgent finding while the worst one hides.
    assert.equal(opens.filter((tag) => tag === '<details open>').length, 1, `exactly one disclosed section:\n${out}`);
    assert.equal(opens[0], '<details open>', `the DISCLOSED block must be the first one:\n${out}`);
    assert.ok(
        out.startsWith(`${STICKY_MARKER}\n${HEADER}`) &&
            out.indexOf('<details open>') < out.indexOf('<details>'),
        `a collapsed block precedes the disclosed one:\n${out}`,
    );
    // Named, not just positional: the disclosed block is CRITICAL's on this fixture,
    // which is the hottest severity present.
    assert.ok(
        out.includes(`<details open><summary>${severityGlyph('critical')} <b>CRITICAL</b>`),
        `the hottest section is not the disclosed one:\n${out}`,
    );
    // The full report stays collapsed — this pass did not touch it.
    assert.ok(out.includes(`\n\n${FULL_REPORT_OPEN}`), `the full report must stay collapsed:\n${out}`);

    // A blank line follows each <summary> — without it GitHub renders the markdown list
    // inside the block as literal text, which would silently flatten every row.
    assert.equal(
        (out.match(/<\/summary>\n\n/g) ?? []).length,
        severities.size + 1,
        `a block is missing the blank line that makes its markdown render:\n${out}`,
    );
});

test('the disclosed section is the HOTTEST, not the first the engine happened to rank', () => {
    // The arm above cannot see this, and the reason is worth stating rather than assuming:
    // on `multi_severity.json` the engine ranks the CRITICAL regression first, so dropping
    // the ladder sort leaves CRITICAL at index 0 and the right section is still disclosed
    // by accident. Measured — removing the sort reds two other arms and NOT that one.
    //
    // So this arm inverts the input: the engine's own order runs coolest-first. With the
    // sort, CRITICAL is disclosed; without it, LOW is — and the comment would then open on
    // the least urgent finding while the incident hides behind a closed triangle. That is a
    // strictly worse failure than a merely reordered list, which is why it gets its own arm.
    const base = load('multi_severity.json');
    const coolestFirst: RankedChange[] = [
        { kind: 'frequency_shift', severity: 'low', significance: 0.1, summary: 'Frequency shift: "INFO warming pool" 1.0% → 2.0%' },
        { kind: 'frequency_shift', severity: 'medium', significance: 0.4, summary: 'Frequency shift: "INFO restore deps" — 6.2x slower' },
        { kind: 'new_error_pattern', severity: 'critical', significance: 0.9, polarity: 'regression', summary: 'New error: "ERROR gateway: upstream timed out" — 0 -> 214' },
    ];
    const out = renderComment({ ...base, ranked_changes: coolestFirst }, ctx());

    assert.ok(
        out.includes(`<details open><summary>${severityGlyph('critical')} <b>CRITICAL</b>`),
        `CRITICAL must be the disclosed section even though the engine ranked it LAST — ` +
            `the ladder decides disclosure, not arrival order:\n${out}`,
    );
    assert.ok(
        out.includes(`<details><summary>${severityGlyph('low')} <b>LOW</b>`),
        `LOW arrived first and must still ship COLLAPSED:\n${out}`,
    );
    assert.equal(
        (out.match(/<details open>/g) ?? []).length,
        1,
        `exactly one disclosed section:\n${out}`,
    );
});

test('rows are numbered inside their own section, in the engine\'s order', () => {
    const report = load('multi_severity.json');
    const out = renderComment(report, ctx());
    // MEDIUM holds two rows: the ordinals restart at 1 per section, and the two keep
    // the order the engine ranked them in (cache-restored first, dependencies second).
    const medium = report.ranked_changes.filter((row) => row.severity === 'medium');
    assert.equal(medium.length, 2);
    assert.ok(out.includes(`1. ${escapeInline(medium[0]!.summary)}`), out);
    assert.ok(out.includes(`2. ${escapeInline(medium[1]!.summary)}`), out);
    // …and the CRITICAL section's single row is `1.`, not `3.` — the numbering is
    // per-section, not a global counter carried across the blocks.
    assert.ok(out.includes('1. **[regression]** New error:'), out);
});

test('a severity outside the ladder gets its OWN section after LOW — never folded into it', () => {
    // A tier the frame does not know must surface as itself: folding it into `low`
    // would print a heat badge the engine never claimed. It sorts after the known
    // ladder (unknown heat is not a promotion) and keeps its own name.
    const base = load('multi_severity.json');
    const exotic: RankedChange = {
        kind: 'frequency_shift',
        severity: 'blocker',
        significance: 0.5,
        summary: 'Frequency shift: "INFO warming pool" 1.0% → 9.0%',
    };
    const report: SiftReport = { ...base, ranked_changes: [exotic, ...base.ranked_changes] };
    const out = renderComment(report, ctx());
    assert.ok(out.includes('<b>BLOCKER</b> — 1 change'), out);
    assert.ok(out.indexOf('<b>LOW</b>') < out.indexOf('<b>BLOCKER</b>'), out);
    assert.ok(out.includes(escapeInline(exotic.summary)), 'the unknown-tier row must still render');
});

test('the inline cap stays GLOBAL: the remainder notice sits outside every section', () => {
    // The cap bounds the comment, not each section: it takes the top N of the RANKED
    // list and the notice that follows belongs to no severity. A per-section cap would
    // let 4 severities carry 4N rows, which is the bloat the cap exists to prevent.
    const base = load('multi_severity.json');
    const many: RankedChange[] = Array.from({ length: 26 }, (_, i) => ({
        kind: 'frequency_shift',
        severity: i % 2 === 0 ? 'high' : 'low',
        significance: 0.5,
        summary: `Frequency shift: "INFO step ${i}" 1.0% → 9.0%`,
    }));
    const out = renderComment({ ...base, ranked_changes: many }, ctx());
    // 26 rows, 20 shown ⇒ 6 in the remainder; 10 high + 10 low among the first 20.
    assert.ok(out.includes('_…and 6 more — see the full report below._'), out);
    assert.ok(out.includes('<b>HIGH</b> — 10 changes'), out);
    assert.ok(out.includes('<b>LOW</b> — 10 changes'), out);
    // Outside: the notice follows the last section's close, and precedes the full report.
    const noticeAt = out.indexOf('_…and 6 more');
    assert.ok(out.lastIndexOf('</details>', noticeAt) > -1, out);
    assert.ok(noticeAt < fullReportAt(out), 'the notice must sit above the full report');
    assert.ok(!out.includes('"INFO step 20"'), 'a capped-out row leaked into a section');
});

// ── Determinism (contract § 4) ──────────────────────────────────────────────

test('the comment body is deterministic: same (report, context) ⇒ same string', () => {
    const report = withOutcomes(load('regression.json'), { changed_outcome: 'SUCCESS' });
    const c = ctx();
    assert.equal(renderComment(report, c), renderComment(report, c));
});

// ── The escape table itself (the trust boundary's own contract) ─────────────
//
// `escapeInline` is the single transform standing between fork-attacker-controlled CI
// log text and the rendered comment. Every arm below it — and every row/body embed arm
// above — reads it as a given, so it needs pins whose expectation is written BY HAND
// from the table declared in frame.ts, never re-derived by calling it. An expectation
// computed as `escapeInline(x)` is satisfied by ANY definition of `escapeInline`,
// including a broken one; that is the shape this section exists to replace.
//
// Exact equality, not `includes`: the claim is that the table is EXACTLY these
// substitutions and that nothing else in the string moves. `includes` can only see a
// rule that vanished — equality also sees a rule that APPEARED, and an appeared rule
// contradicts the boundary's stated invariant ("each escape maps to the entity that
// displays the same character, inert") even when it is display-identical.

// Input → the output a reader of frame.ts's table can predict without running it.
// `&` is substituted FIRST, which the tag and literal-entity rows pin: were it applied
// last, `<` would double-escape and `&lt;` would read back as `&amp;lt;`.
const ESCAPE_TABLE: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
    ['ampersand', 'a & b', 'a &amp; b'],
    ['html tags — the </details> breakout', '</details><script>', '&lt;/details&gt;&lt;script&gt;'],
    ['a literal entity is shown, not decoded', '&lt;', '&amp;lt;'],
    ['backtick — code fence and inline span', '``` `x`', '&#96;&#96;&#96; &#96;x&#96;'],
    ['pipe — table cell', 'a | b', 'a &#124; b'],
    ['link — hidden destination', '[click](https://evil.example/p)', '&#91;click&#93;&#40;https://evil.example/p&#41;'],
    ['image — auto-loading pixel', '![alt](https://t.example/p.png)', '!&#91;alt&#93;&#40;https://t.example/p.png&#41;'],
];

test('escapeInline: each declared substitution, against a hand-written expectation', () => {
    for (const [name, input, expected] of ESCAPE_TABLE) {
        assert.equal(escapeInline(input), expected, `${name} — input ${JSON.stringify(input)}`);
    }
});

test('escapeInline leaves the engine\'s markdown formatting alone', () => {
    // The other half of the contract, load-bearing in the opposite direction: the
    // engine's block formatting must SURVIVE (frame.ts — "the body's headers/bold/
    // bullets survive intact"), which is what keeps the collapsed report readable.
    // Identity here is a property, not a tautology: it is exactly what fails the day
    // someone reaches for a general-purpose markdown escaper.
    const formatting = '# Sift\n\n## Significant changes\n\n**bold** _under_ *em*\n\n- item\n1. numbered\n';
    assert.equal(escapeInline(formatting), formatting, `formatting must pass through: ${JSON.stringify(formatting)}`);
});

test('escapeInline preserves whitespace runs and the evidence glyphs byte-for-byte', () => {
    // The shape the <details> body carries an evidence sub-bullet in: a three-space
    // indent, `-`, then `•` / `…`. Identity over the whole span, so a lossy tidy-up
    // (collapsing space runs) and a new entity rule (`•` → `&#8226;`) each red HERE,
    // at the transform, naming the transform.
    //
    // ⚠ This is deliberately the OPPOSITE choice from the evidence arm at the foot of
    // this file, which keeps both its needles ASCII precisely so a new entity rule does
    // NOT red it. Not a contradiction — the division of labour. `&#8226;` displays as
    // `•`, so a reader loses nothing and that arm must not be weakened over it; but the
    // table is a security contract, so GROWING it is a decision to ratify, never a
    // drive-by. A red here means "the table changed": widen this expectation on
    // purpose, and never by reaching for the arm that was written not to see it.
    const evidence = '   -   • build / bravo: the linker refused\n   -   • … and 7 more\n';
    assert.equal(escapeInline(evidence), evidence, `evidence span must pass through: ${JSON.stringify(evidence)}`);
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
    const report = maliciousReport();
    const out = renderComment(report, ctx());
    // Exactly as many real <details>/</details> as the frame itself composes — one per
    // severity section plus the full report — and the two counts agree. Both spellings are
    // counted: the hottest section ships disclosed (`<details open>`) and is still a block.
    // The content's </details> (in the row AND the body) are escaped, so they do not count;
    // a single unescaped one would break the balance.
    const sections = new Set(report.ranked_changes.map((row) => row.severity.toLowerCase())).size;
    assert.equal((out.match(/<details(?: open)?>/g) ?? []).length, sections + 1, out);
    assert.equal((out.match(/<\/details>/g) ?? []).length, sections + 1, out);
    // The frame's own trailer is the LAST content in the string: the body was composed
    // INSIDE the block, and nothing from it runs past the footer. That is a claim about
    // renderComment's composition, and only that. It reads the RAW markdown, whose last
    // bytes do not move however the body's code fence ends up rendering — so it cannot
    // see a fence swallowing the trailing </details> + footer, nor any other escaping
    // failure (measured: embed the body with escapeHtml, leaving its ``` fence raw, and
    // this arm stays green). The fence vector is held by the </details> count above and
    // by "the <details> BODY rides escapeInline" below.
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

// The three arms above assert their entities against the WHOLE comment, and
// `maliciousReport()` plants the same attack string in the row summary AND in the
// body — so the INLINE ROW alone satisfies them and they hold nothing about the
// collapsed body. Measured: strip the backtick/pipe/bracket/paren rules from the body
// embed only (`escapeHtml` in `renderDetails`) and "HTML/backtick/pipe render inert"
// stays GREEN. The code fence is frame.ts's own second-named vector and it lives in
// the BODY — a log line inside the collapsed report — so it needs an arm that can only
// be satisfied there.
const BODY_VECTORS: ReadonlyArray<readonly [raw: string, embedded: string]> = [
    ['ampersand&sign', 'ampersand&amp;sign'],
    ['</details>', '&lt;/details&gt;'],
    ['```fence```', '&#96;&#96;&#96;fence&#96;&#96;&#96;'],
    ['cell|wall', 'cell&#124;wall'],
    ['[lure](https://evil.example/body)', '&#91;lure&#93;&#40;https://evil.example/body&#41;'],
];

test('safe embedding: the <details> BODY rides escapeInline — every vector, hand-written', () => {
    const report: SiftReport = {
        ...load('drift.json'),
        markdown:
            '# Sift — baseline → changed\n\n## Significant changes\n\n' +
            BODY_VECTORS.map(([raw], i) => `${i + 1}. **[HIGH]** log line carrying ${raw}`).join('\n') +
            '\n',
    };
    // Each vector must be unreachable from the row block, or the row satisfies the pin
    // and the arm inherits exactly the blindness it was written to remove. Asserted
    // against the fixture, not assumed of it.
    for (const row of report.ranked_changes) {
        for (const [raw] of BODY_VECTORS) {
            assert.ok(
                !row.summary.includes(raw),
                `vector ${JSON.stringify(raw)} also occurs in a row summary — the pin below would be ` +
                    `satisfiable by the inline row block instead of the body: ${row.summary}`,
            );
        }
    }

    const slot = detailsBody(renderComment(report, ctx()));
    for (const [raw, embedded] of BODY_VECTORS) {
        assert.ok(slot.includes(embedded), `body must carry ${JSON.stringify(embedded)}\n--- slot ---\n${slot}`);
        assert.ok(
            !slot.includes(raw),
            `body must not carry ${JSON.stringify(raw)} un-defanged\n--- slot ---\n${slot}`,
        );
    }
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

// ── Baseline selection surfaces (user King of the baseline) ─────────────────

test('comment-tag: tagged marker + title suffix; untagged marker is NOT a substring of it', () => {
    const out = renderComment(null, ctx({ baseline: undefined, comment_tag: 'vs-prev' }));
    assert.ok(out.startsWith('<!-- sift:pr-comment:vs-prev -->'));
    assert.ok(out.includes(`${HEADER} (vs-prev)`));
    assert.ok(!out.includes('<!-- sift:pr-comment -->'));
});

test('artifact provenance: the footnote names the baseline artifact, not a branch run', () => {
    const out = renderComment(load('drift.json'), ctx({
        baseline: {
            kind: 'artifact',
            sha: BASE_SHA,
            run_id: '80',
            run_url: 'https://github.com/o/r/actions/runs/80',
            branch: 'main',
            created_at: '2026-07-01T00:00:00Z',
            label: 'sift-baseline-main-build',
        },
    }));
    assert.ok(out.includes('Baseline: artifact `sift-baseline-main-build` @'));
    assert.ok(!out.includes('last green run on'));
});

test('cold start with a configured source: the copy names the source, not the base branch', () => {
    const out = renderComment(null, ctx({
        baseline: undefined,
        baseline_source: 'the `sift-baseline-main-build` baseline artifact',
    }));
    assert.ok(out.includes('Sift diffs each run against the `sift-baseline-main-build` baseline artifact.'));
    assert.ok(!out.includes('last green run on `main`'));
});

// ── Baseline age + the stale banner ─────────────────────────────────────────
// The age is envelope-computed (context fields) so the renderer stays pure; the
// frame's job is to SURFACE it: footer age always when known, and the loud
// banner between header and body when the bound was exceeded.

test('the footer states the baseline age when known; silent when unknown', () => {
    const report = load('clean_suppressed.json');
    const aged = renderComment(report, ctx({ baseline_age_hours: 122 }));
    assert.ok(aged.includes('5d 2h old'), 'age renders in d/h form past 48h');
    const unknown = renderComment(report, ctx());
    assert.ok(!unknown.includes(' old'), 'no age claim when the envelope has none');
});

test('stale baseline: the banner renders between header and body, naming age and bound', () => {
    const report = load('clean_suppressed.json');
    const out = renderComment(
        report,
        ctx({ baseline_age_hours: 122, baseline_age_bound: '72h', baseline_stale: true }),
    );
    assert.ok(out.includes('**Stale baseline — 5d 2h old, past the 72h bound.**'));
    const bannerAt = out.indexOf('Stale baseline');
    const bodyAt = out.indexOf('No structural change');
    assert.ok(bannerAt >= 0 && bodyAt > bannerAt, 'banner precedes the verdict body');
    assert.ok(out.includes('5d 2h old'), 'footer age still present');
});

test('an aged-but-inside-bound baseline renders NO banner (age in the footer only)', () => {
    const report = load('clean_suppressed.json');
    const out = renderComment(
        report,
        ctx({ baseline_age_hours: 40, baseline_age_bound: '72h' }),
    );
    assert.ok(!out.includes('Stale baseline'));
    assert.ok(out.includes('40h old'));
});

// ── The evidence channel reaches the reader ─────────────────────────────────
//
// The engine's promise was that the fold's evidence rides "the channel every renderer
// already prints". On this surface that channel is exactly ONE path, and it is worth
// naming because it is the reason there is no TypeScript re-implementation to test:
// `renderRow` emits `summary` + `where` and NOTHING else, so an evidence line reaches a
// reader only through the <details> body — `report.markdown`, which IS the engine's
// `to_markdown` output, embedded verbatim. The engine side owns what that body CONTAINS
// (insight-eidos: tests/report/rendered_evidence_test.cpp); what is uncovered here is
// whether the derivation actually DELIVERS it — the body embed above is asserted as an
// identity against whatever `markdown` happens to be, so it cannot see evidence loss, and
// safe embedding runs over every byte of it on the way through.

// A folded member's text and the head of a truncation notice. Both are held apart from
// every `ranked_changes[].summary` on purpose (asserted below, not assumed): an arm
// asserting "the evidence text appears" is satisfiable by the inline row block the moment
// the two overlap, and then it holds nothing about the evidence channel at all.
// ⚠ BOTH NEEDLES ARE ASCII, and that is a decision, not an accident. The evidence lines
// carry `•` and `…`; a needle containing either would red when `escapeInline` grows one
// more entity rule — and `&#8226;` DISPLAYS as `•`, so that red would cost a reader
// nothing and would argue for weakening this arm. Pin what a rewrite cannot preserve
// silently: the words, contiguous.
const FOLD_MEMBER = 'the linker refused the release profile';
const FOLD_NOTICE_COUNT = 'and 7 more';

function reportCarryingEvidence(): SiftReport {
    const base = load('drift.json');
    // The engine body's own shape: a ranked row, then its evidence as indented bullets.
    const markdown =
        '# Sift — baseline → changed\n\n' +
        '**7 changes, 2 structurally significant.**\n\n' +
        '## Significant changes\n\n' +
        '1. **[CRITICAL · regression]** Unit changed outcome: "gate" — required by this run\n' +
        `   -   • build / bravo: ${FOLD_MEMBER}\n` +
        `   -   • … ${FOLD_NOTICE_COUNT}, all carried in rolled_up_template_ids\n`;
    return { ...base, markdown };
}

test('evidence reaches the reader: folded member + remainder notice land inside <details>', () => {
    const report = reportCarryingEvidence();
    for (const row of report.ranked_changes) {
        assert.ok(
            !row.summary.includes(FOLD_MEMBER),
            'the member text also occurs in an inline row summary — every assertion below would ' +
                'then be satisfiable by the row block, not the evidence channel',
        );
        assert.ok(!row.summary.includes(FOLD_NOTICE_COUNT), 'same, for the notice');
    }

    const out = renderComment(report, ctx());
    // The FULL REPORT's block, not the first <details> in the comment — the severity
    // sections open earlier, and anchoring on them would let an inline row satisfy an
    // assertion that is supposed to be about the collapsed body.
    const detailsAt = fullReportAt(out);

    // Present, and present in the ONE place that can carry it — after the <details> opening.
    // A hit before it would mean the row block grew an evidence channel of its own, which is
    // the derivation this arm rests on quietly breaking.
    const memberAt = out.indexOf(FOLD_MEMBER);
    assert.ok(memberAt > detailsAt, 'the folded member never reached the collapsed report body');
    const noticeAt = out.indexOf(FOLD_NOTICE_COUNT);
    assert.ok(noticeAt > detailsAt, 'the truncation notice never reached the collapsed report body');

    // READABLE, not merely present: safe embedding runs over every byte of the body on the
    // way through, and an evidence line delivered as scattered fragments is the same loss as
    // a dropped one. CONTIGUITY is the checkable form of "readable" — assert the whole span
    // arrives unbroken, not just that its words occur somewhere.
    assert.ok(
        out.includes(`build / bravo: ${FOLD_MEMBER}`),
        out.slice(detailsAt, detailsAt + 600),
    );
    assert.ok(
        out.includes(`${FOLD_NOTICE_COUNT}, all carried in rolled_up_template_ids`),
        out.slice(detailsAt, detailsAt + 600),
    );

    // And the line is still a LINE: its own row in the body, under its own indent. A body
    // re-wrapped or stripped of leading whitespace stops rendering evidence as a sub-bullet
    // and merges it into the row above — present in the bytes, gone from the reader's eye.
    assert.match(
        out,
        new RegExp(`\\n {3}- .*build / bravo: ${FOLD_MEMBER}`),
        out.slice(detailsAt, detailsAt + 600),
    );
});
