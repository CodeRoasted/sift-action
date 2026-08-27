// Status glyphs for the PR comment ONLY — the §B.4 visual-parity layer (PRD-6
// § "Badge glyphs", sift_conversion_surface.md § B.4). GitHub-flavored markdown has no
// ANSI, so the web report's heat ladder + recovery-green ride emoji HERE — not the
// `to_markdown` <details> body (byte-frozen, emoji-free) and not the annotations
// (GitHub's native error/warning/notice icons). Two axes, two glyph families that must
// never collapse into a git red/green diff — and since the rows are grouped by
// severity, the two axes now sit at two different ALTITUDES:
//
//   • Severity = a heat SQUARE (importance): 🟦 low · 🟨 medium · 🟧 high · 🟥 critical.
//     It rides the SECTION heading, once, because the section IS the severity — a row
//     inside it cannot carry a different one.
//   • Polarity = a CIRCLE, asymmetric: recovery → a green circle 🟢 on the ROW
//     (decoupled from heat — a high-heat recovery is still good news); regression /
//     neutral → no circle (a regression rides the section's hot square + the
//     `regression` word; a red square beside a green circle must never read as an
//     added/removed diff).
//
// The heat axis is NOT lost by moving up: a HIGH recovery still reads 🟧 (section) then
// 🟢 (row), so a HIGH-severity and a LOW-severity recovery never render identically.

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

// The row's polarity glyph: the green recovery circle on good-news rows, nothing
// otherwise. Empty string ⇒ the caller composes no separator (an absent direction
// renders nothing at all — no placeholder, no gap).
export function polarityGlyph(polarity: string | undefined): string {
    return polarity === 'recovery' ? '🟢' : '';
}
