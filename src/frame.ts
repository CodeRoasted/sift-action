// The frame renderer — the governed-copy heart of the Action.
//
// `renderComment(report, context)` is a PURE, DETERMINISIC function: same
// (report, context) ⇒ same string. The only varying inputs are identity stamps
// (head_sha, baseline.sha) which IDENTIFY the run, not its content
// (sift_action_contract.md § 4). The frame owns the header, the one-line
// verdict, the state logic, and the footer; the ENGINE owns every row
// (`summary`) and the full <details> body (`markdown`), surfaced VERBATIM —
// the Action never re-authors a row (contract § 1, web_copy § "rows are the
// engine's"). Copy below is governed by web_copy § "Surface: Sift PR comment".

import type { SiftReport, SiftCommentContext } from './types';
import { State, selectState } from './verdict';

// Hidden sticky-comment key (contract § 4): list comments, PATCH the marked one
// or POST a new one — one comment per PR, updated in place.
export const STICKY_MARKER = '<!-- sift:pr-comment -->';

// Shared header, every state (web_copy § "The four states", verbatim).
const HEADER = '### 🔬 Sift — structural diff of your CI logs';

// "What is this?" target — the product's Sift front door (web_copy § "Page: Sift").
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

// Inline row badge — matches the engine's to_markdown row headline so the inline
// rows and the <details> body read identically: `**[HIGH · regression]**`.
// Severity is uppercased (wire form is lowercase); polarity rides inside when
// present (F-1). The `summary` is taken VERBATIM.
function renderRow(index: number, row: SiftReport['ranked_changes'][number]): string {
    const badge = row.severity.toUpperCase() + (row.polarity ? ` · ${row.polarity}` : '');
    return `${index}. **[${badge}]** ${row.summary}`;
}

function renderRows(report: SiftReport): string {
    const rows = report.ranked_changes;
    const shown = rows.slice(0, MAX_INLINE_ROWS);
    const lines = shown.map((row, i) => renderRow(i + 1, row));
    if (rows.length > shown.length) {
        const rest = rows.length - shown.length;
        lines.push(`_…and ${groupThousands(rest)} more — see the full report below._`);
    }
    return lines.join('\n');
}

// The collapsed full report: the engine's markdown body, embedded VERBATIM. Blank
// lines around it so GitHub renders the markdown inside the <details>.
function renderDetails(report: SiftReport): string {
    const { total_changes, significant_changes } = report.summary;
    const summaryLine = `Full report — ${groupThousands(total_changes)} changes, ${groupThousands(
        significant_changes,
    )} significant`;
    return `<details><summary>${summaryLine}</summary>\n\n${report.markdown ?? ''}\n\n</details>`;
}

// ── State bodies (web_copy § "The four states") ─────────────────────────────

// ① No baseline yet. web_copy hardcodes `main`; we substitute the PR's actual
// base branch (the contract's baseline = the base branch, which may be master/
// develop) — the only deviation from the literal copy, and the correct one.
function coldStartBody(context: SiftCommentContext): string {
    return (
        `🔬 No baseline yet. Sift diffs each run against the last green run on \`${context.base_branch}\`.\n` +
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

// ③ Drift — significant > 0, no regression. The cache-died hero lands here.
function driftBody(report: SiftReport, context: SiftCommentContext): string {
    const significant = report.summary.significant_changes;
    const suppressed = report.summary.total_changes - significant;
    const headline =
        context.build_status === 'green'
            ? // build green — the hero
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

// ④ Regression — a row has polarity === regression. The loudest state. Regression
// rows already sort first (the engine ranks NewError/Escalated at the top tier).
function regressionBody(report: SiftReport, context: SiftCommentContext): string {
    const headline =
        context.build_status === 'green'
            ? // build green — the strongest hero (founder-LOCKED line)
              '🚨 Green tests. Real regression. It slipped through:'
            : // build unknown / red
              '🚨 Regression flagged. A new error-level pattern that wasn\'t in the baseline:';
    return `${headline}\n\n${renderRows(report)}\n\n${renderDetails(report)}`;
}

// ── Footer (every state) ────────────────────────────────────────────────────

// web_copy footer + the baseline-provenance footnote (contract § 4 / web_copy
// § "What the copy needs"): "last green run on `branch` @ sha", linked to the
// run. Determinism + on-prem stated once, flat. Identity stamps (head/baseline
// sha) are run identity, not content.
function footer(context: SiftCommentContext): string {
    const parts = [
        'Deterministic — same inputs, same comment. Runs in your CI; your logs never leave it.',
        `[What is this?](${SIFT_URL})`,
    ];
    if (context.baseline) {
        const sha = shortSha(context.baseline.sha);
        parts.push(
            `Baseline: last green run on \`${context.baseline.branch}\` @ [\`${sha}\`](${context.baseline.run_url})`,
        );
    }
    parts.push(`as of \`${shortSha(context.head_sha)}\``);
    return `<sub>${parts.join(' · ')}</sub>`;
}

// ── The renderer ────────────────────────────────────────────────────────────

function body(report: SiftReport | null, context: SiftCommentContext, state: State): string {
    switch (state) {
        case State.ColdStart:
            return coldStartBody(context);
        case State.Clean:
            return cleanBody(report as SiftReport);
        case State.Drift:
            return driftBody(report as SiftReport, context);
        case State.Regression:
            return regressionBody(report as SiftReport, context);
    }
}

// The full sticky-comment markdown. `report === null` ⇒ cold start.
export function renderComment(report: SiftReport | null, context: SiftCommentContext): string {
    const state = selectState(report);
    return `${STICKY_MARKER}\n${HEADER}\n\n${body(report, context, state)}\n\n${footer(context)}`;
}
