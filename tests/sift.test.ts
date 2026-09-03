// Unit tests for the engine-exec environment scrub (contract §6.1 item 1).
// engineEnv() must hand the C++ engine an allowlisted, credential-free env: the
// process that parses (on a fork PR, attacker-controlled) CI-log content holds
// no GITHUB_TOKEN, no action input, no runtime/OIDC/release secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    engineEnv,
    engineFailureMessage,
    measureUnreadableReport,
    runExplainSetup,
    siftArgs,
    unreadableReportMessage,
    type SiftInvocation,
} from '../src/sift.js';

const baseInvocation: SiftInvocation = {
    siftBin: 'sift',
    baselineLog: 'base.log',
    changedLog: 'changed.log',
    baselineLabel: 'aaaaaaa',
    changedLabel: 'bbbbbbb',
    baselineOutcome: '',
    changedOutcome: '',
    failOn: 'none',
    outputPath: 'report.json',
};

// ── The native-verdict side-inputs (ADR-17.D5) ──────────────────────────────

test('siftArgs: outcome flags are ABSENT when no token — the engine ladder must fall to the console tail', () => {
    const args = siftArgs(baseInvocation);
    assert.ok(!args.includes('--baseline-outcome'));
    assert.ok(!args.includes('--changed-outcome'));
});

test('siftArgs: native tokens forward VERBATIM (no adapter-side translation — SRC-SP-2)', () => {
    const args = siftArgs({ ...baseInvocation, baselineOutcome: 'success', changedOutcome: 'cancelled' });
    const b = args.indexOf('--baseline-outcome');
    const c = args.indexOf('--changed-outcome');
    assert.ok(b >= 0 && args[b + 1] === 'success', 'baseline token must ride verbatim');
    assert.ok(c >= 0 && args[c + 1] === 'cancelled', 'changed token must ride verbatim (never folded to red)');
});

// A caller-declared verdict is a PAIR (DN-32.D6): the native token AND the vocabulary that
// interprets it. This arm pins the BICONDITIONAL — vocabulary present iff a verdict is declared —
// across all four run-token cells (the graph coordinate, the pair's third input since DN-37.D18,
// has its own arms below), and it exists because the cost of breaking it is a hard failure on
// EVERY consumer run.
//
// On the pinned engine the half-pair is FATAL: a token without `--outcome-vocabulary` is refused,
// exit 1, with a diagnostic naming the missing coordinate (preflight's capability probe declares
// and re-measures this at every bump). It was not always so — on engines before `insight-canon
// 86daaf4` the same shape degraded SILENTLY: the token resolved against the STREAM's dialect, a
// raw build log has none, so it resolved to nothing and every verdict-reading rule quietly did not
// apply. Measured on 63 identical-`head_sha` pairs whose ground truth is silence, 60 critical/high
// `regression` rows survived a demotion that could not fire. This arm predates the bump that made
// the class fatal, which is the order the instruments must land in.
//
// Why this is not preflight's job, stated rather than assumed: preflight populates BOTH tokens, so
// it drives exactly ONE of the four cells below. A regression emitting the vocabulary only when
// both tokens are present would pass preflight and break the two single-token cells — which is the
// shape the Action actually sends whenever only one side has a known verdict. Preflight proves the
// vector RUNS; this proves the vector is PAIRED.
test('siftArgs: the verdict PAIR is never half-declared — vocabulary iff token, all four cells', () => {
    const cells: ReadonlyArray<{ baselineOutcome: string; changedOutcome: string; expectVocabulary: boolean }> = [
        { baselineOutcome: '', changedOutcome: '', expectVocabulary: false },
        { baselineOutcome: 'success', changedOutcome: '', expectVocabulary: true },
        { baselineOutcome: '', changedOutcome: 'failure', expectVocabulary: true },
        { baselineOutcome: 'success', changedOutcome: 'failure', expectVocabulary: true },
    ];
    for (const cell of cells) {
        const args = siftArgs({ ...baseInvocation, ...cell });
        const where = `[baseline=${cell.baselineOutcome || '<none>'} changed=${cell.changedOutcome || '<none>'}]`;
        const vocabAt = args.indexOf('--outcome-vocabulary');
        const hasToken = args.includes('--baseline-outcome') || args.includes('--changed-outcome');

        assert.equal(hasToken, cell.expectVocabulary, `${where} token presence disagrees with the cell`);
        assert.equal(
            vocabAt >= 0,
            cell.expectVocabulary,
            `${where} a verdict token without --outcome-vocabulary is a HALF-PAIR: the pinned ` +
                `engine refuses it (exit 1) on every consumer run`,
        );
        if (cell.expectVocabulary) {
            // Pin the VALUE, not merely the flag's presence: a boolean is satisfiable by any path
            // that reaches it, a specific string by one. `github` is the vocabulary that maps
            // GitHub's own `conclusion`/`job.status` tokens.
            assert.equal(args[vocabAt + 1], 'github', `${where} the vocabulary must be 'github'`);
            assert.equal(
                args.filter((a) => a === '--outcome-vocabulary').length,
                1,
                `${where} the vocabulary must be declared exactly once`,
            );
        }
    }
});

