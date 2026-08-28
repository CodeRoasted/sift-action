// Engine invocation. The Action shells out to the pinned `sift` binary (provided
// by Argos's packaging — a downloaded release asset, or in-image for Docker) with
// `--format both -o report.json`: one file carrying the structured report AND the
// pre-rendered markdown body (the `markdown` sibling the <details> embeds). The
// `--fail-on` exit code is the authoritative advisory gate (sift exits 2 when the
// condition holds) — captured here, never recomputed.

import * as exec from '@actions/exec';
import { promises as fs } from 'fs';
import type { DeclaredJobWire } from './jobgraph.js';
import { MAX_CHANGED_LOG_BYTES, type SiftReport } from './types.js';

export type FailOn = 'none' | 'significant' | 'regression';

export interface SiftInvocation {
    siftBin: string;
    baselineLog: string;
    changedLog: string;
    baselineLabel: string;
    changedLabel: string;
    // The runs' NATIVE CI verdict tokens, verbatim (ADR-17.D5) — forwarded as
    // `--baseline-outcome` / `--changed-outcome`; the ENGINE's dialect package maps
    // them (SRC-SP-2 — the adapter never translates). Empty ⇒ flag omitted ⇒ the engine's
    // SRC-D-OUT-RUN-1 ladder falls to the console tail, then Unknown.
    baselineOutcome: string;
    changedOutcome: string;
    failOn: FailOn;
    outputPath: string;
    // Opt-in AI narrative (ADR-13.D5). The pinned local model + server are provisioned by
    // runExplainSetup() before this runs; `sift --explain` then auto-spawns the bundled server,
    // narrates additively, and tears it down. Fail-soft: a missing/unreachable model leaves the
    // deterministic report + the gate exit code untouched. No credential — the Action never carries one.
    explain?: boolean;
    explainModel?: string; // advanced override; default = the auto-provisioned pinned model
    // The CHANGED run's declared `needs:` job graph (DN-37.D18 — a JSON file behind
    // `--changed-job-graph`), produced by jobgraph.ts. ABSENT (undefined) ⇒ no flag ⇒ the fold is
    // inert; a present-but-empty `jobs` array declares a workflow with zero jobs — different facts,
    // and the engine acts on the difference. There is deliberately no baseline half: the fold
    // operates on the changed run's aggregator, and the flag NAME carries that asymmetry.
    // runSift() writes `jobs` to `path` before exec; siftArgs() only names the path.
    changedJobGraph?: { path: string; jobs: DeclaredJobWire[] };
}

export interface SiftResult {
    report: SiftReport;
    exitCode: number; // sift's --fail-on verdict: 0 = pass, 2 = condition held
}

// The engine's CLOSED exit-code set (`sift --help` § Exit codes). Only SUCCESS and
// GATE_TRIPPED leave a report behind; every other code means there is no file to read, and
// reading anyway is how a real failure got reported as a filesystem error.
//
// This is not a defensive nicety. Before it existed, runSift() read the report file
// unconditionally after `ignoreReturnCode: true`, so an engine that had refused — or, when
// the log was large enough to exhaust the runner, CRASHED on an uncaught bad_alloc — surfaced
// to the user as `ENOENT: no such file or directory, open '.../report.json'`. That message
// names the wrong subject entirely: it points at the Action's own plumbing while the actual
// event was "your log did not fit", and it is the last message a prospect sees before
// deciding the tool does not work.
const SIFT_EXIT = {
    SUCCESS: 0,
    USAGE_ERROR: 1,
    GATE_TRIPPED: 2,
    INPUT_TOO_LARGE: 3,
    INTERNAL_ERROR: 4,
} as const;

// Thrown when the engine produced no report. Carries the exit code so callers can branch
// without re-parsing a message.
export class SiftEngineError extends Error {
    constructor(
        message: string,
        readonly exitCode: number,
    ) {
        super(message);
        this.name = 'SiftEngineError';
    }
}

