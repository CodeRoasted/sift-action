// The Sift Action's type surface.
//
// Two halves, mirroring the render boundary (sift_action_contract.md § 1):
//   • `SiftReport`         — the ENGINE's content. A structural subset of the
//                            `ChangeReport` JSON (insight-eidos
//                            sift/api/sift.api-report.cppm) — only the
//                            fields the frame reads. The engine owns these.
//   • `SiftCommentContext` — the CI/git/GitHub envelope the ENGINE cannot know
//                            (contract § 2.2). The Action assembles it.
//
// The comment body is a pure function of (report, context); see `frame.ts`.

// ── Engine side: the report JSON (content) ──────────────────────────────────

// Mirrors `dto::RankedChange` (sift/src/report/change_report_serialize.cpp). `severity`
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
    // WHERE attribution (D-WHERE-6): the finding's functional location (canon
    // `component`, e.g. "src/auth"). Omitted when the window carried no admissible
    // location. Engine CONTENT — escaped per surface (escapeInline / encodeCommandData).
    where?: string;
    evidence?: string[];
    baseline_line_refs?: number[];
    changed_line_refs?: number[];
}

// The run verdicts (ADR 0025 §5 — the diff-layer home of the four classes). Uppercase
// enum strings on the wire ("SUCCESS"|"FAILURE"|"UNSTABLE"|"ABORTED"), OMITTED when
// Unknown; `outcome_regressed` (strictly worse on Success < Unstable < Failure;
// Aborted/Unknown excluded) is emitted only when true. The frame, the verdict state,
// and the green-gated re-seed read THESE — the engine-resolved verdict, never a
// render-side binary (the retired `build_status`).
export type RunOutcome = 'SUCCESS' | 'FAILURE' | 'UNSTABLE' | 'ABORTED';

export interface ReportSummary {
    total_changes: number;        // every observed delta — the "of 851" suppression number
    significant_changes: number;  // the subset that cleared the floor — the "3 that matter"
    js_divergence?: number;
    stability_score?: number;
    baseline_outcome?: RunOutcome;   // absent = Unknown (no verdict observed)
    changed_outcome?: RunOutcome;    // absent = Unknown
    outcome_regressed?: boolean;     // present only when true
    baseline_outcome_note?: string;  // fail-closed note (unmapped token) — surfaced, never silent
    changed_outcome_note?: string;
}

export interface InputProvenance {
    label: string;
    lines_observed: number;
    // Omitted by the engine when the path did not measure it — the aligned path, which is the
    // one the Action's `sift a.log b.log` invocation takes, never counts whole-log templates.
    // Optional here also keeps an older engine's always-present key readable.
    unique_templates?: number;
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

export interface BaselineProvenance {
    /** How the baseline was selected: a branch's last green run, a named artifact, or a local file. */
    kind: 'run' | 'artifact' | 'path';
    sha: string;
    run_id: string;
    run_url: string;
    branch: string;
    created_at: string;
    /** artifact: the artifact name; path: the file path. Absent for kind 'run'. */
    label?: string;
}

// Versioned envelope handed to the frame renderer alongside the report. When
// `baseline` is absent the run is a cold start (state ①) and no report exists.
// `baseline_source` is the human label of the CONFIGURED source (cold-start copy);
// `comment_tag` namespaces the sticky marker + title so two sift invocations in
// one job (e.g. vs-main and vs-previous) can hold two distinct comments.
export interface SiftCommentContext {
    context_version: string;
    head_sha: string;
    pr_number?: number;         // absent on a PUSH (trunk commit) — there is no PR (contract § 3)
    base_branch: string;        // the PR's base, or the pushed branch — needed for the cold-start copy
    baseline?: BaselineProvenance; // absent ⇒ cold start
    baseline_source?: string;   // human label of a non-default configured source (cold-start copy)
    comment_tag?: string;       // namespaces the sticky marker + title (multi-diff jobs)
}

// 0.2.0: the render-side `build_status` binary is RETIRED (ADR 0025 §5) — the run verdict
// now flows THROUGH the engine (`--changed-outcome`) and the frame reads the four-class
// pair off `ReportSummary`, never a CI envelope flag.
export const CONTEXT_VERSION = '0.2.0';

// The self-published baseline store (contract § 3): every run uploads its ingested
// log under this name; a PR resolves its baseline by pulling the same-named
// artifact off the base branch's last green run. One name, both sides.
export const BASELINE_ARTIFACT_NAME = 'sift-baseline-log';

// The baseline artifact's stamped provenance sidecar (ADR 0025 §3.1): the publishing
// run stamps its NATIVE CI verdict token (verbatim — the adapter never translates,
// SP-2) so the next run can forward it as `--baseline-outcome`. Absent sidecar /
// empty token ⇒ no flag ⇒ the engine's D-OUT-RUN-1 ladder falls to the console
// tail, then Unknown — absence is the designed degenerate path, never an error.
export const BASELINE_META_FILE = 'sift-baseline-meta.json';
export interface BaselineMeta {
    context_version: string;
    /** The publishing run's native CI verdict token, verbatim (e.g. "success"). */
    outcome_token: string;
}

// ── Fork-PR render → workflow_run post boundary (contract § 6.1) ─────────────
//
// `render` mode writes the (already Gate-B-escaped) comment body + head_sha meta
// into $RUNNER_TEMP/sift-comment/; the consumer's workflow uploads that directory
// as the `sift-comment` artifact (examples/fork-safe/build.yml). `post` mode
// downloads that artifact off the triggering run and upserts the comment. The
// body is INERT (escapeInline/escapeHtml) — the escape IS the trust boundary, so
// the poster never parses a log or runs the engine. `pr_number` is deliberately
// NOT carried: the poster re-derives it from the TRUSTED `workflow_run` head_sha
// via the PRs API, never a fork-supplied value.
export const SIFT_COMMENT_ARTIFACT_NAME = 'sift-comment';
export const SIFT_COMMENT_DIR = 'sift-comment'; // under $RUNNER_TEMP (consumer uploads it)
export const RENDERED_BODY_FILE = 'comment-body.md';
export const RENDERED_META_FILE = 'comment-meta.json';

// Size bounds the poster enforces (contract § 6.1: "bound the downloaded artifact
// size"). The compressed cap gates on the artifact METADATA before any bytes
// transfer; the body cap is GitHub's hard issue-comment limit — a larger body
// could not post anyway.
export const MAX_RENDERED_ARTIFACT_BYTES = 1024 * 1024; // 1 MiB, compressed (pre-download gate)
export const MAX_RENDERED_BODY_BYTES = 65_536; // GitHub issue-comment hard limit (chars≈bytes)

// Provenance the build job stamps into the artifact meta. `head_sha` is
// cross-checked against the trusted `workflow_run` event head_sha (defence in
// depth); it is NEVER the source of `pr_number`.
export interface RenderedCommentMeta {
    context_version: string;
    head_sha: string;
    should_post: boolean; // render stamps the pr-comment verdict; the poster honours it (absent ⇒ post, for back-compat)
}
