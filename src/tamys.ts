// Engine invocation. The Action shells out to the pinned `tamys` binary (provided
// by Argos's packaging — a downloaded release asset, or in-image for Docker) with
// `--format both -o report.json`: one file carrying the structured report AND the
// pre-rendered markdown body (the `markdown` sibling the <details> embeds). The
// `--fail-on` exit code is the authoritative advisory gate (tamys exits 2 when the
// condition holds) — captured here, never recomputed.

import * as exec from '@actions/exec';
import { promises as fs } from 'fs';
import { statesAJobConclusion, statesAListedStepConclusion, type DeclaredJobWire } from './jobgraph.js';
import {
    MAX_CHANGED_LOG_BYTES,
    MAX_ENGINE_ALIGNMENT_CELLS,
    MAX_ENGINE_LINE_BYTES,
    type RankedChange,
    type TamysReport,
} from './types.js';

// The gate values the PINNED engine parses (`tamys --fail-on`, DN-132.D2's single gate since engine
// 1.10.8: none | medium | high | critical). It trips on the run's declared verdict getting worse, or on
// a listed row that got worse (polarity Regression) at that severity or above. The Action forwards
// the value and reads the exit code; it never decides the gate.
export const FAIL_ON_VALUES = ['none', 'medium', 'high', 'critical'] as const;
export type FailOn = (typeof FAIL_ON_VALUES)[number];

// The `fail-on` input, lower-cased; empty is `none`. Any other value FAILS the run as a config
// error, as a malformed `baseline` does: mapping it to `none` silently disabled the gate of a
// workflow that believed itself gated (DN-132.D2). No alias and no mapping hint — the message
// names the values the pinned engine takes.
export function parseFailOn(raw: string): FailOn {
    const value = (raw || 'none').trim().toLowerCase();
    const failOn = FAIL_ON_VALUES.find((known) => known === value);
    if (failOn === undefined) {
        throw new Error(`invalid \`fail-on\` input "${raw}" — expected ${FAIL_ON_VALUES.join(' | ')}`);
    }
    return failOn;
}

export interface TamysInvocation {
    tamysBin: string;
    baselineLog: string;
    changedLog: string;
    baselineLabel: string;
    changedLabel: string;
    // The runs' NATIVE CI verdict tokens, verbatim (ADR-17.D5) — forwarded as
    // `--baseline-outcome` / `--changed-outcome`; the ENGINE's dialect package maps
    // them — the adapter never translates. Empty ⇒ flag omitted ⇒ the engine's
    // run-outcome ladder (ADR-17.D5) falls to the console tail, then Unknown.
    baselineOutcome: string;
    changedOutcome: string;
    failOn: FailOn;
    outputPath: string;
    // Each side's delivery stack, outermost first, declared from how THAT side was acquired
    // (DN-89.D38 §4): the API job-log stack for a `target-job` log, the empty stack (`none`) for
    // a `log:` file, a stored baseline's own recorded stack. `baselineTransport` undefined leaves
    // the baseline side UNDECLARED — a `path=` file, whose delivery the Action does not know, so
    // the engine deduces it and reports what it read (ADR-14.D9's carve-out).
    changedTransport: readonly string[];
    baselineTransport?: readonly string[];
    // The changed log's provenance, declared by the acquirer that fetched ONE job's log by its id
    // (DN-140.D4): the listing row's id and, when it states one, its attempt. The engine names a
    // listed failed step only when the rendering it joins agrees with both. Undefined for a `log:`
    // file, whose job and attempt the Action does not know. There is no baseline half: no row
    // naming a step rests on the baseline side, so its flags have no reader (DN-140.D9).
    changedLogProvenance?: { jobId: number; attempt: number | null };
    // The CHANGED run's declared job graph (ADR-22.D13 — a JSON file behind
    // `--changed-job-graph`), produced by jobgraph.ts. ABSENT (undefined) ⇒ no flag ⇒ the graph's
    // readers are inert; a present-but-empty `jobs` array declares a workflow with zero jobs —
    // different facts, and the engine acts on the difference.
    // runTamys() writes `jobs` to `path` before exec; tamysArgs() only names the path.
    changedJobGraph?: { path: string; jobs: DeclaredJobWire[] };
    // The BASELINE run's declared job graph (`--baseline-job-graph`), the same wire, read after the
    // fact by `resolveBaselineJobGraph`. Its one reader is the step-template route: a banner is
    // classed by its declared step text only when BOTH runs supply their own (DN-89.D34).
    baselineJobGraph?: { path: string; jobs: DeclaredJobWire[] };
}

