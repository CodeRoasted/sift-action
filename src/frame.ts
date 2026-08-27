// The frame renderer — the governed-copy heart of the Action.
//
// `renderComment(report, context)` is a PURE, DETERMINISIC function: same
// (report, context) ⇒ same string. The only varying inputs are identity stamps
// (head_sha, baseline.sha) which IDENTIFY the run, not its content
// (bibles/sift_action.md § 4). The frame owns the header, the one-line
// verdict, the state logic, and the footer; the ENGINE owns every row
// (`summary`) and the full <details> body (`markdown`), surfaced VERBATIM —
// the Action never re-authors a row (contract § 1; PRD-6 — "rows are the
// engine's, not ours"). Copy below is governed by PRD-6 § "Surface: Sift PR comment".

import type { RankedChange, SiftReport, SiftCommentContext } from './types.js';
import { polarityGlyph, severityGlyph } from './glyph.js';
import { State, selectState } from './verdict.js';

// Hidden sticky-comment key (contract § 4): list comments, PATCH the marked one
// or POST a new one — one comment per PR (per tag), updated in place. A
// `comment-tag` namespaces the marker so two sift invocations in one job (e.g.
// vs-main and vs-previous) each keep their own sticky comment; the untagged
// marker is NOT a substring of a tagged one (`:` vs ` `), so lookups stay exact.
export const STICKY_MARKER = '<!-- sift:pr-comment -->';
export function stickyMarker(tag?: string): string {
    return tag ? `<!-- sift:pr-comment:${tag} -->` : STICKY_MARKER;
}

// Shared header, every state (PRD-6 § "The four states", verbatim).
const HEADER = '### 🔬 Sift — structural diff of your CI logs';

// "What is this?" target — the product's Sift front door (PRD-6 § "Page: Sift").
const SIFT_URL = 'https://coderoast.fr/sift';

// Defensive cap on inline rows so a pathological significant-set cannot bloat the
// comment; the full set always lives in the <details> body. Real CI diffs surface
// a handful (the whole pitch is "3 that matter"), so this rarely engages.
const MAX_INLINE_ROWS = 20;