test('siftArgs: --outcome-vocabulary is NOT --dialect — the Action never declares a dialect', () => {
    // The guard on the repair, not on the defect. `--outcome-vocabulary github` is a fact about WHO
    // supplies the verdict; `--dialect github` would be a false claim about the log's BYTES, which
    // are frequently raw cmake/ninja output carrying no `##[` marker at all. A false declaration is
    // worse than an absent one because it SUCCEEDS — the dialect enters `semantic_identity` and
    // every document silently becomes incomparable with the truth.
    const args = siftArgs({ ...baseInvocation, baselineOutcome: 'success', changedOutcome: 'failure' });
    assert.ok(!args.includes('--dialect'), 'the Action must never declare a dialect for bytes it did not author');
});

// ── The declared IntentChannel (ADR-22.D4 + ADR-22.D5) ──────────────────────

test('siftArgs: --channel=annotated is ALWAYS declared — this Action fetches the runner raw job log', () => {
    // Unconditional and not an input: joblog.ts fetches via octokit's downloadJobLogsForWorkflowRun,
    // which returns the ANNOTATED materialization (`##[group]Run <cmd>` banners). The Action is the
    // caller that KNOWS, and ADR-22.D4 + ADR-22.D5 say the IntentChannel is declared by the
    // caller, never guessed from content. Drop this flag and the engine fails closed on depth
    // (ADR-22.D5) — the PR comment silently stops comparing step by step. Before the
    // coordinate existed it was worse than silent: the bare `Run ` row fired on annotated
    // prose and invented phantom steps (9.05% of 22030 real logs of exactly this form).
    const args = siftArgs(baseInvocation);
    const idx = args.indexOf('--channel');
    assert.ok(idx >= 0, '--channel must always be declared');
    assert.equal(args[idx + 1], 'annotated', 'the Action fetches the runner RAW job log, not the stripped form');
});

// ── The declared `needs:` job graph (DN-37.D18) ─────────────────────────────

test('siftArgs: --changed-job-graph is ABSENT when no graph — absent is a first-class state, not an empty file', () => {
    const args = siftArgs(baseInvocation);
    assert.ok(!args.includes('--changed-job-graph'), 'no graph acquired ⇒ no flag ⇒ the fold is inert');
});

test('siftArgs: the graph rides as the FILE PATH runSift writes — a declared-empty graph still rides', () => {
    // `[]` is "declared, zero jobs" — a different fact from absent, and the engine acts on the
    // difference (DN-37.D18: one flag, two states, no companion marker).
    const args = siftArgs({ ...baseInvocation, changedJobGraph: { path: '/tmp/g.json', jobs: [] } });
    const idx = args.indexOf('--changed-job-graph');
    assert.ok(idx >= 0, 'a declared graph must ride, even when it declares zero jobs');
    assert.equal(args[idx + 1], '/tmp/g.json', 'the flag carries the path the file is written to');
});

