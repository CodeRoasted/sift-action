// Unit tests for the inline check-run annotation surface (sift_conversion_surface
// § B.3 / § B.5). Three obligations:
//   • Mapping + content — polarity → ::error|warning|notice::; message = the
//     engine's `summary` (+ first `evidence`) VERBATIM (never re-authored).
//   • Level-gating + cap + determinism — reuses `shouldComment`; bounded; pure.
//   • The SECURITY BOUNDARY — `encodeCommandData` (the escapeInline analogue):
//     attacker-controlled CI-log content can never forge or break a workflow
//     command. This is the §B.5 re-audit's fuzz target, exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildAnnotationCommands,
    encodeCommandData,
    MAX_ANNOTATIONS,
} from '../src/annotations.js';
import type { RankedChange, SiftReport } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const SRC = path.join(__dirname, '..', '..', 'src');

function load(name: string): SiftReport {
    return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as SiftReport;
}

function report(rows: RankedChange[], significant = rows.length): SiftReport {
    return {
        report_version: '0.1.0',
        summary: { total_changes: rows.length, significant_changes: significant },
        ranked_changes: rows,
        inputs: {
            baseline: { label: 'a', lines_observed: 100, unique_templates: 5 },
            changed: { label: 'b', lines_observed: 100, unique_templates: 5 },
        },
    };
}

// ── Mapping + verbatim content (§ B.3.2 / B.3.3) ─────────────────────────────

test('regression fixture → ::error:: then ::notice:: (polarity drives severity)', () => {
    const cmds = buildAnnotationCommands(load('regression.json'), 'significant');
    assert.equal(cmds.length, 2);
    assert.ok(cmds[0]!.startsWith('::error::'), cmds[0]); // polarity=regression
    assert.ok(cmds[1]!.startsWith('::notice::'), cmds[1]); // polarity=recovery
});

// Annotation colour is GitHub's NATIVE level icon (error/warning/notice), NOT an emoji
// badge — the §B.4 emoji are the comment surface only. A recovery is ::notice:: (positive,
// not the orange ::warning::); the message stays the engine string verbatim (no glyph prefix).
test('annotation message carries no emoji glyph — colour is the native level icon (§B.4)', () => {
    const cmds = buildAnnotationCommands(load('regression.json'), 'significant');
    for (const cmd of cmds) {
        for (const glyph of ['🟢', '🟥', '🟧', '🟨', '🟦', '🟠', '🟡', '🔴', '⚪']) {
            assert.ok(!cmd.includes(glyph), `annotation must carry no '${glyph}' emoji: ${cmd}`);
        }
    }
});

test('drift fixture → ::warning:: for every (neutral-polarity) significant row', () => {
    const cmds = buildAnnotationCommands(load('drift.json'), 'significant');
    assert.equal(cmds.length, 2);
    for (const cmd of cmds) {
        assert.ok(cmd.startsWith('::warning::'), cmd);
    }
});

test('message = the engine summary + first evidence line, VERBATIM (only transport-encoded)', () => {
    const row = load('regression.json').ranked_changes[0]!;
    const cmd = buildAnnotationCommands(report([row]), 'always')[0]!;
    // The command is the engine's summary + first evidence, joined by a newline,
    // then transport-encoded — nothing re-authored. (This summary carries a literal
    // `%` — "7.0% of changed" — so the encode proves content is preserved as `%25`,
    // not dropped: verbatim content, safely encoded.)
    const expected = `::error::${encodeCommandData(`${row.summary}\n${row.evidence![0]}`)}`;
    assert.equal(cmd, expected);
    assert.ok(cmd.includes('7.0%25 of changed'), 'the content % is encoded, not stripped');
    assert.ok(cmd.includes('%0Aappears 6x on changed'), 'evidence below an encoded line break');
});

test('no file=/line= anchor — Sift diffs logs, not source (check-run-level only)', () => {
    for (const cmd of buildAnnotationCommands(load('regression.json'), 'always')) {
        assert.ok(!/^::\w+ /.test(cmd), `must carry no properties (no fabricated anchor): ${cmd}`);
    }
});

test('a row with no evidence emits the summary alone (no trailing separator)', () => {
    const row: RankedChange = { kind: 'drift', severity: 'medium', significance: 0.3, summary: 'shape shifted' };
    assert.deepEqual(buildAnnotationCommands(report([row]), 'always'), ['::warning::shape shifted']);
});

// WHERE attribution (SRC-D-WHERE-7): the functional location appended to the summary line.
test('a row with WHERE appends the location to the summary line', () => {
    const row: RankedChange = { kind: 'new_error_pattern', severity: 'high', significance: 0.9, summary: 'new error', polarity: 'regression', where: 'src/auth' };
    assert.deepEqual(buildAnnotationCommands(report([row]), 'always'), ['::error::new error · in src/auth']);
});

// The WHERE rides the SAME encoder as the rest of the message — a forged location
// cannot inject a workflow command (the § B.5 encoder boundary covers it too).
test('a forged WHERE is encodeCommandData-encoded (no command breakout)', () => {
    const row: RankedChange = { kind: 'drift', severity: 'medium', significance: 0.3, summary: 'shape shifted', where: 'x\n::set-output name=evil::pwned' };
    const cmd = buildAnnotationCommands(report([row]), 'always')[0]!;
    assert.ok(!cmd.includes('\n::set-output'), cmd); // the newline is encoded → single line, inert
    assert.ok(cmd.startsWith('::warning::shape shifted · in x%0A'), cmd);
});

