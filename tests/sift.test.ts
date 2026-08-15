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
