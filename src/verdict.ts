// Verdict logic — the pure state machine behind the comment headline.
//
// The state is a pure function of three inputs the Action holds (web_copy
// § "Verdict logic"): `significant_changes`, whether any ranked row is
// `polarity == "regression"`, and the optional CI `build_status`. No I/O.

import type { SiftReport } from './types';

// The four frame states (web_copy § "The four states"). `ColdStart` is rendered
// without a report (the engine is not invoked when no baseline exists).
export enum State {
    ColdStart = 'cold-start', // ① no baseline yet
    Clean = 'clean',          // ② significant_changes === 0
    Drift = 'drift',          // ③ significant > 0, no regression
    Regression = 'regression', // ④ a row has polarity === "regression"
}

// A regression is "a row whose polarity is regression". Read directly from the
// engine's per-row polarity (contract § 7: the optional
// `summary.regression_flagged` field is not required — this single predicate is
// the canonical source the headline, the rows, and the gate all agree on).
export function hasRegression(report: SiftReport): boolean {
    return report.ranked_changes.some((row) => row.polarity === 'regression');
}

// `report === null` ⟺ cold start (no baseline ⇒ engine not invoked).
export function selectState(report: SiftReport | null): State {
    if (report === null) {
        return State.ColdStart;
    }
    if (report.summary.significant_changes === 0) {
        return State.Clean;
    }
    if (hasRegression(report)) {
        return State.Regression;
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
