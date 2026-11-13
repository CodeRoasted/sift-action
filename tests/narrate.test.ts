// The Action's narration (DN-158.D4): the key is the opt-in, it never enters the process that
// parses a log, and a narrative lands as a pure prefix of the report's markdown. Each arm runs the
// shipped `narrateReport` against an injected exec seam that records what would be spawned, so the
// spawn count, the argv and the environment are observed rather than read off the source. The
// fail-soft arms use a fake engine that writes the narration file itself, through the same seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderComment } from '../src/frame.js';
import {
    NO_KEY_LINE,
    NOTHING_TO_NARRATE_LINE,
    narrateReport,
    narrationArgs,
    narrationEnv,
    readNarrationInputs,
    type ExecFn,
    type NarrationInputs,
} from '../src/narrate.js';
import { engineEnv, tamysArgs, type TamysInvocation } from '../src/tamys.js';
import type { TamysCommentContext, TamysReport } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function load(name: string): TamysReport {
    return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as TamysReport;
}

const KEY = 'sk-ant-unit-test-key-0123456789';
const ENDPOINT = 'https://api.example.com/v1/messages?tenant=credential-in-query';
const MODEL = 'claude-haiku-5-5';
const WITH_KEY: NarrationInputs = { apiKey: KEY, endpoint: ENDPOINT, model: MODEL };
const NO_KEY: NarrationInputs = { apiKey: '', endpoint: ENDPOINT, model: MODEL };
const NARRATIVE = '> **AI narrative (advisory)** — the build broke on `error: b failed`.\n\n';

interface Spawn {
    bin: string;
    args: string[];
    env: Record<string, string>;
}

// post: an exec seam that records every spawn and, when `write` is given, writes those bytes to the
// path after `-o` before returning `exitCode` — the narration process as the engine runs it.
function recordingExec(spawns: Spawn[], exitCode: number, write?: Uint8Array | string): ExecFn {
    return async (bin, args, options) => {
        spawns.push({ bin, args: [...args], env: { ...options.env } });
        const at = args.indexOf('-o');
        if (write !== undefined && at >= 0) await fsp.writeFile(args[at + 1]!, write);
        return exitCode;
    };
}

// post: every line `run` wrote to stdout, where @actions/core writes info, warnings and masks.
async function capturingStdout<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const original = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;
    try {
        const value = await run();
        return { value, lines: captured.split(/\r?\n/).filter((line) => line !== '') };
    } finally {
        process.stdout.write = original;
    }
}

async function workDir(): Promise<string> {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'tamys-narrate-'));
}

function describe(spawns: Spawn[], lines: string[]): string {
    return `\n  spawns: ${JSON.stringify(spawns, null, 2)}\n  stdout:\n    ${lines.join('\n    ')}`;
}

function warnings(lines: string[]): string[] {
    return lines.filter((line) => line.startsWith('::warning'));
}

test('narration: no key ⇒ no `tamys explain` spawn, exactly one log line, the report untouched', async () => {
    const dir = await workDir();
    const report = load('drift.json');
    const spawns: Spawn[] = [];
    const { value, lines } = await capturingStdout(() =>
        narrateReport(
            { mode: 'comment', inputs: NO_KEY, tamysBin: 'tamys', reportPath: path.join(dir, 'report.json'), outputPath: path.join(dir, 'narrative.md'), report },
            recordingExec(spawns, 0, NARRATIVE),
        ),
    );
    assert.equal(spawns.length, 0, `a keyless run spawned the narration process${describe(spawns, lines)}`);
    assert.deepEqual(
        lines.filter((line) => line.includes('explain')),
        [NO_KEY_LINE],
        `expected exactly the one line "${NO_KEY_LINE}"${describe(spawns, lines)}`,
    );
    assert.equal(warnings(lines).length, 0, `a keyless run is not a warning${describe(spawns, lines)}`);
    assert.equal(value.report.markdown, report.markdown, 'the keyless report must be byte-identical');
    assert.equal(value.host, undefined, 'no narrative ⇒ no host for the footer');
    await fsp.rm(dir, { recursive: true, force: true });
});

