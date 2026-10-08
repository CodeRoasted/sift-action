// Verdict logic — the pure state machine behind the comment headline.
//
// The state is a pure function of the report the Action holds (PRD-6
// § "Verdict logic"): `significant_changes`, whether any ranked row is
// `polarity == "regression"`, and the engine-resolved run-verdict pair
// (`summary.outcome_regressed`, ADR-17.D5). No I/O.

import type { SiftReport } from './types.js';

// The four frame states (PRD-6 § "The four states"). `ColdStart` is rendered
// without a report (the engine is not invoked when no baseline exists).
export enum State {
    ColdStart = 'cold-start', // ① no baseline yet
    Clean = 'clean',          // ② significant_changes === 0
    Drift = 'drift',          // ③ significant > 0, no regression
    Regression = 'regression', // ④ a row has polarity === "regression"
}

// A regression is "a row whose polarity is regression" OR "the run verdict got
// strictly worse" (`summary.outcome_regressed`, the engine-derived §6.1 predicate:
// Success < Unstable < Failure, Aborted/Unknown excluded). One canonical pair the
// headline, the rows, and the gate all agree on — a SUCCESS→UNSTABLE run with no
// new structural row is still loud (UNSTABLE never folds, ADR-17.D5).
export function hasRegression(report: SiftReport): boolean {
    return (
        report.summary.outcome_regressed === true ||
        report.ranked_changes.some((row) => row.polarity === 'regression')
    );
}

// `report === null` ⟺ cold start (no baseline ⇒ engine not invoked).
// Regression is checked BEFORE Clean: a verdict regression (SUCCESS→UNSTABLE) can
// arrive with zero significant structural rows — steady templates, worse verdict —
// and must not render as "✅ no structural change".
export function selectState(report: SiftReport | null): State {
    if (report === null) {
        return State.ColdStart;
    }
    if (hasRegression(report)) {
        return State.Regression;
    }
    if (report.summary.significant_changes === 0) {
        return State.Clean;
    }
    return State.Drift;
}

// ── Comment threshold — per surface, no shared floor (contract § 3) ──────────
//
// Both pr-comment and commit-comment carry their OWN level: does a result at `state`
// clear it? The ladder (rising = more comments), each value the word of the headline state the
// user reads (DN-132.O2, the Founder's ruling (a), 2026-10-02):
//   never       — off (no comment on this surface)
//   regression  — only a flagged regression
//   drift       — drift OR regression
//   always      — every state, incl. clean's "✅ no change" reassurance and cold start
// The job summary + outputs are written regardless; this only gates the comment. The ladder
// answers WHEN SIFT SPEAKS; `fail-on` answers when it blocks, a separate question (DN-132.D2).
export const COMMENT_LEVELS = ['never', 'regression', 'drift', 'always'] as const;
export type CommentLevel = (typeof COMMENT_LEVELS)[number];

export function shouldComment(state: State, level: CommentLevel): boolean {
    switch (level) {
        case 'never':
            return false;
        case 'regression':
            return state === State.Regression;
        case 'drift':
            return state === State.Drift || state === State.Regression;
        case 'always':
            return true;
    }
}

// A ladder input's value, lower-cased; empty takes the surface's default. Any other value is a
// CONFIG error that fails the run, as a malformed `baseline` does: falling back silently would
// leave a surface on, or off, against the workflow's text — a workflow still spelling the retired
// `significant` would otherwise lose its annotations without a word. No alias and no mapping: the
// message names the four values (DN-132.D2's rule for a retired value).
export function parseCommentLevel(input: string, raw: string, fallback: CommentLevel): CommentLevel {
    const value = (raw || fallback).trim().toLowerCase();
    const level = COMMENT_LEVELS.find((known) => known === value);
    if (level === undefined) {
        throw new Error(
            `invalid \`${input}\` input "${raw}" — expected ${COMMENT_LEVELS.join(' | ')}`,
        );
    }
    return level;
}