// Pure: the engine's exit code → the message a user can act on, or null when the code means
// "a report was written". Exported for unit tests — this mapping IS the contract, and it
// should be provable without spawning a binary.
export function engineFailureMessage(exitCode: number): string | null {
    switch (exitCode) {
        case SIFT_EXIT.SUCCESS:
        case SIFT_EXIT.GATE_TRIPPED:
            return null;
        case SIFT_EXIT.USAGE_ERROR:
            return (
                'Sift could not read one of the logs, or was called with bad arguments ' +
                '(engine exit 1). Check the `log:` path, or the `target-job` name if you use ' +
                "zero-plumbing sourcing — the engine's own message is in the step log above."
            );
        case SIFT_EXIT.INPUT_TOO_LARGE:
            return (
                'Sift refused this run: one of the logs is over the engine ceiling of ' +
                `${MAX_CHANGED_LOG_BYTES} bytes / 1000000 lines per input (engine exit 3). ` +
                'Check with `wc -lc` on the log. This is a declared limit, not a crash — the ' +
                'engine will not diff a truncated window, because that answers a different ' +
                'question without saying so. Narrow what you compare with the SIFT_CAPTURE ' +
                'markers (see the `capture` input) and Sift will run on the sections you mark.'
            );
        case SIFT_EXIT.INTERNAL_ERROR:
            return (
                'The Sift engine hit an internal error (exit 4). This is a bug — please report ' +
                'it at https://github.com/CodeRoasted/sift-action/issues with the engine ' +
                'message from the step log above and the output of `wc -lc` on both logs.'
            );
        default:
            // A code outside the closed set — in practice a signal (128+n; 134 = SIGABRT).
            // Named explicitly because "unknown" is exactly what the old ENOENT path said.
            return (
                `The Sift engine exited with an unexpected status (${exitCode}). ` +
                (exitCode > 128
                    ? `That is a signal (${exitCode - 128}), so the engine was killed rather ` +
                      'than returning — a runner out-of-memory kill is the usual cause. '
                    : '') +
                'This is a bug — please report it with the step log and `wc -lc` on both logs.'
            );
    }
}

// RFC 8259 §7: every character below U+0020 MUST be escaped inside a JSON string. Tab, LF
// and CR are excluded from the count below — not because they are legal raw inside a string
// (they are not), but because they are also legal WHITESPACE between tokens, so their raw
// presence is not on its own evidence of a defect. Every other byte in the range is.
const CONTROL_BYTE_CEILING = 0x20;
const STRUCTURAL_WHITESPACE_BYTES: readonly number[] = [0x09, 0x0a, 0x0d];

// What we can say about an artefact that is not JSON. Counted and located, never QUOTED:
// the bytes came from the user's CI log, and this message lands in a job annotation — a
// published surface. "Logs never leave the CI" is a perimeter, so this reports SHAPE.
export interface UnreadableReportFacts {
    reportBytes: number;
    rawControlBytes: number;
    firstControlByteOffset: number | null;
}

// Measured on the BYTES, not on the decoded string: a byte offset a user can reach with
// `dd`/`wc -c` is one unit, and mixing a character index with a byte length would be two.
// Control bytes are single-byte in UTF-8 and never appear as continuation bytes (>= 0x80),
// so scanning the buffer is exact rather than approximate.
export function measureUnreadableReport(raw: string): UnreadableReportFacts {
    const buffer = Buffer.from(raw, 'utf8');
    let rawControlBytes = 0;
    let firstControlByteOffset: number | null = null;
    for (let offset = 0; offset < buffer.length; offset++) {
        const byte = buffer[offset]!;
        if (byte >= CONTROL_BYTE_CEILING || STRUCTURAL_WHITESPACE_BYTES.includes(byte)) {
            continue;
        }
        rawControlBytes++;
        firstControlByteOffset ??= offset;
    }
    return { reportBytes: buffer.length, rawControlBytes, firstControlByteOffset };
}