test('siftArgs: a graph CONCLUSION is a declared verdict — the vocabulary pair widens to cover it', () => {
    // The pinned engine REFUSES any non-empty graph `conclusion` with no --outcome-vocabulary
    // (the half-pair refusal at the CLI boundary), and this is a real ship shape: `log:` sourcing
    // with `changed-outcome` unset still acquires a graph whose rows carry API conclusions. The
    // pairing must therefore hold at the emitter with NO run token present.
    const graphed = {
        path: '/tmp/g.json',
        jobs: [
            { key: 'build', display: 'build', needs: [], conclusion: 'success' },
            { key: 'gate', display: 'gate', needs: ['build'], conclusion: 'failure' },
        ],
    };
    const args = siftArgs({ ...baseInvocation, changedJobGraph: graphed });
    const vocabAt = args.indexOf('--outcome-vocabulary');
    assert.ok(vocabAt >= 0, 'a graph conclusion without --outcome-vocabulary is the HALF-PAIR — refused by the pin');
    assert.equal(args[vocabAt + 1], 'github', 'same declarer, same run, same vocabulary');
    assert.equal(
        args.filter((a) => a === '--outcome-vocabulary').length,
        1,
        'run tokens and graph conclusions share ONE vocabulary declaration',
    );
});

test('siftArgs: an all-empty-conclusion graph declares no verdict — NO vocabulary rides on it', () => {
    // Empty is NOT DECLARED (DN-32.D7) — nothing to interpret, so nothing is declared to
    // interpret it with. The biconditional stays exact: vocabulary iff something carries a verdict.
    const inert = {
        path: '/tmp/g.json',
        jobs: [
            { key: 'build', display: '', needs: ['deps'], conclusion: '' },
            { key: 'deps', display: '', needs: [], conclusion: '' },
        ],
    };
    const args = siftArgs({ ...baseInvocation, changedJobGraph: inert });
    assert.ok(args.includes('--changed-job-graph'), 'the declaration itself still travels');
    assert.ok(
        !args.includes('--outcome-vocabulary'),
        'no verdict anywhere ⇒ no vocabulary — declaring one with nothing to interpret breaks the iff',
    );
});

test('siftArgs: --transport=none is ALWAYS declared — deduction is suppressed, never relied on', () => {
    // DN-35.D12. Deduction is content-sensitive and content is exactly what a diff varies, so
    // per-side deduction disagrees precisely when the two sides differ most — measured on this
    // Action's own invocation: `baseline api-rfc3339-line-prefix (deduced), changed none (deduced)`
    // on a homologous pair, costing the UNIT (1 of 16 rows kept a real unit). `none` is the honest
    // declaration: both acquisition paths feed prefix-free bytes (DN-32.D6 build.log; joblog.ts
    // strips runner timestamps before sift sees a byte). One token sets BOTH sides, so asymmetry
    // cannot arise. The engine-side acceptance is the peek reading `none (declared)` — a
    // `(deduced)` that happens to say none is the defect wearing the fix's clothes; THIS arm pins
    // the emitter half: the declaration always rides.
    const args = siftArgs(baseInvocation);
    const idx = args.indexOf('--transport');
    assert.ok(idx >= 0, '--transport must always be declared (deduction suppressed by construction)');
    assert.equal(args[idx + 1], 'none', 'both acquisition paths are prefix-free — none is the honest token');
});

test('siftArgs: --explain is absent by default (opt-in)', () => {
    assert.ok(!siftArgs(baseInvocation).includes('--explain'));
    assert.ok(!siftArgs({ ...baseInvocation, explain: false }).includes('--explain'));
});