export interface TamysResult {
    report: TamysReport;
    exitCode: number; // tamys's --fail-on verdict: 0 = pass, 2 = condition held
}

// The engine's CLOSED exit-code set (`tamys --help` § Exit codes). Only SUCCESS and
// GATE_TRIPPED leave a report behind; every other code means there is no file to read, and
// reading anyway is how a real failure got reported as a filesystem error.
//
// This is not a defensive nicety. Before it existed, runTamys() read the report file
// unconditionally after `ignoreReturnCode: true`, so an engine that had refused — or, when
// the log was large enough to exhaust the runner, CRASHED on an uncaught bad_alloc — surfaced
// to the user as `ENOENT: no such file or directory, open '.../report.json'`. That message
// names the wrong subject entirely: it points at the Action's own plumbing while the actual
// event was "your log did not fit", and it is the last message a prospect sees before
// deciding the tool does not work.
const TAMYS_EXIT = {
    SUCCESS: 0,
    USAGE_ERROR: 1,
    GATE_TRIPPED: 2,
    INPUT_TOO_LARGE: 3,
    INTERNAL_ERROR: 4,
} as const;

// Thrown when the engine produced no report. Carries the exit code so callers can branch
// without re-parsing a message.
export class TamysEngineError extends Error {
    constructor(
        message: string,
        readonly exitCode: number,
    ) {
        super(message);
        this.name = 'TamysEngineError';
    }
}

