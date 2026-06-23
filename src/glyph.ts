// Status glyphs — the colour the no-ANSI surfaces carry (B.4 visual parity,
// sift_conversion_surface.md § B.4). GitHub-flavored markdown (the PR comment +
// the job summary) and the Checks-tab annotations cannot render ANSI, so the CLI's
// 256-colour heat ladder + recovery-green (terminal_render.cpp § badge_code) ride an
// emoji glyph instead. This is the ONE place the comment, the job summary, and the
// annotations agree on colour — mirror the C++ severity_emoji/status_emoji
// (change_report_serialize.cpp) byte-for-byte so the surfaces read identically.

import type { RankedChange } from './types.js';

// Severity heat ladder, as emoji: slate → amber → orange → crimson.
export function severityGlyph(severity: string): string {
    switch (severity.toLowerCase()) {
        case 'critical':
            return '🔴'; // crimson
        case 'high':
            return '🟠'; // orange
        case 'medium':
            return '🟡'; // amber
        default:
            return '⚪'; // low / unknown — slate
    }
}

// The row status glyph — mirrors the CLI's badge_code EXACTLY: a recovery reads
// GREEN (a semantic better/worse signal, decoupled from severity heat — an error
// that no longer fires is good news, not a low warning); everything else rides the
// severity tier.
export function statusGlyph(row: Pick<RankedChange, 'severity' | 'polarity'>): string {
    return row.polarity === 'recovery' ? '🟢' : severityGlyph(row.severity);
}