test('siftArgs: explain=true adds --explain, no --explain-model unless overridden', () => {
    const args = siftArgs({ ...baseInvocation, explain: true });
    assert.ok(args.includes('--explain'), 'must pass --explain');
    assert.ok(!args.includes('--explain-model'), 'no model override ⇒ the auto-provisioned default');
});

test('siftArgs: an explicit explainModel passes --explain-model NAME', () => {
    const args = siftArgs({ ...baseInvocation, explain: true, explainModel: 'phi-3.5-mini' });
    const i = args.indexOf('--explain-model');
    assert.ok(i >= 0 && args[i + 1] === 'phi-3.5-mini', 'must pass --explain-model NAME');
});

test('siftArgs: --explain-model is NOT passed when explain is off', () => {
    const args = siftArgs({ ...baseInvocation, explain: false, explainModel: 'phi-3.5-mini' });
    assert.ok(!args.includes('--explain') && !args.includes('--explain-model'));
});

test('engineEnv excludes credentials, the action inputs, and runtime tokens', () => {
    const planted: Record<string, string> = {
        GITHUB_TOKEN: 'ghs_token_secret',
        INPUT_TOKEN: 'ghs_input_secret', // any `with: token:`
        ACTIONS_RUNTIME_TOKEN: 'runtime_secret',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc_secret',
        NPM_TOKEN: 'npm_secret',
        AWS_SECRET_ACCESS_KEY: 'aws_secret',
        SIFT_ACTION_RELEASE_TOKEN: 'release_secret',
    };
    for (const [key, value] of Object.entries(planted)) {
        process.env[key] = value;
    }
    try {
        const env = engineEnv();
        for (const key of Object.keys(planted)) {
            assert.ok(!(key in env), `${key} must not reach the engine`);
        }
        // Defence-in-depth: no planted secret leaks under any other key either.
        const values = Object.values(env);
        for (const secret of Object.values(planted)) {
            assert.ok(!values.includes(secret), `secret value must not leak: ${secret}`);
        }
    } finally {
        for (const key of Object.keys(planted)) {
            delete process.env[key];
        }
    }
});

test('engineEnv pins a deterministic, locale-/timezone-invariant environment', () => {
    const env = engineEnv();
    assert.equal(env.LC_ALL, 'C');
    assert.equal(env.LANG, 'C');
    assert.equal(env.TZ, 'UTC');
});

test('engineEnv is a closed env: only the operational allowlist + the pinned trio', () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/home/runner';
    const env = engineEnv();
    assert.equal(env.PATH, '/usr/bin:/bin', 'PATH passes through');
    assert.equal(env.HOME, '/home/runner', 'HOME passes through');
    const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LC_ALL', 'LANG', 'TZ']);
    for (const key of Object.keys(env)) {
        assert.ok(allowed.has(key), `unexpected key in engine env: ${key}`);
    }
});

// ── The engine's exit-code contract (the T4 "enormous log" repair) ────────────
//
// Before this mapping existed, runSift() read the report file unconditionally after
// `ignoreReturnCode: true`. An engine that refused — or crashed on an uncaught bad_alloc
// (exit 134, SIGABRT) — surfaced as `ENOENT: no such file or directory, open
// '.../report.json'`, a message about the Action's own plumbing rather than about the log.
// These arms pin the property that made it a defect: EVERY non-report code produces a
// message, and the two report-bearing codes produce none.

test('engineFailureMessage: the two report-bearing codes are the ONLY silent ones', () => {
    assert.equal(engineFailureMessage(0), null, 'exit 0 writes a report');
    assert.equal(engineFailureMessage(2), null, 'exit 2 is the advisory gate — it writes a report');
});

test('engineFailureMessage: every non-report code is actionable, and none is silent', () => {
    // The closed set (1, 3, 4) plus the shapes outside it. A `null` anywhere here is the
    // original defect: it sends the caller on to read a file the engine never wrote.
    for (const code of [1, 3, 4, 5, 127, 134, 139]) {
        const message = engineFailureMessage(code);
        assert.ok(message !== null, `exit ${code} must not read as "a report was written"`);
        assert.ok(message.length > 40, `exit ${code} message is too thin to act on: ${message}`);
    }
});

