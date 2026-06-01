// The Sift Action's type surface.
//
// Two halves, mirroring the render boundary (sift_action_contract.md § 1):
//   • `SiftReport`         — the ENGINE's content. A structural subset of the
//                            `ChangeReport` JSON (insight-eidos
//                            diff/api/insight/diff/change_report.hpp) — only the
//                            fields the frame reads. The engine owns these.
//   • `SiftCommentContext` — the CI/git/GitHub envelope the ENGINE cannot know
//                            (contract § 2.2). The Action assembles it.
//
// The comment body is a pure function of (report, context); see `frame.ts`.

// ── Engine side: the report JSON (content) ──────────────────────────────────

// Mirrors `dto::RankedChange` (diff/src/change_report_serialize.cpp). `severity`
// is lowercase on the wire ("low"|"medium"|"high"|"critical"); `polarity` is
// omitted when Neutral (only "regression"|"recovery" appear). Rows are surfaced
// VERBATIM — the Action never re-authors `summary`/`evidence` (contract § 1).
export interface RankedChange {
    kind: string;
    severity: string;
    significance: number;
    summary: string;
    polarity?: 'regression' | 'recovery';
    template_id?: string;
    phase?: string;
    evidence?: string[];
    baseline_line_refs?: number[];
    changed_line_refs?: number[];
}

export interface ReportSummary {
    total_changes: number;        // every observed delta — the "of 851" suppression number
    significant_changes: number;  // the subset that cleared the floor — the "3 that matter"
    js_divergence?: number;
    stability_score?: number;
}

export interface InputProvenance {
    label: string;
    lines_observed: number;
    unique_templates: number;
    window_start_iso?: string;
    window_end_iso?: string;
}

// The engine's `--format both` output: the structured report plus the
// pre-rendered markdown body as a top-level sibling (`markdown`). The frame
// reads the structured fields and embeds `markdown` verbatim in the <details>.
export interface SiftReport {
    report_version: string;
    summary: ReportSummary;
    ranked_changes: RankedChange[];
    inputs: { baseline: InputProvenance; changed: InputProvenance };
    markdown?: string; // present with --format both
}

// ── Action side: the CI envelope (contract § 2.2) ───────────────────────────

export type BuildStatus = 'green' | 'red' | 'unknown';

export interface BaselineProvenance {
    sha: string;
    run_id: string;
    run_url: string;
    branch: string;
    created_at: string;
}

// Versioned envelope handed to the frame renderer alongside the report. When
// `baseline` is absent the run is a cold start (state ①) and no report exists.
export interface SiftCommentContext {
    context_version: string;
    head_sha: string;
    pr_number: number;
    base_branch: string;        // the PR's base — needed for the cold-start copy
    build_status: BuildStatus;  // OPTIONAL enhancer; "unknown" degrades gracefully
    baseline?: BaselineProvenance; // absent ⇒ cold start
}

export const CONTEXT_VERSION = '0.1.0';

// The self-published baseline store (contract § 3): every run uploads its ingested
// log under this name; a PR resolves its baseline by pulling the same-named
// artifact off the base branch's last green run. One name, both sides.
export const BASELINE_ARTIFACT_NAME = 'sift-baseline-log';