// Pure: the engine's exit code → the message a user can act on, or null when the code means
// "a report was written". Exported for unit tests — this mapping IS the contract, and it
// should be provable without spawning a binary.
export function engineFailureMessage(exitCode: number): string | null {
    switch (exitCode) {
        case TAMYS_EXIT.SUCCESS:
        case TAMYS_EXIT.GATE_TRIPPED:
            return null;
        case TAMYS_EXIT.USAGE_ERROR:
            return (
                'Tamys could not read one of the logs, could not write its report, or was called ' +
                'with bad arguments (engine exit 1). Check the `log:` path, the runner\'s free ' +
                'disk space, or the `target-job` name if you use zero-plumbing sourcing — the ' +
                "engine's own message is in the step log above."
            );
        case TAMYS_EXIT.INPUT_TOO_LARGE:
            return (
                'Tamys refused this run: one of the logs is over the engine ceiling of ' +
                `${MAX_CHANGED_LOG_BYTES} bytes / 1000000 lines per input, or has a line over ` +
                `${MAX_ENGINE_LINE_BYTES} bytes per line, or the two logs need more than ` +
                `${MAX_ENGINE_ALIGNMENT_CELLS} step-alignment cells (baseline steps x changed ` +
                'steps, summed over every job they share) (engine exit 3). ' +
                'Check with `wc -lc` on the log, and find long lines with ' +
                `\`LC_ALL=C awk 'length($0) > ${MAX_ENGINE_LINE_BYTES}' <log>\`; ` +
                "the engine's own message in the step log above names the bound it hit. " +
                'This is a declared limit, not a crash — the ' +
                'engine will not diff a truncated window, because that answers a different ' +
                'question without saying so. Narrow what you compare with the TAMYS_CAPTURE ' +
                'markers (see the `capture` input) and Tamys will run on the sections you mark.'
            );
        case TAMYS_EXIT.INTERNAL_ERROR:
            return (
                'The Tamys engine hit an internal error (exit 4). This is a bug — please report ' +
                'it at https://github.com/CodeRoasted/sift-action/issues with the engine ' +
                'message from the step log above and the output of `wc -lc` on both logs.'
            );
        default:
            // A code outside the closed set — in practice a signal (128+n; 134 = SIGABRT).
            // Named explicitly because "unknown" is exactly what the old ENOENT path said.
            return (
                `The Tamys engine exited with an unexpected status (${exitCode}). ` +
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
export function measureUnreadableReport(raw: string | Uint8Array): UnreadableReportFacts {
    const buffer = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
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

// The three ways a report can break the engine's output contract, each carrying what was
// MEASURED about it and never a byte of its content.
//   not-utf8           the file is not well-formed UTF-8, the encoding JSON declares
//                      (RFC 8259 §8.1); `offset` is where a strict decoder first refuses it,
//                      and equals the file's length when it ends inside a sequence.
//   not-json           the bytes decode, and the text is not JSON.
//   control-in-display the JSON parses, and text the Action displays carries a control byte.
export type ReportDefect =
    | { kind: 'not-utf8'; offset: number }
    | { kind: 'not-json'; parserMessage: string }
    | { kind: 'control-in-display'; violations: DisplayViolation[] };

// One displayed field holding a control byte: its path in the report, the first offending code
// unit and that unit's index in the field's string.
export interface DisplayViolation {
    field: string;
    codeUnit: number;
    index: number;
}

const DELETE_BYTE = 0x7f;
const LINE_FEED_BYTE = 0x0a;

// A row's text is one line: every byte below 0x20, and DEL, is a breach. The rendered markdown
// is many lines: its breach is a byte below 0x20 other than the line feed.
type DisplayText = 'row' | 'rendered';

function firstControlUnit(text: string, kind: DisplayText): { codeUnit: number; index: number } | null {
    for (let index = 0; index < text.length; index++) {
        const codeUnit = text.charCodeAt(index);
        const breach =
            kind === 'row'
                ? codeUnit < CONTROL_BYTE_CEILING || codeUnit === DELETE_BYTE
                : codeUnit < CONTROL_BYTE_CEILING && codeUnit !== LINE_FEED_BYTE;
        if (breach) {
            return { codeUnit, index };
        }
    }
    return null;
}

// The engine neutralises its display text ONCE, by the terminal's rule, so a row reads the same
// in a terminal and in the comment. The Action therefore CHECKS and never repairs: a second
// neutraliser here would be a second copy of that rule, and it would re-author rows the comment
// promises to show verbatim. The fields are exactly the ones the Action embeds — a row's
// `summary`, `where` and `evidence`, where any byte below 0x20 or DEL is a breach, and the
// rendered `markdown`, whose only control byte is the line feed the renderer writes itself.
// Identity fields (`phase`, `template_id`, the input labels) are not display text: the engine
// keeps them faithful, and the Action does not embed them.
export function displayViolations(report: TamysReport): DisplayViolation[] {
    const violations: DisplayViolation[] = [];
    const check = (field: string, text: unknown, kind: DisplayText): void => {
        if (typeof text !== 'string') {
            return;
        }
        const found = firstControlUnit(text, kind);
        if (found !== null) {
            violations.push({ field, ...found });
        }
    };
    const rows: RankedChange[] = Array.isArray(report?.ranked_changes) ? report.ranked_changes : [];
    rows.forEach((row, rowIndex) => {
        const at = `ranked_changes[${rowIndex}]`;
        check(`${at}.summary`, row?.summary, 'row');
        check(`${at}.where`, row?.where, 'row');
        if (Array.isArray(row?.evidence)) {
            row.evidence.forEach((line, lineIndex) => check(`${at}.evidence[${lineIndex}]`, line, 'row'));
        }
    });
    check('markdown', report?.markdown, 'rendered');
    return violations;
}

// The rendered-markdown rule applied to text the Action prepends to that markdown — the narration
// (DN-158.D4) — so a narrative passes the same display guard as the engine's own body.
export function renderedControlUnit(text: string): { codeUnit: number; index: number } | null {
    return firstControlUnit(text, 'rendered');
}

function hexByte(value: number): string {
    return `0x${value.toString(16).padStart(2, '0')}`;
}

// Pure, and exported for tests for the same reason engineFailureMessage is: this diagnosis
// IS the contract, and it should be provable without spawning an engine or writing a file.
export function unreadableReportMessage(
    outputPath: string,
    exitCode: number,
    facts: UnreadableReportFacts,
    defect: ReportDefect,
): string {
    let broken: string;
    let measured: string;
    switch (defect.kind) {
        case 'not-utf8':
            broken =
                'it is not well-formed UTF-8, the encoding a JSON document is written in ' +
                '(RFC 8259 §8.1)';
            measured =
                defect.offset >= facts.reportBytes
                    ? 'and it ends inside a UTF-8 sequence'
                    : `and a strict UTF-8 decoder first refuses it at byte offset ${defect.offset}`;
            break;
        case 'not-json': {
            const shape =
                facts.rawControlBytes > 0
                    ? `${facts.rawControlBytes} raw control byte(s) — value < 0x20 outside tab/LF/CR, ` +
                      'which RFC 8259 §7 requires a JSON writer to escape — first at byte offset ' +
                      `${facts.firstControlByteOffset}`
                    : 'no raw control byte, so the malformation is something else';
            broken = 'it is not valid JSON';
            measured = `${shape}. Parser: ${withControlBytesNeutralised(defect.parserMessage)}`;
            break;
        }
        case 'control-in-display': {
            const first = defect.violations[0]!;
            broken =
                'text in it that this Action displays carries a control byte, which the engine ' +
                'guarantees it has already neutralised';
            measured =
                `${defect.violations.length} displayed field(s) holding a control byte ` +
                '(below 0x20 or 0x7f in a row, below 0x20 other than a line feed in the rendered ' +
                `markdown) — first \`${first.field}\`, value ${hexByte(first.codeUnit)} at ` +
                `character index ${first.index}`;
            break;
        }
    }
    return (
        `The Tamys ENGINE wrote an unreadable report. It exited ${exitCode} (a report-bearing ` +
        `code) and the file at ${outputPath} EXISTS, but ${broken}. This is a defect ` +
        'in the engine that produced the artefact — not a missing report, and not a problem ' +
        'with your log, your workflow inputs, or your permissions. ' +
        `Measured on the artefact: ${facts.reportBytes} bytes, ${measured}. ` +
        'The Action FAILS here rather than posting nothing, because a Tamys comment that ' +
        'silently does not appear is indistinguishable from "Tamys found nothing to report" — ' +
        'and a false all-clear is the one outcome a precision-first tool cannot ship. ' +
        'Please report it at https://github.com/CodeRoasted/sift-action/issues with this ' +
        'message and the engine version.'
    );
}

// Distinct from TamysEngineError, and the distinction is the whole point of the class:
// TamysEngineError means "the engine produced NO report", this one means "the engine
// produced a report and got it WRONG". Collapsing them would send the user hunting for a
// file that is sitting on disk. Carries the facts typed, so a caller can branch on the
// shape without re-parsing prose.
export class TamysReportUnreadableError extends Error {
    constructor(
        message: string,
        readonly exitCode: number,
        readonly facts: UnreadableReportFacts,
        readonly defect: ReportDefect,
    ) {
        super(message);
        this.name = 'TamysReportUnreadableError';
    }
}

// Where a strict decoder first refuses `bytes`: the length of the shortest prefix it rejects,
// less one. Found by bisection over the platform's own decoder in streaming mode, which accepts
// a prefix that merely ends inside a sequence, so the answer comes from the decoder that made
// the refusal and no second UTF-8 state machine lives here. Equals `bytes.length` when every
// prefix is accepted, which is a file that ends inside a sequence.
function firstIllFormedOffset(bytes: Uint8Array): number {
    const accepts = (end: number): boolean => {
        try {
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end), {
                stream: true,
            });
            return true;
        } catch {
            return false;
        }
    };
    if (accepts(bytes.length)) {
        return bytes.length;
    }
    let accepted = 0;
    let refused = bytes.length;
    while (refused - accepted > 1) {
        const middle = accepted + Math.floor((refused - accepted) / 2);
        if (accepts(middle)) {
            accepted = middle;
        } else {
            refused = middle;
        }
    }
    return refused - 1;
}

// The report, read as the BYTES the engine wrote and checked against the engine's own output
// contract; pure, so every refusal is provable without spawning an engine.
//
// The decoder is FATAL: a lenient one substitutes U+FFFD for an ill-formed sequence and says
// nothing, so a byte the engine should have replaced itself would reach the comment as if the
// engine had. `ignoreBOM: true` keeps a leading byte-order mark IN the text, where JSON.parse
// refuses it, instead of stripping it silently.
//
// This is a DIAGNOSTIC, not a gate: it does not repair the artefact and must not read as if it
// had. It names the engine as the source and says unparseable, never absent.
//
// FAIL rather than degrade, and the argument is the exit code's provenance. Degrading would
// mean trusting exit 0 as "nothing significant changed" — but that code comes from the very
// component that has just demonstrated it does not validate its own output. "The engine did
// not error out" and "your logs are clean" are not the same claim, and nothing here can tell
// them apart. Posting nothing would render our bug as the user's all-clear. `fail-on` does not
// soften this: it governs verdicts about the user's code, and exits 1/3/4 already fail
// irrespective of it — an unreadable report belongs in that set, and only reached this line
// because the exit code lied.
export function readReport(bytes: Uint8Array, outputPath: string, exitCode: number): TamysReport {
    const refuse = (defect: ReportDefect): never => {
        const facts = measureUnreadableReport(bytes);
        throw new TamysReportUnreadableError(
            unreadableReportMessage(outputPath, exitCode, facts, defect),
            exitCode,
            facts,
            defect,
        );
    };
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return refuse({ kind: 'not-utf8', offset: firstIllFormedOffset(bytes) });
    }
    let report: TamysReport;
    try {
        report = JSON.parse(text) as TamysReport;
    } catch (error) {
        return refuse({
            kind: 'not-json',
            parserMessage: error instanceof Error ? error.message : String(error),
        });
    }
    const violations = displayViolations(report);
    if (violations.length > 0) {
        return refuse({ kind: 'control-in-display', violations });
    }
    return report;
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
// environment from being a way to perturb it. The narration process, which reads only
// the validated report and never a log, gets this map plus exactly the three narration
// variables (narrate.ts, DN-158.D4); the diff process never does.
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

// A stack as the engine spells it: its rows outermost first, comma-separated, or `none` alone.
function transportToken(stack: readonly string[]): string {
    return stack.length === 0 ? 'none' : stack.join(',');
}

// Pure: the exact `tamys` argv for an invocation (exported so it is unit-testable without spawning).
export function tamysArgs(invocation: TamysInvocation): string[] {
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
        // workflow author could know better than we do. Without it tamys fails closed on DEPTH
        // (ADR-22.D5) and would compare these logs without claiming step structure; WITH it,
        // and before the coordinate existed, the bare `Run ` row fired on that prose and minted
        // phantom Step quanta — measured on 9.05% of 22030 real annotated logs, i.e. exactly the
        // form this line declares.
        '--channel',
        'annotated',
        // DN-89.D38 — each side's transport is DECLARED from how that side was acquired, never
        // deduced where the Action knows it. Deduction is content-sensitive, and content is
        // exactly what a diff varies, so a per-side deduction disagrees precisely when the two
        // sides differ most (measured on this Action's own invocation before declarations
        // existed: `baseline api-rfc3339-line-prefix (deduced), changed none (deduced)` on a
        // homologous pair, where 1 of 16 rows kept a real unit against 12 of 12 when both sides
        // agreed). The one-token `--transport`,
        // which set both sides from one fact, is gone: it is false as soon as the two sides were
        // acquired differently, and a declared asymmetry is accepted by the engine by design.
        // An empty stack is a declaration of `none`, never an absence.
        '--changed-transport',
        transportToken(invocation.changedTransport),
    ];
    if (invocation.baselineTransport !== undefined) {
        args.push('--baseline-transport', transportToken(invocation.baselineTransport));
    }
    if (invocation.changedLogProvenance) {
        args.push('--changed-log-job-id', String(invocation.changedLogProvenance.jobId));
        if (invocation.changedLogProvenance.attempt !== null) {
            args.push('--changed-log-attempt', String(invocation.changedLogProvenance.attempt));
        }
    }
    // ADR-22.D10 — a caller-declared verdict is a PAIR: the native token AND the vocabulary that
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
    // Sent whenever ANY declared verdict is present — a run token on either side, or a STATED
    // conclusion inside the declared graph (a job's, or a listed step's), which the engine
    // interprets through this SAME vocabulary (ADR-22.D13: same declarer, same run; a second
    // vocabulary field would be a second enumeration of one concept). Without it a run token
    // resolves against the stream's dialect, which a raw build log does not have — the token then
    // resolves to nothing and every rule that reads the verdict silently does not apply — and a
    // graph conclusion is REFUSED outright: the pinned engine exits non-zero on a stated
    // conclusion with no vocabulary (the half-pair refusal, at the CLI boundary). A graph whose
    // every conclusion is withheld asserts nothing and needs no vocabulary (DN-89.D26).
    // The baseline graph's job conclusions are read by nothing, but the pinned engine still reads a
    // baseline listed step's conclusion, so a stated one there pairs with the vocabulary too.
    const graphDeclaresConclusion =
        (invocation.changedJobGraph
            ? statesAJobConclusion(invocation.changedJobGraph.jobs) ||
              statesAListedStepConclusion(invocation.changedJobGraph.jobs)
            : false) ||
        (invocation.baselineJobGraph ? statesAListedStepConclusion(invocation.baselineJobGraph.jobs) : false);
    if (invocation.baselineOutcome || invocation.changedOutcome || graphDeclaresConclusion) {
        args.push('--outcome-vocabulary', 'github');
    }
    if (invocation.baselineOutcome) {
        args.push('--baseline-outcome', invocation.baselineOutcome);
    }
    if (invocation.changedOutcome) {
        args.push('--changed-outcome', invocation.changedOutcome);
    }
    // ADR-22.D13 — the declared `needs:` graph rides as a FILE: `needs` is genuinely nested, and
    // flat flags cannot carry a nesting without inventing a separator convention JSON already
    // spells. Present ⇒ the flag names the path runTamys() writes; absent ⇒ no flag, fold inert.
    if (invocation.changedJobGraph) {
        args.push('--changed-job-graph', invocation.changedJobGraph.path);
    }
    if (invocation.baselineJobGraph) {
        args.push('--baseline-job-graph', invocation.baselineJobGraph.path);
    }
    if (invocation.failOn !== 'none') {
        args.push('--fail-on', invocation.failOn);
    }
    return args;
}

export async function runTamys(invocation: TamysInvocation): Promise<TamysResult> {
    // The graph file the vector names — written here, where the other file IO already lives, so
    // tamysArgs stays pure (unit-testable without spawning). All four wire fields always travel:
    // the type guarantees presence, and JSON.stringify of the literal-ordered objects is
    // deterministic for a given graph.
    for (const graph of [invocation.changedJobGraph, invocation.baselineJobGraph]) {
        if (graph) {
            await fs.writeFile(graph.path, JSON.stringify(graph.jobs));
        }
    }
    // ignoreReturnCode: exit 2 is the advisory gate, not an Action error — so the code must be
    // INSPECTED here rather than ignored. The distinction the old code lost: `ignoreReturnCode`
    // means "do not throw on non-zero", not "non-zero carries no information".
    // env: a scrubbed, credential-free environment (see engineEnv).
    const exitCode = await exec.exec(invocation.tamysBin, tamysArgs(invocation), {
        ignoreReturnCode: true,
        env: engineEnv(),
    });
    // Checked BEFORE the read, which is the whole fix: on any failing code there is no report
    // file, and reading first turns the engine's actionable message into an ENOENT about ours.
    const failure = engineFailureMessage(exitCode);
    if (failure !== null) {
        throw new TamysEngineError(failure, exitCode);
    }
    // The exit-code check above was built for "engine failed, no file". It is DEFEATED by
    // "engine succeeded, bad file": engineFailureMessage() returns null on 0 and 2, so a
    // report-bearing code with a broken artefact would walk straight into the comment, or
    // surface as a bare SyntaxError attributed to sift-action. readReport is that second door's
    // guard: it reads the bytes as written and refuses a report that breaks the engine's
    // contract.
    const bytes = await fs.readFile(invocation.outputPath);
    return { report: readReport(bytes, invocation.outputPath, exitCode), exitCode };
}