test('engineFailureMessage: exit 3 names the ceiling, the check, and the way out', () => {
    const message = engineFailureMessage(3);
    assert.ok(message !== null);
    // The NUMBER — a refusal without it cannot be acted on.
    assert.match(message, /134217728/, 'must state the byte ceiling');
    assert.match(message, /1000000 lines/, 'must state the line ceiling');
    // The CHECK — how a user decides whether their own log fits, before running anything.
    assert.match(message, /wc -lc/);
    // The WAY OUT — a limit with no remedy reads as "this product does not work here".
    assert.match(message, /SIFT_CAPTURE/);
    // And it must say this is a LIMIT, not a failure — the whole point of the repair.
    assert.match(message, /not a crash/);
});

test('engineFailureMessage: a SIGNAL is named as one, because that is what the crash looked like', () => {
    // 134 = 128 + SIGABRT(6) — the exact status the unbounded read used to produce. The
    // engine's ceiling should now prevent it, so reaching here means something else broke;
    // the message must still say "killed by a signal", never "no such file".
    const message = engineFailureMessage(134);
    assert.ok(message !== null);
    assert.match(message, /signal \(6\)/);
    assert.match(message, /out-of-memory/);
    // Below 128 is not a signal and must not claim to be.
    assert.doesNotMatch(engineFailureMessage(5) ?? '', /signal/);
});
// --- the unreadable-report diagnostic -------------------------------------------------
// The engine can exit 0 and still leave an artefact that is not JSON (a raw control byte
// out of a CI log, serialized unescaped). These prove the DIAGNOSIS without spawning an
// engine, the same way the engineFailureMessage tests above do.

// Control bytes are built, never typed: a literal one in a source file is exactly the
// hazard under test, and it does not survive tooling that assumes ASCII.
const NUL = String.fromCharCode(0x00);
const SOH = String.fromCharCode(0x01);
const UNIT_SEP = String.fromCharCode(0x1f);

test('measureUnreadableReport: counts the illegal control bytes and locates the FIRST', () => {
    const raw = `{"where":["a${SOH}b","c${NUL}d"]}`;
    const facts = measureUnreadableReport(raw);
    assert.equal(facts.rawControlBytes, 2);
    assert.equal(facts.firstControlByteOffset, raw.indexOf(SOH));
    assert.equal(facts.reportBytes, Buffer.byteLength(raw, 'utf8'));
});

test('measureUnreadableReport: tab/LF/CR are STRUCTURAL whitespace and are not counted', () => {
    // A prettified report is full of them legally; counting them would make every
    // multi-line artefact look defective and destroy the diagnostic's meaning.
    const facts = measureUnreadableReport('{\n\t"a": 1\r\n}');
    assert.equal(facts.rawControlBytes, 0);
    assert.equal(facts.firstControlByteOffset, null);
});

test('measureUnreadableReport: the size is BYTES, not characters — one unit, not two', () => {
    // 'e' + combining acute is 2 chars / 3 bytes; an offset the user reaches with `dd`
    // must be in the same unit as the length reported beside it.
    const raw = `{"t":"é${UNIT_SEP}"}`;
    const facts = measureUnreadableReport(raw);
    assert.equal(facts.reportBytes, Buffer.byteLength(raw, 'utf8'));
    assert.notEqual(facts.reportBytes, raw.length);
    assert.equal(facts.rawControlBytes, 1);
});