// The parser's own message can carry a fragment of the artefact (V8 quotes context around
// the offending token), and the artefact is exactly what we have just proven contains raw
// control bytes. Neutralise them rather than drop the message: when rawControlBytes is 0
// this string is the ONLY diagnostic we have.
function withControlBytesNeutralised(message: string): string {
    let neutralised = '';
    for (const character of message) {
        const code = character.codePointAt(0) ?? 0;
        neutralised +=
            code < CONTROL_BYTE_CEILING
                ? `\\x${code.toString(16).padStart(2, '0')}`
                : character;
    }
    return neutralised;
}

// Pure, and exported for tests for the same reason engineFailureMessage is: this diagnosis
// IS the contract, and it should be provable without spawning an engine or writing a file.
export function unreadableReportMessage(
    outputPath: string,
    exitCode: number,
    facts: UnreadableReportFacts,
    parserMessage: string,
): string {
    const shape =
        facts.rawControlBytes > 0
            ? `${facts.rawControlBytes} raw control byte(s) — value < 0x20 outside tab/LF/CR, ` +
              'which RFC 8259 §7 requires a JSON writer to escape — first at byte offset ' +
              `${facts.firstControlByteOffset}`
            : 'no raw control byte, so the malformation is something else';
    return (
        `The Sift ENGINE wrote an unreadable report. It exited ${exitCode} (a report-bearing ` +
        `code) and the file at ${outputPath} EXISTS, but it is not valid JSON. This is a defect ` +
        'in the engine that produced the artefact — not a missing report, and not a problem ' +
        'with your log, your workflow inputs, or your permissions. ' +
        `Measured on the artefact: ${facts.reportBytes} bytes, ${shape}. ` +
        `Parser: ${withControlBytesNeutralised(parserMessage)}. ` +
        'The Action FAILS here rather than posting nothing, because a Sift comment that ' +
        'silently does not appear is indistinguishable from "Sift found nothing to report" — ' +
        'and a false all-clear is the one outcome a precision-first tool cannot ship. ' +
        'Please report it at https://github.com/CodeRoasted/sift-action/issues with this ' +
        'message and the engine version.'
    );
}

