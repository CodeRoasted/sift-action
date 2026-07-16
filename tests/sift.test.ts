// Unit tests for the engine-exec environment scrub (contract §6.1 item 1).
// engineEnv() must hand the C++ engine an allowlisted, credential-free env: the
// process that parses (on a fork PR, attacker-controlled) CI-log content holds
// no GITHUB_TOKEN, no action input, no runtime/OIDC/release secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { engineEnv, siftArgs, type SiftInvocation } from '../src/sift.js';

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

// ── The native-verdict side-inputs (ADR 0025 §3.1) ──────────────────────────

test('siftArgs: outcome flags are ABSENT when no token — the engine ladder must fall to the console tail', () => {
    const args = siftArgs(baseInvocation);
    assert.ok(!args.includes('--baseline-outcome'));
    assert.ok(!args.includes('--changed-outcome'));
});

test('siftArgs: native tokens forward VERBATIM (no adapter-side translation — SP-2)', () => {
    const args = siftArgs({ ...baseInvocation, baselineOutcome: 'success', changedOutcome: 'cancelled' });
    const b = args.indexOf('--baseline-outcome');
    const c = args.indexOf('--changed-outcome');
    assert.ok(b >= 0 && args[b + 1] === 'success', 'baseline token must ride verbatim');
    assert.ok(c >= 0 && args[c + 1] === 'cancelled', 'changed token must ride verbatim (never folded to red)');
});

// ── The declared Sink (ADR 0028 D5) ─────────────────────────────────────────

test('siftArgs: --sink=annotated is ALWAYS declared — this Action fetches the runner raw job log', () => {
    // Unconditional and not an input: joblog.ts fetches via octokit's downloadJobLogsForWorkflowRun,
    // which returns the ANNOTATED materialization (`##[group]Run <cmd>` banners). The Action is the
    // caller that KNOWS, and ADR 0028 D2 says the Sink is declared by the caller, never guessed from
    // content. Drop this flag and the engine fails closed on depth (D5) — the PR comment silently stops
    // comparing step by step. Before ADR 0028 it was worse than silent: the bare `Run ` row fired on
    // annotated prose and invented phantom steps (9.05% of 22030 real logs of exactly this form).
    const args = siftArgs(baseInvocation);
    const idx = args.indexOf('--sink');
    assert.ok(idx >= 0, '--sink must always be declared');
    assert.equal(args[idx + 1], 'annotated', 'the Action fetches the runner RAW job log, not the stripped form');
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