test('unreadableReportMessage: blames the ENGINE, and says UNPARSEABLE rather than ABSENT', () => {
    // The whole point of the guard: the old path reported an engine defect as the
    // Action's own failure, and an existing-but-bad file as a missing one.
    const message = unreadableReportMessage(
        '/tmp/report.json',
        0,
        { reportBytes: 4096, rawControlBytes: 3, firstControlByteOffset: 1234 },
        'Unexpected token',
    );
    assert.match(message, /ENGINE/);
    assert.match(message, /EXISTS/);
    assert.match(message, /not valid JSON/);
    // The absence claim is what the old path made. Assert the NEGATION positively —
    // "not a missing report" is the whole distinction, so a blanket ban on the phrase
    // would forbid the very sentence that carries it.
    assert.doesNotMatch(message, /no such file|ENOENT/i);
    assert.match(message, /not a missing report/);
    // Every number carries its unit and its coordinate.
    assert.match(message, /4096 bytes/);
    assert.match(message, /3 raw control byte\(s\)/);
    assert.match(message, /byte offset 1234/);
});

test('unreadableReportMessage: the parser text is NEUTRALISED — no raw control byte escapes', () => {
    // The parser quotes a fragment of the artefact, and the artefact is what we have just
    // proven carries raw control bytes. This message lands in a job annotation.
    const message = unreadableReportMessage(
        '/tmp/report.json',
        2,
        { reportBytes: 10, rawControlBytes: 1, firstControlByteOffset: 5 },
        `Unexpected token ${SOH} at 5`,
    );
    for (const character of message) {
        assert.ok(
            (character.codePointAt(0) ?? 0) >= 0x20,
            `raw control byte leaked into the annotation: ${JSON.stringify(character)}`,
        );
    }
    assert.match(message, /\\x01/);
});

test('unreadableReportMessage: zero control bytes does NOT claim a control byte', () => {
    // A truncated or half-written report is a different defect; the diagnostic must not
    // assert the control-byte cause when it did not measure one.
    const message = unreadableReportMessage(
        '/tmp/report.json',
        0,
        { reportBytes: 12, rawControlBytes: 0, firstControlByteOffset: null },
        'Unexpected end of JSON input',
    );
    assert.match(message, /no raw control byte/);
    assert.doesNotMatch(message, /byte offset null/);
});

// ── The Action-level bound on `sift explain-setup` ──────────────────────────
//
// The engine's libcurl bound stops a stalled TRANSFER; it cannot stop a wedged PROCESS,
// which produces no exit code and so never reaches the fail-soft degrade. These exercise
// the bound itself against real child processes — a timeout path that has never executed
// is not a timeout path. Fake engines are shell scripts because runExplainSetup always
// appends the literal `explain-setup` argument; the scripts ignore it.

const fakeEngines: string[] = [];

async function fakeEngine(name: string, body: string): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sift-explain-setup-'));
    const file = path.join(dir, name);
    await fsp.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fakeEngines.push(dir);
    return file;
}

test.after(async () => {
    for (const dir of fakeEngines) await fsp.rm(dir, { recursive: true, force: true });
});

test('runExplainSetup: a hanging engine is BOUNDED — it resolves, and says it timed out', async () => {
    // `sleep 600` with no output is the hang the libcurl bound cannot see: alive, silent,
    // producing no exit code. Without the bound this call never resolves.
    const bin = await fakeEngine('hang', 'sleep 600');
    const started = Date.now();
    const result = await runExplainSetup(bin, 300);
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false, 'a bounded hang must not read as success');
    assert.equal(result.timedOutAfterMs, 300, 'the caller branches on this to name the cause');
    assert.match(result.detail, /bound and was terminated/);
    assert.ok(elapsed < 10_000, `must resolve at the bound, not wait for the child (took ${elapsed} ms)`);
});

test('runExplainSetup: the bound RESOLVES rather than throwing — the fail-soft path needs a value', async () => {
    // If the timeout rejected, provisionExplain's `await` would propagate and fail the
    // Action: the exact hard-failure outcome the in-process bound exists to avoid.
    const bin = await fakeEngine('hang2', 'sleep 600');
    await assert.doesNotReject(() => runExplainSetup(bin, 200));
});

