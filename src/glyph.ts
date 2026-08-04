// Status glyphs for the PR-comment top-N rows ONLY (frame.ts renderRow) — the §B.4
// visual-parity layer (PRD-6 § "Badge glyphs", sift_conversion_surface.md § B.4).
// GitHub-flavored markdown has no ANSI, so the web report's heat ladder + recovery-green
// ride emoji HERE — not the `to_markdown` <details> body (byte-frozen, emoji-free) and
// not the annotations (GitHub's native error/warning/notice icons). Two axes, two glyph
// families that must never collapse into a git red/green diff:
//
//   • Severity = a heat SQUARE (importance): 🟦 low · 🟨 medium · 🟧 high · 🟥 critical.
//   • Polarity = a CIRCLE, asymmetric: recovery → a green circle 🟢 as a SECOND glyph
//     (decoupled from heat — a high-heat recovery is still good news); regression /
//     neutral → no circle (a regression rides the hot square + the `· regression` word;
//     a red square beside a green circle must never read as an added/removed diff).
//
// So a HIGH recovery is `🟧 🟢` (square keeps the heat axis), NOT a bare `🟢` — else a
// HIGH-severity and a LOW-severity recovery would render identically.

import type { RankedChange } from './types.js';

// Severity heat SQUARE: slate → amber → orange → crimson.
export function severityGlyph(severity: string): string {
    switch (severity.toLowerCase()) {
        case 'critical':
            return '🟥';
        case 'high':
            return '🟧';
        case 'medium':
            return '🟨';
        default:
            return '🟦'; // low / unknown
    }
}

// The row's glyph(s): the heat square ALWAYS, plus the green recovery circle as a
// SECOND glyph on good-news rows (the two axes are independent — the square never drops).
export function statusGlyph(row: Pick<RankedChange, 'severity' | 'polarity'>): string {
    const square = severityGlyph(row.severity);
    return row.polarity === 'recovery' ? `${square} 🟢` : square;
}
