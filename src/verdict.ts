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
// clear it? The ladder (rising = more comments):
//   never       — off (no comment on this surface)
//   regression  — only a flagged regression
//   significant — drift OR regression ("≥ notable")
//   always      — every state, incl. clean's "✅ no change" reassurance and cold start
// The job summary + outputs are written regardless; this only gates the comment.
export type CommentLevel = 'never' | 'regression' | 'significant' | 'always';

export function shouldComment(state: State, level: CommentLevel): boolean {
    switch (level) {
        case 'never':
            return false;
        case 'regression':
            return state === State.Regression;
        case 'significant':
            return state === State.Drift || state === State.Regression;
        case 'always':
            return true;
    }
}