// ── Level-gating (reuses shouldComment) + cold start ─────────────────────────

test('cold start (report null) emits nothing, even at always', () => {
    assert.deepEqual(buildAnnotationCommands(null, 'always'), []);
});

test('clean report emits nothing at significant OR always (no significant rows)', () => {
    const clean = load('clean_suppressed.json'); // significant_changes 0, no ranked rows
    assert.deepEqual(buildAnnotationCommands(clean, 'significant'), []);
    assert.deepEqual(buildAnnotationCommands(clean, 'always'), []);
});

test('the level ladder matches the comment surface exactly', () => {
    const drift = load('drift.json');
    const regr = load('regression.json');
    assert.deepEqual(buildAnnotationCommands(drift, 'never'), []);
    assert.deepEqual(buildAnnotationCommands(drift, 'regression'), []); // drift is below the regression bar
    assert.equal(buildAnnotationCommands(drift, 'significant').length, 2);
    assert.equal(buildAnnotationCommands(regr, 'regression').length, 2); // regression clears it
});

// ── Cap + determinism (§ B.3.7 / B.5) ────────────────────────────────────────

test('the emitted set is capped at MAX_ANNOTATIONS; the rest stay in the comment', () => {
    const rows: RankedChange[] = Array.from({ length: MAX_ANNOTATIONS + 5 }, (_unused, i) => ({
        kind: 'drift',
        severity: 'medium',
        significance: 0.3,
        summary: `row ${i}`,
    }));
    assert.equal(buildAnnotationCommands(report(rows), 'always').length, MAX_ANNOTATIONS);
});

test('pure: same report ⇒ identical command list', () => {
    const r = load('regression.json');
    assert.deepEqual(buildAnnotationCommands(r, 'always'), buildAnnotationCommands(r, 'always'));
});

// ── The security boundary: command injection cannot survive (§ B.3.5 / B.5) ──
// Engine content derives from CI logs an attacker controls on a fork PR. None of
// it may forge or break a workflow command. A command is recognised only as a
// whole line starting with `::`, so the attack surface is (a) a raw newline that
// starts a second `::`-line and (b) smuggling into the command name before `::`.
// Both are closed by the data encoding — proven here against every vector.

const FORGE =
    'boom 50% off\r\n::error::FORGED regression\n::set-output name=evil::pwned\n   ::warning file=/etc/passwd::leak';

test('encodeCommandData: %/\\r/\\n encoded, % first, output is single-line', () => {
    const enc = encodeCommandData(FORGE);
    assert.ok(!enc.includes('\n'), 'no raw newline survives');
    assert.ok(!enc.includes('\r'), 'no raw carriage return survives');
    assert.ok(enc.includes('50%25 off'), '% is encoded (and only once — % was replaced first)');
    assert.ok(enc.includes('%0D%0A'), 'the CRLF is encoded in order');
});

test('a forged ::error:: / ::set-output:: in log content is inert text, not a command', () => {
    const row: RankedChange = { kind: 'new_error_pattern', severity: 'high', significance: 0.9, summary: FORGE, polarity: 'regression' };
    const cmds = buildAnnotationCommands(report([row]), 'always');
    assert.equal(cmds.length, 1, 'one row ⇒ exactly one command — no injected extras');
    const cmd = cmds[0]!;
    // The whole command is a SINGLE physical line: the runner sees one ::error::,
    // never the forged ::set-output:: / ::warning file=… (they are mid-line data).
    assert.equal(cmd.split('\n').length, 1, cmd);
    assert.ok(cmd.startsWith('::error::'), cmd);
    // Content is preserved (verbatim) but defanged: the forged markers SHOW as text.
    assert.ok(cmd.includes('::error::FORGED regression'.replace('::error::', '')), 'forged text survives as inert data');
    assert.ok(!/\n\s*::/.test(cmd), 'no newline-introduced second command anywhere');
});

test('many malicious rows still yield exactly one command line each (no row can inject another)', () => {
    const rows: RankedChange[] = Array.from({ length: 3 }, () => ({
        kind: 'drift',
        severity: 'medium',
        significance: 0.3,
        summary: FORGE,
    }));
    const lines = buildAnnotationCommands(report(rows), 'always').join('\n').split('\n');
    assert.equal(lines.length, 3, 'N rows ⇒ exactly N command lines — no smuggled extras');
    for (const line of lines) {
        assert.ok(line.startsWith('::warning::'), line);
    }
});

// ── Isolation (§ B.5): the surface reaches no detection / explain / LLM path ──

test('annotations.ts imports ONLY the display types + the verdict ladder', () => {
    const source = readFileSync(path.join(SRC, 'annotations.ts'), 'utf8');
    const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(
        [...new Set(imports)].sort(),
        ['./types.js', './verdict.js'],
        'no detection/explain/engine/network import may reach the annotation surface',
    );
});
