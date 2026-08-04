// Inline check-run annotations — the 4th Action output surface
// (bibles/sift_action.md § B / sift_conversion_surface.md § B.3).
//
// GitHub `::error|warning|notice::` workflow commands surface in the Checks tab
// and the PR "checks were not successful" strip. They are written to STDOUT and
// need NO write token, so the UNPRIVILEGED fork build job (mode=render) emits
// them and they appear on a fork PR's checks — fork-safe by construction; the
// privileged workflow_run poster is untouched (§ B.3.6).
//
// This module is a PURE function of the report: same report ⇒ same command list.
// It reads ONLY the engine's `ranked_changes` (display data) + the verdict ladder
// — no detection / explain / LLM path is reachable from here (§ B.5 isolation).
// The Action never re-authors a row: the message is the engine's `summary` (+
// first `evidence` line) VERBATIM, only transport-encoded (contract § 1).

import type { RankedChange, SiftReport } from './types.js';
import { selectState, shouldComment, type CommentLevel } from './verdict.js';

// Defensive cap on emitted annotations: the top significant rows, aligned to
// GitHub's 10-per-severity-per-step display sweet spot (§ B.3.7). The FULL set
// always lives in the PR comment + <details>, so this never hides signal — Sift's
// "3 that matter" pitch sits far below it. Mirrors frame.ts's MAX_INLINE_ROWS:
// a structural bound, not a product limit.
export const MAX_ANNOTATIONS = 10;

// ── The security boundary: workflow-command data encoding ────────────────────
// The message carries engine content derived from real — and on fork PRs,
// ATTACKER-controlled — CI logs. It must be SAFELY EMBEDDED in a workflow command
// exactly as `escapeInline` (frame.ts) safely embeds a row in the comment: the
// escape IS the trust boundary (contract § 3 / adr/0014 § 3).
//
// A workflow command is recognised only as a WHOLE LINE beginning (after leading
// whitespace) with `::`. So forging or breaking a command requires either a raw
// newline (to start a second `::`-line) or smuggling text into the command name /
// properties — which sit BEFORE the `::` we ourselves write (`::warning::`). Both
// are closed by GitHub's data encoding, applied here:
//   %  → %25   (FIRST, so the %0D/%0A introduced below are not re-encoded)
//   \r → %0D
//   \n → %0A
// After it the data is GUARANTEED single-line and never at line-start (it always
// follows our literal `::<kind>::`), so an injected `::error::…` / `::set-output::`
// is inert text, mid-line — the `::` command-introducer is neutralised (§ B.3.5).
// This is the exact escapeData the @actions/core toolkit applies; owned + tested
// here so the §B.5 re-audit has a concrete encoder to fuzz, like escapeInline.
export function encodeCommandData(raw: string): string {
    return raw.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// Polarity → annotation severity (§ B.3.3). Annotations are ADVISORY — they never
// fail the build (only the exit-code `--fail-on` gate does), consistent with "the
// comment never says we blocked your merge":
//   regression → ::error::   recovery → ::notice::   other significant → ::warning::
export type AnnotationKind = 'error' | 'warning' | 'notice';

function mapKind(polarity: RankedChange['polarity']): AnnotationKind {
    if (polarity === 'regression') {
        return 'error';
    }
    if (polarity === 'recovery') {
        return 'notice';
    }
    return 'warning';
}

// One ranked row → one encoded check-level workflow command. NO `file=`/`line=`
// anchor: Sift diffs LOGS, not source, so there is no honest source `file:line`
// to pin to — a guessed anchor would violate precision-first (§ B.3.2,
// adr/0013). The message is the engine's `summary` plus its first `evidence`
// line (the deterministic "here's the line"), surfaced verbatim, then encoded.
//
// Colour here is GitHub's NATIVE error/warning/notice icon (mapKind, § B.3.3) — a
// recovery → ::notice:: reads positive, NOT the orange ::warning::. The §B.4 emoji
// badges are the COMMENT's surface only (PRD-6 § "Badge glyphs"); the message
// stays the engine string verbatim so the §B.5 re-audit has a pure encoder to fuzz.
function annotationCommand(row: RankedChange): string {
    const firstEvidence = row.evidence?.[0];
    // WHERE attribution (SRC-D-WHERE-7): the functional location appended to the summary
    // line (plain text — annotations are not markdown). The whole message, WHERE
    // included, is encodeCommandData'd below — the surface's one encoder.
    const summaryLine = row.where ? `${row.summary} · in ${row.where}` : row.summary;
    const message = firstEvidence ? `${summaryLine}\n${firstEvidence}` : summaryLine;
    return `::${mapKind(row.polarity)}::${encodeCommandData(message)}`;
}

// The full ordered list of encoded workflow-command lines to emit, level-gated.
//
// The surface carries its OWN level (a separate axis from pr-comment / fail-on,
// contract § 3), reusing `shouldComment` VERBATIM (§ B.3.8): below the level ⇒ no
// annotations. With the `significant` default a clean run has no significant rows,
// so `significant ≡ always ≡ zero annotations` on clean. Cold start (report null)
// ⇒ no rows ⇒ empty. Rows are already ranked (regressions first) and are the
// significant set; the cap is a defensive tail-bound.
export function buildAnnotationCommands(report: SiftReport | null, level: CommentLevel): string[] {
    if (report === null) {
        return [];
    }
    if (!shouldComment(selectState(report), level)) {
        return [];
    }
    return report.ranked_changes.slice(0, MAX_ANNOTATIONS).map(annotationCommand);
}