test('runExplainSetup: a child that ignores SIGTERM is still bounded (escalation, not patience)', async () => {
    const bin = await fakeEngine('stubborn', 'trap "" TERM\nsleep 600');
    const started = Date.now();
    const result = await runExplainSetup(bin, 300);
    assert.equal(result.ok, false);
    assert.equal(result.timedOutAfterMs, 300);
    assert.ok(Date.now() - started < 10_000, 'the bound must not depend on the child cooperating');
});

test('runExplainSetup: a successful engine returns ok with no timeout marker', async () => {
    const bin = await fakeEngine('ok', 'exit 0');
    const result = await runExplainSetup(bin, 30_000);
    assert.equal(result.ok, true);
    assert.equal(result.timedOutAfterMs, undefined, 'a clean run must not look like a timeout');
});

test('runExplainSetup: a non-zero exit degrades and names the code, not the bound', async () => {
    const bin = await fakeEngine('fail', 'exit 3');
    const result = await runExplainSetup(bin, 30_000);
    assert.equal(result.ok, false);
    assert.equal(result.timedOutAfterMs, undefined);
    assert.match(result.detail, /exited with code 3/);
});

test('runExplainSetup: a missing engine binary degrades, never throws', async () => {
    const result = await runExplainSetup('/nonexistent/sift-binary-that-is-not-there', 30_000);
    assert.equal(result.ok, false);
    assert.equal(result.timedOutAfterMs, undefined);
    assert.match(result.detail, /could not be started/);
});

test('runExplainSetup: the engine child gets the SCRUBBED env (contract §6.1 item 1) — no GITHUB_TOKEN', async () => {
    // The rewrite from exec.exec to spawn had to preserve toolrunner's `result.env =
    // options.env`, i.e. env REPLACEMENT rather than merge. Asserted at the child, not by
    // reading the source: a merge would leak the token into the process that parses
    // attacker-controlled log content on a fork PR.
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'leak-canary-value';
    try {
        const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'sift-env-'));
        const probe = path.join(out, 'env.txt');
        const bin = await fakeEngine('envprobe', `printenv > ${probe}\nexit 0`);
        const result = await runExplainSetup(bin, 30_000);
        assert.equal(result.ok, true);
        const seen = await fsp.readFile(probe, 'utf8');
        assert.ok(!seen.includes('leak-canary-value'), 'GITHUB_TOKEN must not reach the engine');
        assert.match(seen, /^LC_ALL=C$/m, 'the deterministic locale scrub must still be applied');
        await fsp.rm(out, { recursive: true, force: true });
    } finally {
        if (previous === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previous;
    }
});

test('runExplainSetup: the cancellation relay is REMOVED on settle — no listener leak', async () => {
    // The relay exists only while the detached child is alive. If it outlived the call,
    // every subsequent SIGINT/SIGTERM in the run would hit a handler that calls
    // process.exit() on behalf of a child that is long gone.
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };

    const ok = await fakeEngine('relay-ok', 'exit 0');
    await runExplainSetup(ok, 30_000);
    assert.equal(process.listenerCount('SIGINT'), before.int, 'SIGINT handler leaked after a clean run');
    assert.equal(process.listenerCount('SIGTERM'), before.term, 'SIGTERM handler leaked after a clean run');

    const hang = await fakeEngine('relay-hang', 'sleep 600');
    await runExplainSetup(hang, 200);
    assert.equal(process.listenerCount('SIGINT'), before.int, 'SIGINT handler leaked after a timeout');
    assert.equal(process.listenerCount('SIGTERM'), before.term, 'SIGTERM handler leaked after a timeout');

    const bad = await fakeEngine('relay-fail', 'exit 7');
    await runExplainSetup(bad, 30_000);
    assert.equal(process.listenerCount('SIGINT'), before.int, 'SIGINT handler leaked after a failure');
    assert.equal(process.listenerCount('SIGTERM'), before.term, 'SIGTERM handler leaked after a failure');
});