// Distinct from SiftEngineError, and the distinction is the whole point of the class:
// SiftEngineError means "the engine produced NO report", this one means "the engine
// produced a report and got it WRONG". Collapsing them would send the user hunting for a
// file that is sitting on disk. Carries the facts typed, so a caller can branch on the
// shape without re-parsing prose.
export class SiftReportUnreadableError extends Error {
    constructor(
        message: string,
        readonly exitCode: number,
        readonly facts: UnreadableReportFacts,
    ) {
        super(message);
        this.name = 'SiftReportUnreadableError';
    }
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
        // ADR-22.D4 + ADR-22.D5 — the IntentChannel is caller-declared provenance, and this
        // Action IS the caller that knows: it fetches both logs with octokit's
        // downloadJobLogsForWorkflowRun (joblog.ts), which returns the runner's RAW job log —
        // the `annotated` materialization, where step banners are `##[group]Run <cmd>` and a
        // line starting with a bare `Run ` is ordinary prose.
        //
        // Unconditional, not an input: it is a fact about how this Action acquires logs, not a knob a
        // workflow author could know better than we do. Without it sift fails closed on DEPTH
        // (ADR-22.D5) and would compare these logs without claiming step structure; WITH it,
        // and before the coordinate existed, the bare `Run ` row fired on that prose and minted
        // phantom Step quanta — measured on 9.05% of 22030 real annotated logs, i.e. exactly the
        // form this line declares.
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
    // Sent whenever ANY declared verdict is present — a run token on either side, or a job
    // conclusion inside the declared graph, which the engine interprets through this SAME
    // vocabulary (DN-37.D18: same declarer, same run; a second vocabulary field would be a second
    // enumeration of one concept). Without it a run token resolves against the stream's dialect,
    // which a raw build log does not have — the token then resolves to nothing and every rule that
    // reads the verdict silently does not apply — and a graph conclusion is REFUSED outright: the
    // pinned engine exits non-zero on any non-empty `conclusion` with no vocabulary (the half-pair
    // refusal, at the CLI boundary). All-empty conclusions assert nothing and need no vocabulary.
    const graphDeclaresConclusion =
        invocation.changedJobGraph?.jobs.some((job) => job.conclusion !== '') ?? false;
    if (invocation.baselineOutcome || invocation.changedOutcome || graphDeclaresConclusion) {
        args.push('--outcome-vocabulary', 'github');
    }
    if (invocation.baselineOutcome) {
        args.push('--baseline-outcome', invocation.baselineOutcome);
    }
    if (invocation.changedOutcome) {
        args.push('--changed-outcome', invocation.changedOutcome);
    }
    // DN-37.D18 — the declared `needs:` graph rides as a FILE: `needs` is genuinely nested, and
    // flat flags cannot carry a nesting without inventing a separator convention JSON already
    // spells. Present ⇒ the flag names the path runSift() writes; absent ⇒ no flag, fold inert.
    if (invocation.changedJobGraph) {
        args.push('--changed-job-graph', invocation.changedJobGraph.path);
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
    // The graph file the vector names — written here, where the other file IO already lives, so
    // siftArgs stays pure (unit-testable without spawning). All four wire fields always travel:
    // the type guarantees presence, and JSON.stringify of the literal-ordered objects is
    // deterministic for a given graph.
    if (invocation.changedJobGraph) {
        await fs.writeFile(
            invocation.changedJobGraph.path,
            JSON.stringify(invocation.changedJobGraph.jobs),
        );
    }
    // ignoreReturnCode: exit 2 is the advisory gate, not an Action error — so the code must be
    // INSPECTED here rather than ignored. The distinction the old code lost: `ignoreReturnCode`
    // means "do not throw on non-zero", not "non-zero carries no information".
    // env: a scrubbed, credential-free environment (see engineEnv).
    const exitCode = await exec.exec(invocation.siftBin, siftArgs(invocation), {
        ignoreReturnCode: true,
        env: engineEnv(),
    });
    // Checked BEFORE the read, which is the whole fix: on any failing code there is no report
    // file, and reading first turns the engine's actionable message into an ENOENT about ours.
    const failure = engineFailureMessage(exitCode);
    if (failure !== null) {
        throw new SiftEngineError(failure, exitCode);
    }
    const raw = await fs.readFile(invocation.outputPath, 'utf8');
    // The exit-code check above was built for "engine failed, no file". It is DEFEATED by
    // "engine succeeded, bad file": engineFailureMessage() returns null on 0 and 2, so a
    // report-bearing code with a malformed artefact walks straight into JSON.parse and the
    // user gets a bare SyntaxError attributed to sift-action — the same wrong-subject
    // failure the SIFT_EXIT block above exists to prevent, entered through the other door.
    //
    // This is a DIAGNOSTIC, not a gate: it does not repair the artefact and must not read
    // as if it had. It names the engine as the source and says unparseable, never absent.
    //
    // FAIL rather than degrade, and the argument is the exit code's provenance. Degrading
    // would mean trusting exit 0 as "nothing significant changed" — but that code comes
    // from the very component that has just demonstrated it does not validate its own
    // output. "The engine did not error out" and "your logs are clean" are not the same
    // claim, and nothing here can tell them apart. Posting nothing would render our bug as
    // the user's all-clear. `fail-on` does not soften this: it governs verdicts about the
    // user's code, and exits 1/3/4 already fail irrespective of it — an unreadable report
    // belongs in that set, and only reached this line because the exit code lied.
    try {
        return { report: JSON.parse(raw) as SiftReport, exitCode };
    } catch (error) {
        const facts = measureUnreadableReport(raw);
        throw new SiftReportUnreadableError(
            unreadableReportMessage(
                invocation.outputPath,
                exitCode,
                facts,
                error instanceof Error ? error.message : String(error),
            ),
            exitCode,
            facts,
        );
    }
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