test('narration (DN-158.D11): with a key and no significant change ⇒ no spawn, one plain line, no warning, the keyless comment', async () => {
    const dir = await workDir();
    const drift = load('drift.json');
    const report: TamysReport = { ...drift, summary: { ...drift.summary, significant_changes: 0 } };
    const spawns: Spawn[] = [];
    const { value, lines } = await capturingStdout(() =>
        narrateReport(
            { mode: 'comment', inputs: WITH_KEY, tamysBin: 'tamys', reportPath: path.join(dir, 'report.json'), outputPath: path.join(dir, 'narrative.md'), report },
            recordingExec(spawns, 0, ''),
        ),
    );
    assert.equal(spawns.length, 0, `a report with no significant change spawned the narration process${describe(spawns, lines)}`);
    assert.deepEqual(
        lines.filter((line) => line.includes('explain')),
        [NOTHING_TO_NARRATE_LINE],
        `expected exactly the one line "${NOTHING_TO_NARRATE_LINE}"${describe(spawns, lines)}`,
    );
    assert.equal(NOTHING_TO_NARRATE_LINE, 'explain: no significant changes; nothing to narrate');
    assert.equal(warnings(lines).length, 0, `nothing to narrate is not a warning${describe(spawns, lines)}`);
    assert.equal(value.report, report, 'the report must be the one given, untouched');
    assert.equal(value.host, undefined, 'no narrative ⇒ no host for the footer');
    const keyless = await capturingStdout(() =>
        narrateReport(
            { mode: 'comment', inputs: NO_KEY, tamysBin: 'tamys', reportPath: path.join(dir, 'report.json'), outputPath: path.join(dir, 'narrative.md'), report },
            recordingExec(spawns, 0, ''),
        ),
    );
    const context: TamysCommentContext = { context_version: '0.3.0', head_sha: 'abc1234', base_branch: 'main' };
    assert.equal(
        renderComment(value.report, { ...context, narration_host: value.host }),
        renderComment(keyless.value.report, { ...context, narration_host: keyless.value.host }),
        'the comment differs from a keyless run',
    );
    await fsp.rm(dir, { recursive: true, force: true });
});

test('narration: with a key, ONE spawn of `tamys explain --report … --format md -o …`, its env exactly engineEnv + the three variables', async () => {
    const dir = await workDir();
    const reportPath = path.join(dir, 'report.json');
    const outputPath = path.join(dir, 'narrative.md');
    const report = load('drift.json');
    const spawns: Spawn[] = [];
    // Planted ambient values: the narration env is BUILT from the inputs, never forwarded.
    const planted = { CODEROAST_LLM_TOKEN: 'ambient-token', CODEROAST_LLM_ENDPOINT: 'https://ambient.example', CODEROAST_LLM_MODEL: 'ambient-model', GITHUB_TOKEN: 'ghs_ambient' };
    const previous = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted);
    try {
        const { value, lines } = await capturingStdout(() =>
            narrateReport(
                { mode: 'comment', inputs: WITH_KEY, tamysBin: '/opt/tamys', reportPath, outputPath, report },
                recordingExec(spawns, 0, NARRATIVE),
            ),
        );
        assert.equal(spawns.length, 1, `expected one narration spawn${describe(spawns, lines)}`);
        const spawn = spawns[0]!;
        assert.equal(spawn.bin, '/opt/tamys');
        assert.deepEqual(spawn.args, ['explain', '--report', reportPath, '--format', 'md', '-o', outputPath]);
        const expectedEnv = {
            ...engineEnv(),
            CODEROAST_LLM_ENDPOINT: ENDPOINT,
            CODEROAST_LLM_MODEL: MODEL,
            CODEROAST_LLM_TOKEN: KEY,
        };
        assert.deepEqual(spawn.env, expectedEnv, `the narration env is not engineEnv plus exactly the three${describe(spawns, lines)}`);
        for (const arg of spawn.args) {
            assert.ok(!arg.includes(KEY), `the key rode on argv: ${JSON.stringify(spawn.args)}`);
            assert.ok(!arg.includes('api.example.com'), `the endpoint rode on argv: ${JSON.stringify(spawn.args)}`);
        }
        assert.equal(value.report.markdown, NARRATIVE + report.markdown, 'the narrative must be a pure prefix of the markdown');
        assert.equal(value.host, 'api.example.com', 'the footer gets the host only — never the path or the query');
        assert.equal(warnings(lines).length, 0, `a narrative that arrived is not a warning${describe(spawns, lines)}`);
        assert.ok(!lines.some((line) => line.includes(KEY)), `the key reached the log${describe(spawns, lines)}`);
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
    await fsp.rm(dir, { recursive: true, force: true });
});

