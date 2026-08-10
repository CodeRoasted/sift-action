// Engine invocation. The Action shells out to the pinned `sift` binary (provided
// by Argos's packaging — a downloaded release asset, or in-image for Docker) with
// `--format both -o report.json`: one file carrying the structured report AND the
// pre-rendered markdown body (the `markdown` sibling the <details> embeds). The
// `--fail-on` exit code is the authoritative advisory gate (sift exits 2 when the
// condition holds) — captured here, never recomputed.

import * as exec from '@actions/exec';
import { promises as fs } from 'fs';
import type { SiftReport } from './types.js';

export type FailOn = 'none' | 'significant' | 'regression';

export interface SiftInvocation {
    siftBin: string;
    baselineLog: string;
    changedLog: string;
    baselineLabel: string;
    changedLabel: string;
    // The runs' NATIVE CI verdict tokens, verbatim (ADR 0025 §3.1) — forwarded as
    // `--baseline-outcome` / `--changed-outcome`; the ENGINE's dialect package maps
    // them (SRC-SP-2 — the adapter never translates). Empty ⇒ flag omitted ⇒ the engine's
    // SRC-D-OUT-RUN-1 ladder falls to the console tail, then Unknown.
    baselineOutcome: string;
    changedOutcome: string;
    failOn: FailOn;
    outputPath: string;
    // Opt-in AI narrative (adr/0009). The pinned local model + server are provisioned by
    // runExplainSetup() before this runs; `sift --explain` then auto-spawns the bundled server,
    // narrates additively, and tears it down. Fail-soft: a missing/unreachable model leaves the
    // deterministic report + the gate exit code untouched. No credential — the Action never carries one.
    explain?: boolean;
    explainModel?: string; // advanced override; default = the auto-provisioned pinned model
}

export interface SiftResult {
    report: SiftReport;
    exitCode: number; // sift's --fail-on verdict: 0 = pass, 2 = condition held
}

// Operational, non-secret env the engine may legitimately need from the runner.
// PATH (any libc subprocess), HOME / TMPDIR (temp-file resolution). Deliberately
// NOT here: LD_LIBRARY_PATH (the binary is portable, system-lib only) and every
// credential-bearing var.
const ENGINE_ENV_PASSTHROUGH = ['PATH', 'HOME', 'TMPDIR'] as const;

// The engine is a pure file-in / report-out batch process: two log files in, a
// report.json out. It needs NO credentials. We hand it an allowlisted, secret-
// free environment so the workflow's GITHUB_TOKEN, the action's INPUT_* (incl.
// any `with:` token), the ACTIONS_* runtime tokens, and any *_TOKEN/_SECRET/_KEY
// the job exports never enter the C++ process. @actions/exec forwards `env`
// straight to child_process.spawn, which REPLACES the environment (no merge), so
// the child sees exactly this map. Prerequisite for ever arming the
// pull_request_target fork path (contract §6.1 item 1): even on a fork PR, the
// engine that parses attacker-controlled log content holds no secret. LC_ALL /
// LANG / TZ are pinned so the run is locale-/timezone-invariant across runners —
// the engine is deterministic by construction (canon det_math); this keeps the
// environment from being a way to perturb it.
export function engineEnv(): Record<string, string> {
    const env: Record<string, string> = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
    for (const key of ENGINE_ENV_PASSTHROUGH) {
        const value = process.env[key];
        if (value !== undefined) {
            env[key] = value;
        }
    }
    return env;
}