// Locale-independent thousands grouping (deterministic; no toLocaleString).
function groupThousands(value: number): string {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function plural(count: number, singular: string, pluralForm: string): string {
    return count === 1 ? singular : pluralForm;
}

function shortSha(sha: string): string {
    return sha.slice(0, 7);
}

// Deterministic age copy from the envelope-computed whole-hours value: `<h>h` under
// two days, else `<d>d <h>h` (the trailing hours dropped when zero). The frame never
// reads a clock — the hours arrive via context (purity holds).
export function formatAge(hours: number): string {
    if (hours < 48) return `${hours}h`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

// ── Safe embedding ──────────────────────────────────────────────────────────
// The rows (`summary`) and the report body (`markdown`) are the engine's CONTENT
// verbatim, but they derive from real — and on fork PRs, attacker-controlled — CI
// logs. They must be SAFELY EMBEDDED: a log line carrying HTML, backticks, or a
// pipe must not break the comment STRUCTURE. The critical vector is a literal
// `</details>` escaping the collapsed block; the code-fence (```)/inline-code
// backtick that would swallow the trailing `</details>` + footer is the second.
// "Verbatim content, safely embedded" — not raw-concatenated. (GitHub also
// sanitizes comment HTML; this is defence-in-depth at our boundary, and it fixes
// a fidelity bug too — an unescaped `<host>` or the `<*>` mask token would
// otherwise be eaten as a phantom HTML tag.) The rendered TEXT is unchanged: each
// escape maps to the entity that displays the same character, inert.

// HTML structural chars → entities. Neutralizes every HTML tag (incl. the
// </details> breakout). `&` first, so the entities it introduces aren't re-hit.
export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Fully inert an engine string for embedding in markdown: HTML, the structural
// markdown chars that could break the comment frame, AND the link/image syntax
// that would otherwise let attacker-controlled CI-log text post a clickable link
// or auto-loading image under our bot's identity. Each is replaced by the
// numeric entity that DISPLAYS the same character but is inert to the parser:
//   `        → code fence / inline-code span (would swallow following lines)
//   |        → table cell
//   [ ] ( )  → markdown link `[text](url)`, image `![text](url)`, and the
//              reference forms — the bot-comment phishing surface (contract
//              §6.1 item 2): a hidden destination behind innocuous text, or a
//              tracking pixel that loads on render.
// The engine's intentional block formatting (#, *, -, _, and a decorative
// `[BADGE]`) uses none of `|[]()` as live syntax and emits no links of its own
// (line-ref deep links are deferred), so the body's headers/bold/bullets survive
// intact and the bracketed badge renders identically as literal brackets. The
// only cosmetic effect is that any inline-`code` styling renders as literal
// backticks. Residual: a BARE url in log text can still GFM-autolink, but its
// link text == its href (visible, not a hidden destination) — defanging that is
// the item-4 perimeter pass, not this surface.
export function escapeInline(text: string): string {
    return escapeHtml(text)
        .replace(/`/g, '&#96;')
        .replace(/\|/g, '&#124;')
        .replace(/\[/g, '&#91;')
        .replace(/\]/g, '&#93;')
        .replace(/\(/g, '&#40;')
        .replace(/\)/g, '&#41;');
}

// ── Rows, grouped into collapsible severity sections ────────────────────────
// Severity is what an operator triages on, so it is the SECTION axis: one collapsed
// <details> per severity, hottest first, the heat badge stated ONCE on the heading
// instead of repeated on every row beneath it. The affordance is the same disclosure
// triangle the full report already uses — deliberately not a second, invented one.
// Grouping and collapsing are FRAMING: no row's text is touched (contract § 1).

// The triage ladder, hottest first. A severity the ladder does not know is NOT
// dropped and NOT folded into `low`: it forms its own section after the known tiers,
// in the engine's own first-appearance order, so a new engine tier surfaces as itself
// rather than vanishing into a bucket that would misstate its heat.
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function severityRank(severity: string): number {
    const index = SEVERITY_ORDER.indexOf(severity.toLowerCase());
    return index === -1 ? SEVERITY_ORDER.length : index;
}

interface SeveritySection {
    severity: string; // lowercased wire form; the heading uppercases it
    rows: RankedChange[];
}

// Rows arrive already RANKED by the engine (regressions at the top tier). Grouping
// preserves that order inside each section, and a Map preserves insertion order, so
// two unknown tiers keep the engine's own sequence; `Array#sort` is stable (ES2019),
// so equal ranks never reshuffle. Same report ⇒ same sections, same order.
function groupBySeverity(rows: readonly RankedChange[]): SeveritySection[] {
    const sections = new Map<string, SeveritySection>();
    for (const row of rows) {
        const key = row.severity.toLowerCase();
        const section = sections.get(key);
        if (section) {
            section.rows.push(row);
        } else {
            sections.set(key, { severity: key, rows: [row] });
        }
    }
    return [...sections.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

// One row inside its section. The severity chip is GONE from the row — the heading it
// sits under carries it, and repeating it was the duplication this layout removes.
// What stays is the axis the heading CANNOT carry: polarity (F-1), as the green
// recovery circle plus the direction word. Neutral rows carry neither — an absent
// direction renders nothing, no empty badge. `polarity` is an engine ENUM (trusted);
// the `summary` is engine CONTENT — verbatim, safely embedded (escapeInline).
function renderRow(index: number, row: RankedChange): string {
    const glyph = polarityGlyph(row.polarity);
    const badge = row.polarity ? `${glyph ? `${glyph} ` : ''}**[${row.polarity}]** ` : '';
    // WHERE attribution (SRC-D-WHERE-7 tier 1): the functional location after the summary,
    // as inline code. `where` is engine CONTENT (canon-extracted, fork-attacker-reachable)
    // → escapeInline; the surrounding backticks are frame-controlled. Absent ⇒ nothing.
    const where = row.where ? ` · in \`${escapeInline(row.where)}\`` : '';
    return `${index}. ${badge}${escapeInline(row.summary)}${where}`;
}

// One severity section. The heading is frame-controlled (a glyph, the severity token,
// a count), so it is composed raw — except the severity token itself, which is
// escapeHtml'd: it is an engine enum today, but it lands inside a <summary> ELEMENT
// here, where an unexpected `</summary>` would break the comment's structure rather
// than merely its text. Cheap at an enum, and it keeps the widened blast radius of the
// new HTML context closed at the boundary.
//
// `disclosed` opens the block. Exactly ONE section is disclosed — the hottest, index 0
// — and the reason is the product's contract rather than taste: the governed headline
// copy ends in a colon ("It slipped through:"), so a comment whose every section is
// collapsed opens with a sentence pointing at nothing. Precision-first means 1 alert =
// 1 true incident, and the incident must be READABLE at the top of the comment. The
// noise the layout was ruled against is the REPEATED per-row chip, not the finding
// itself. Everything below index 0, and the full report, stays collapsed.
function renderSection(section: SeveritySection, disclosed: boolean): string {
    const count = section.rows.length;
    const heading =
        `${severityGlyph(section.severity)} <b>${escapeHtml(section.severity.toUpperCase())}</b>` +
        ` — ${count} ${plural(count, 'change', 'changes')}`;
    const rows = section.rows.map((row, i) => renderRow(i + 1, row)).join('\n');
    return `<details${disclosed ? ' open' : ''}><summary>${heading}</summary>\n\n${rows}\n\n</details>`;
}

function renderRows(report: SiftReport): string {
    const rows = report.ranked_changes;
    const shown = rows.slice(0, MAX_INLINE_ROWS);
    // Index 0 is the hottest section by the ladder — whatever severity that is on this
    // report. Deliberately positional, not a CRITICAL special case: a report whose worst
    // finding is MEDIUM still discloses its worst finding.
    const blocks = groupBySeverity(shown).map((section, i) => renderSection(section, i === 0));
    if (rows.length > shown.length) {
        const rest = rows.length - shown.length;
        // Outside every section: the remainder is not a severity, and the cap is
        // global (the top-N of the RANKED set), not per-section.
        blocks.push(`_…and ${groupThousands(rest)} more — see the full report below._`);
    }
    return blocks.join('\n\n');
}

// The collapsed full report: the engine's markdown body, safely embedded. The
// body is escapeInline'd (not raw) so a log line in it cannot close the <details>
// early or open a code fence that swallows the trailing tag + footer; the
// engine's headers/bold/bullets survive (escapeInline leaves #,*,-,_ alone).
// Blank lines around it so GitHub renders the markdown inside the <details>.
// summaryLine is frame-controlled (counts), so it is composed raw.
function renderDetails(report: SiftReport): string {
    const { total_changes, significant_changes } = report.summary;
    const summaryLine = `Full report — ${groupThousands(total_changes)} changes, ${groupThousands(
        significant_changes,
    )} significant`;
    return `<details><summary>${summaryLine}</summary>\n\n${escapeInline(report.markdown ?? '')}\n\n</details>`;
}

// ── State bodies (PRD-6 § "The four states") ─────────────────────────────

// ① No baseline yet. PRD-6 hardcodes `main`; we substitute the PR's actual
// baseline SOURCE — the base branch by default (which may be master/develop),
// or the configured named source (`baseline_source`) when the user overrode
// selection — the only deviation from the literal copy, and the correct one.
function coldStartBody(context: SiftCommentContext): string {
    const source = context.baseline_source ?? `the last green run on \`${context.base_branch}\``;
    return (
        `🔬 No baseline yet. Sift diffs each run against ${source}.\n` +
        'Once one lands, every PR gets a structural diff here — nothing to compare this time.'
    );
}

// ② Clean — significant === 0. One block, no <details> (nothing to drill into).
function cleanBody(report: SiftReport): string {
    const baseline = groupThousands(report.inputs.baseline.lines_observed);
    const changed = groupThousands(report.inputs.changed.lines_observed);
    const total = report.summary.total_changes;
    const headline = `✅ No structural change. ${baseline} → ${changed} log lines, same behaviour.`;
    if (total === 0) {
        // Degenerate clean (e.g. identical inputs): nothing was weighed, so the
        // suppression line would read "dropped all 0 as noise" — omit it.
        return headline;
    }
    const grouped = groupThousands(total);
    return (
        `${headline}\n` +
        `Sift weighed ${grouped} surface diffs and dropped all ${grouped} as noise — counts, ordering, IDs that carry no signal.`
    );
}

// The run-verdict predicate the Drift/Regression headlines branch on: the ENGINE-resolved
// four-class verdict (`summary.changed_outcome`, ADR-17.D5 — authoritative side-input →
// console tail → Unknown), never a render-side CI flag (the retired `build_status`).
// Absent (Unknown) degrades to the generic headline, exactly as 'unknown' did.
function changedRunSucceeded(report: SiftReport): boolean {
    return report.summary.changed_outcome === 'SUCCESS';
}

// ③ Drift — significant > 0, no regression. The cache-died hero lands here.
function driftBody(report: SiftReport): string {
    const significant = report.summary.significant_changes;
    const suppressed = report.summary.total_changes - significant;
    const headline =
        changedRunSucceeded(report)
            ? // run verdict SUCCESS — the hero
              '🔍 Green build, changed behaviour. Your tests passed; the shape of your logs didn\'t.\n' +
              `${significant} ${plural(significant, 'change', 'changes')} worth a look, ${groupThousands(
                  suppressed,
              )} are noise.`
            : // build unknown / red
              `🔍 ${significant} structural ${plural(
                  significant,
                  'change',
                  'changes',
              )} worth a look — ${groupThousands(suppressed)} of ${groupThousands(
                  report.summary.total_changes,
              )} diffs are noise.`;
    return `${headline}\n\n${renderRows(report)}\n\n${renderDetails(report)}`;
}

// ④ Regression — a row has polarity === regression, or the run verdict got strictly
// worse (`summary.outcome_regressed`, ADR-17.D5). The loudest state. Regression
// rows already sort first (the engine ranks NewError/Escalated at the top tier).
// The three headline branches are mutually exclusive by construction: a SUCCESS
// changed run cannot be an outcome regression (SUCCESS is the axis floor).
function regressionBody(report: SiftReport): string {
    const { baseline_outcome, changed_outcome, outcome_regressed } = report.summary;
    const headline = changedRunSucceeded(report)
        ? // run verdict SUCCESS — the strongest hero (founder-LOCKED line)
          '🚨 Green tests. Real regression. It slipped through:'
        : outcome_regressed
          ? // the run verdict itself regressed (§6.1 — typed, UNSTABLE never folded).
            // The pair is engine ENUM output (trusted), not log content.
            `🚨 Run verdict regressed: **${baseline_outcome ?? 'UNKNOWN'} → ${changed_outcome ?? 'UNKNOWN'}**.`
          : // structural regression on a non-green run
            '🚨 Regression flagged. A new error-level pattern that wasn\'t in the baseline:';
    // A pure verdict regression can carry zero ranked rows (steady templates, worse
    // verdict) — skip the empty rows block; the <details> body still carries the
    // engine's §6.1 verdict framing.
    const rows = report.ranked_changes.length > 0 ? `${renderRows(report)}\n\n` : '';
    return `${headline}\n\n${rows}${renderDetails(report)}`;
}

// ── Footer (every state) ────────────────────────────────────────────────────

// PRD-6 footer + the baseline-provenance footnote (contract § 4 / PRD-6
// § "What the frame carries"): "last green run on `branch` @ sha", linked to the
// run. Determinism + on-prem stated once, flat. Identity stamps (head/baseline
// sha) are run identity, not content.
function footer(context: SiftCommentContext): string {
    const parts = [
        'Deterministic — same inputs, same comment. Runs in your CI; your logs never leave it.',
        `[What is this?](${SIFT_URL})`,
    ];
    if (context.baseline) {
        parts.push(baselineFootnote(context.baseline));
        // The age is ALWAYS stated when known — a reader must never have to infer
        // from a sha how old the comparison point is (the silent-staleness class).
        if (context.baseline_age_hours != null) {
            parts.push(`${formatAge(context.baseline_age_hours)} old`);
        }
    }
    parts.push(`as of \`${shortSha(context.head_sha)}\``);
    return `<sub>${parts.join(' · ')}</sub>`;
}

// The provenance footnote adapts to how the baseline was SELECTED (the user is
// King of the baseline): a branch's last green run (the turnkey default), a
// named baseline artifact, or a local file.
function baselineFootnote(baseline: NonNullable<SiftCommentContext['baseline']>): string {
    const sha = shortSha(baseline.sha);
    const linkedSha = baseline.run_url ? `[\`${sha}\`](${baseline.run_url})` : `\`${sha}\``;
    switch (baseline.kind) {
        case 'artifact':
            return `Baseline: artifact \`${baseline.label ?? ''}\`${sha ? ` @ ${linkedSha}` : ''}`;
        case 'path':
            return `Baseline: local file \`${baseline.label ?? ''}\``;
        case 'run':
            return `Baseline: last green run on \`${baseline.branch}\` @ ${linkedSha}`;
    }
}

// ── The renderer ────────────────────────────────────────────────────────────

function body(report: SiftReport | null, context: SiftCommentContext, state: State): string {
    switch (state) {
        case State.ColdStart:
            return coldStartBody(context);
        case State.Clean:
            return cleanBody(report as SiftReport);
        case State.Drift:
            return driftBody(report as SiftReport);
        case State.Regression:
            return regressionBody(report as SiftReport);
    }
}

// The stale-baseline banner (above the verdict body, below the header): when the
// caller set `baseline-max-age` and the resolved baseline exceeds it, the diff
// still renders — an aged comparison is information — but it must ANNOUNCE itself
// before its numbers are read. Bound + age are frame-controlled envelope values.
function staleBanner(context: SiftCommentContext): string {
    const age =
        context.baseline_age_hours != null ? formatAge(context.baseline_age_hours) : 'unknown age';
    return (
        `> ⚠️ **Stale baseline — ${age} old, past the ${context.baseline_age_bound ?? ''} bound.** ` +
        'No green run has re-seeded it since; this diff compares against that aged snapshot ' +
        'and loses meaning as the streak grows.'
    );
}

// The full sticky-comment markdown. `report === null` ⇒ cold start. A
// comment-tag suffixes the header so two tagged comments are visually distinct.
export function renderComment(report: SiftReport | null, context: SiftCommentContext): string {
    const state = selectState(report);
    const header = context.comment_tag ? `${HEADER} (${context.comment_tag})` : HEADER;
    const stale = context.baseline_stale ? `${staleBanner(context)}\n\n` : '';
    return `${stickyMarker(context.comment_tag)}\n${header}\n\n${stale}${body(report, context, state)}\n\n${footer(context)}`;
}