test('narration: the DIFF spawn carries no CODEROAST_LLM_* in its env and no --explain on its argv, whatever the ambient env holds', () => {
    const planted = { CODEROAST_LLM_TOKEN: 'ambient-token', CODEROAST_LLM_ENDPOINT: 'https://ambient.example', CODEROAST_LLM_MODEL: 'ambient-model' };
    const previous = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted);
    try {
        const env = engineEnv();
        const leaked = Object.keys(env).filter((name) => name.startsWith('CODEROAST_LLM_'));
        assert.deepEqual(leaked, [], `the diff process would see ${leaked.join(', ')}: ${JSON.stringify(env)}`);
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
    const invocation: TamysInvocation = {
        tamysBin: 'tamys',
        baselineLog: 'base.log',
        changedLog: 'changed.log',
        baselineLabel: 'aaaaaaa',
        changedLabel: 'bbbbbbb',
        baselineOutcome: 'success',
        changedOutcome: 'failure',
        failOn: 'high',
        outputPath: 'report.json',
        changedTransport: [],
    };
    const args = tamysArgs(invocation);
    const explainFlags = args.filter((arg) => arg.startsWith('--explain'));
    assert.deepEqual(explainFlags, [], `the diff argv carries ${explainFlags.join(' ')}: ${args.join(' ')}`);
});

test('narration: the argv and env builders put neither the key nor the endpoint on a command line', () => {
    const args = narrationArgs('/w/report.json', '/w/narrative.md');
    assert.deepEqual(args, ['explain', '--report', '/w/report.json', '--format', 'md', '-o', '/w/narrative.md']);
    const env = narrationEnv(WITH_KEY);
    assert.equal(env.CODEROAST_LLM_TOKEN, KEY);
    assert.equal(env.CODEROAST_LLM_ENDPOINT, ENDPOINT);
    assert.equal(env.CODEROAST_LLM_MODEL, MODEL);
});