// Pure: the exact `sift` argv for an invocation (exported so it is unit-testable without spawning).
export function siftArgs(invocation: SiftInvocation): string[] {
    const args = [
        invocation.baselineLog,
        invocation.changedLog,
        '--format',
        'both',
        '-o',
        invocation.outputPath,
        '--baseline-label',
        invocation.baselineLabel,
        '--changed-label',
        invocation.changedLabel,
        // ADR 0029 — the IntentChannel is caller-declared provenance, and this Action IS the caller that
        // knows: it fetches both logs with octokit's downloadJobLogsForWorkflowRun (joblog.ts), which
        // returns the runner's RAW job log — the `annotated` materialization, where step banners are
        // `##[group]Run <cmd>` and a line starting with a bare `Run ` is ordinary prose.
        //
        // Unconditional, not an input: it is a fact about how this Action acquires logs, not a knob a
        // workflow author could know better than we do. Without it sift fails closed on DEPTH (D5) and
        // would compare these logs without claiming step structure; WITH it, and before the coordinate
        // existed, the bare `Run ` row fired on that prose and minted phantom Step quanta — measured on
        // 9.05% of 22030 real annotated logs, i.e. exactly the form this line declares.
        '--channel',
        'annotated',
        // DN-35.D12 — the transport is DECLARED, symmetrically, and `none` is the honest answer
        // for this stream: DN-32.D6 established that what this Action diffs is `build.log`, raw
        // build output with no delivery prefix to unwind.
        //
        // `--transport` sets BOTH sides from one token, which is the point: deduction is
        // content-sensitive, and content is exactly what a diff varies, so a per-side deduction
        // disagrees precisely when the two sides differ most. Measured on this Action's own
        // invocation before this line existed: `baseline api-rfc3339-line-prefix (deduced),
        // changed none (deduced)` on a homologous pair — same API, same repo, same workflow.
        // The cost was not the verdict (identical either way) but the UNIT: 1 of 16 rows kept a
        // real unit under the asymmetry against 12 of 12 when both sides agreed, which starves
        // the DN-31.D9 roll-up of the attribution it acts on.
        //
        // Declaring it here makes asymmetry impossible by construction rather than refusable
        // after the fact — there is nothing to refuse when the answer is known. Unconditional and
        // not an input, for the same reason as `--channel` above: it is a fact about what this
        // Action acquires, not a knob a workflow author could know better.
        '--transport',
        'none',
    ];
    // DN-32.D6 — a caller-declared verdict is a PAIR: the native token AND the vocabulary that
    // interprets it. Unconditional and not an input, for the same reason as `--channel` above: it
    // is a fact about WHO SUPPLIES the verdict — this Action runs on GitHub Actions and forwards
    // GitHub's own `conclusion` / `job.status` — never a fact about the log's bytes.
    //
    // ⚠ THIS IS NOT `--dialect github`, AND MUST NEVER BE REPLACED BY IT. The logs this Action
    // diffs are frequently a raw build log (cmake/ninja/conan output with no `##[` marker at all),
    // where "no dialect" is the TRUE answer. Declaring a dialect those bytes do not have is a FALSE
    // declaration, and a false one is worse than an unknown one because it SUCCEEDS: canon applies
    // GHA marker rows to build output, and the composed dialect enters `semantic_identity`, so
    // every document becomes incomparable with the truth for a reason no reader can see. The
    // vocabulary coordinate touches no composition and cannot move that identity.
    //
    // Sent whenever EITHER token is present: without it the engine resolves the token against the
    // stream's dialect, which a raw build log does not have — the token then resolves to nothing
    // and every rule that reads the verdict silently does not apply.
    if (invocation.baselineOutcome || invocation.changedOutcome) {
        args.push('--outcome-vocabulary', 'github');
    }
    if (invocation.baselineOutcome) {
        args.push('--baseline-outcome', invocation.baselineOutcome);
    }
    if (invocation.changedOutcome) {
        args.push('--changed-outcome', invocation.changedOutcome);
    }
    if (invocation.failOn !== 'none') {
        args.push('--fail-on', invocation.failOn);
    }
    if (invocation.explain) {
        // Assets are already provisioned (runExplainSetup ran first); `sift --explain` spawns the bundled
        // local server itself. Fail-soft in the binary: no endpoint reached ⇒ no narrative, report + exit
        // code unchanged. The --fail-on exit code ignores the narrative (engine GateExitCodeIgnoresNarrative).
        args.push('--explain');
        if (invocation.explainModel) {
            args.push('--explain-model', invocation.explainModel);
        }
    }
    return args;
}

export async function runSift(invocation: SiftInvocation): Promise<SiftResult> {
    // ignoreReturnCode: a non-zero exit is the advisory gate, not an Action error.
    // env: a scrubbed, credential-free environment (see engineEnv).
    const exitCode = await exec.exec(invocation.siftBin, siftArgs(invocation), {
        ignoreReturnCode: true,
        env: engineEnv(),
    });
    const raw = await fs.readFile(invocation.outputPath, 'utf8');
    const report = JSON.parse(raw) as SiftReport;
    return { report, exitCode };
}

// `sift explain-setup`: download + SHA-256-verify + cache the pinned model + inference server from the
// public CodeRoasted/sift-explain-model HF repo (no credential). Idempotent — a cache hit re-verifies + skips the
// fetch. Fail-soft: a failure (network / cache service / sha mismatch) is a warning, NOT an Action
// failure — `sift --explain` then degrades to no-narrative on the (non-TTY) CI run. Secret-free env.
export async function runExplainSetup(siftBin: string): Promise<boolean> {
    const exitCode = await exec.exec(siftBin, ['explain-setup'], {
        ignoreReturnCode: true,
        env: engineEnv(),
    });
    return exitCode === 0;
}