test('narration: the key is masked with core.setSecret the moment it is read', async () => {
    const names = ['INPUT_EXPLAIN-API-KEY', 'INPUT_EXPLAIN-ENDPOINT', 'INPUT_EXPLAIN-MODEL'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env['INPUT_EXPLAIN-API-KEY'] = KEY;
    process.env['INPUT_EXPLAIN-ENDPOINT'] = ENDPOINT;
    process.env['INPUT_EXPLAIN-MODEL'] = MODEL;
    try {
        const { value, lines } = await capturingStdout(async () => readNarrationInputs());
        assert.deepEqual(value, WITH_KEY);
        assert.ok(lines.includes(`::add-mask::${KEY}`), `core.setSecret did not receive the key; stdout:\n    ${lines.join('\n    ')}`);
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('narration: an empty key is not masked and reads as the keyless mode', async () => {
    const previous = process.env['INPUT_EXPLAIN-API-KEY'];
    delete process.env['INPUT_EXPLAIN-API-KEY'];
    try {
        const { value, lines } = await capturingStdout(async () => readNarrationInputs());
        assert.equal(value.apiKey, '');
        assert.ok(!lines.some((line) => line.startsWith('::add-mask::')), `an empty key was masked; stdout:\n    ${lines.join('\n    ')}`);
    } finally {
        if (previous !== undefined) process.env['INPUT_EXPLAIN-API-KEY'] = previous;
    }
});

test('narration: `render` mode with a key ⇒ one warning naming the reason and no spawn', async () => {
    const dir = await workDir();
    const report = load('drift.json');
    const spawns: Spawn[] = [];
    const { value, lines } = await capturingStdout(() =>
        narrateReport(
            { mode: 'render', inputs: WITH_KEY, tamysBin: 'tamys', reportPath: path.join(dir, 'report.json'), outputPath: path.join(dir, 'narrative.md'), report },
            recordingExec(spawns, 0, NARRATIVE),
        ),
    );
    assert.equal(spawns.length, 0, `render mode spawned the narration process${describe(spawns, lines)}`);
    const warned = warnings(lines);
    assert.equal(warned.length, 1, `expected one warning${describe(spawns, lines)}`);
    assert.match(warned[0]!, /render/, 'the warning must name render mode as the reason');
    assert.equal(value.report.markdown, report.markdown);
    assert.equal(value.host, undefined);
    await fsp.rm(dir, { recursive: true, force: true });
});

// Each failure shape the narration process can present, and the bytes the fake engine leaves.
const FAILURES: ReadonlyArray<{ name: string; exitCode: number; write?: Uint8Array | string }> = [
    { name: 'a non-zero exit', exitCode: 1, write: NARRATIVE },
    { name: 'no file at all', exitCode: 0 },
    { name: 'an empty file', exitCode: 0, write: '' },
    { name: 'a control byte in the narrative', exitCode: 0, write: `${NARRATIVE}${String.fromCharCode(0x1b)}[31m` },
    { name: 'a narrative that is not UTF-8', exitCode: 0, write: Uint8Array.from([0x3e, 0x20, 0xc3, 0x28, 0x0a]) },
];

for (const failure of FAILURES) {
    test(`narration: ${failure.name} ⇒ one warning, and the comment of a keyless run`, async () => {
        const dir = await workDir();
        const report = load('drift.json');
        const spawns: Spawn[] = [];
        const { value, lines } = await capturingStdout(() =>
            narrateReport(
                { mode: 'comment', inputs: WITH_KEY, tamysBin: 'tamys', reportPath: path.join(dir, 'report.json'), outputPath: path.join(dir, 'narrative.md'), report },
                recordingExec(spawns, failure.exitCode, failure.write),
            ),
        );
        assert.equal(spawns.length, 1, `expected the one narration spawn${describe(spawns, lines)}`);
        assert.equal(warnings(lines).length, 1, `expected exactly one warning${describe(spawns, lines)}`);
        assert.equal(value.report.markdown, report.markdown, 'a failed narration must leave the markdown as it was');
        assert.equal(value.host, undefined, 'a failed narration must leave the footer as it was');
        const context: TamysCommentContext = { context_version: '0.3.0', head_sha: 'abc1234', base_branch: 'main' };
        assert.equal(
            renderComment(value.report, { ...context, narration_host: value.host }),
            renderComment(report, context),
            'the comment differs from a keyless run',
        );
        await fsp.rm(dir, { recursive: true, force: true });
    });
}

test('narration: the narrative is prefixed BEFORE the frame measures the comment budget', async () => {
    const dir = await workDir();
    const base = load('drift.json');
    // A markdown that embeds alone, and a narrative that takes the composed comment past the
    // 65 536-byte budget: the frame must see the prefixed markdown and declare it.
    const report: TamysReport = { ...base, markdown: 'm'.repeat(40_000) };
    const context: TamysCommentContext = { context_version: '0.3.0', head_sha: 'abc1234', base_branch: 'main' };
    assert.ok(renderComment(report, context).includes('m'.repeat(40_000)), 'control: the markdown alone must embed');
    const spawns: Spawn[] = [];
    const big = `> ${'n'.repeat(30_000)}\n\n`;
    const { value } = await capturingStdout(() =>
        narrateReport(
            { mode: 'comment', inputs: WITH_KEY, tamysBin: 'tamys', reportPath: path.join(dir, 'report.json'), outputPath: path.join(dir, 'narrative.md'), report },
            recordingExec(spawns, 0, big),
        ),
    );
    const out = renderComment(value.report, { ...context, narration_host: value.host });
    assert.ok(!out.includes('m'.repeat(40_000)), 'the frame embedded a markdown its narrative takes past the budget');
    assert.match(out, /The full report is 70,0\d\d B of markdown, too large to embed/, out.slice(-1_200));
    await fsp.rm(dir, { recursive: true, force: true });
});

test('footer: a narrative changes the determinism claim to the report and names the host; without one it is unchanged', () => {
    const report = load('drift.json');
    const context: TamysCommentContext = { context_version: '0.3.0', head_sha: 'abc1234', base_branch: 'main' };
    const without = renderComment(report, context);
    assert.match(without, /<sub>Deterministic — same inputs, same comment\. Runs in your CI; your logs never leave it\. · /);
    const narrated = renderComment(report, { ...context, narration_host: 'api.anthropic.com' });
    assert.ok(
        narrated.includes(
            "<sub>Deterministic report: same inputs, same report. The advisory narrative is a model's draw. " +
                "Runs in your CI; your logs never leave it, and the narration sent only Tamys's summary to " +
                '`api.anthropic.com`. · ',
        ),
        narrated.slice(-600),
    );
    assert.ok(!narrated.includes('same inputs, same comment'), 'a narrated comment still claims "same inputs, same comment"');
});
