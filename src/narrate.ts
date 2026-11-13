// The AI narration (DN-158.D4, RUL-295): optional, on the user's own key, in a process that reads
// no log. The key is the opt-in — an empty `explain-api-key` is the structural report alone. With
// one, the Action runs a SECOND engine process, `tamys explain --report <report.json> --format md
// -o <file>`, over the report the diff process already wrote and `readReport` already validated.
// That process never reads a log byte, and the diff process, which parses untrusted bytes on any
// pull request, never sees the key (ADR-14.D5's rule, kept as it stands).
//
// The narrative is advisory and fail-soft: any failure is one warning, and the comment, the outputs
// and the gate are what they would be without a key. The engine's request timeout and the
// transport's cancellation are the bounds; this file adds no third one (ADR-13.D2).

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { promises as fs } from 'fs';

import { engineEnv, renderedControlUnit } from './tamys.js';
import type { TamysReport } from './types.js';

// The one line a keyless run writes to the step log (DN-158.D4).
export const NO_KEY_LINE = 'explain: no explain-api-key; the structural report alone';

// The one line a keyed run on a report with no significant change writes (DN-158.D11): the Action
// reads the field the narration process would read, from the same validated bytes, and spawns
// nothing — so a clean run puts the key in no process at all, and an empty narration file after a
// spawn stays a real failure.
export const NOTHING_TO_NARRATE_LINE = 'explain: no significant changes; nothing to narrate';

export interface NarrationInputs {
    apiKey: string;
    endpoint: string;
    model: string;
}

// The `explain-*` inputs. The key is masked the moment it is read, so every later log line has it
// masked even when a workflow passes it from a variable rather than a secret. The defaults live in
// `action.yml`, where a reader sees them, and nowhere in this bundle: an invocation that bypasses
// the manifest and names no endpoint gets the engine's own note naming the missing value.
export function readNarrationInputs(): NarrationInputs {
    const apiKey = core.getInput('explain-api-key');
    if (apiKey !== '') {
        core.setSecret(apiKey);
    }
    return { apiKey, endpoint: core.getInput('explain-endpoint'), model: core.getInput('explain-model') };
}

// The narration argv. Neither the key nor the endpoint is on it: @actions/exec echoes the command
// line into the public step log, and an endpoint URL can carry a credential in its query.
export function narrationArgs(reportPath: string, outputPath: string): string[] {
    return ['explain', '--report', reportPath, '--format', 'md', '-o', outputPath];
}

// The narration environment: the diff process's scrubbed one plus exactly the three variables the
// engine reads, BUILT from the inputs and never forwarded from this process's environment.
export function narrationEnv(inputs: NarrationInputs): Record<string, string> {
    return {
        ...engineEnv(),
        CODEROAST_LLM_ENDPOINT: inputs.endpoint,
        CODEROAST_LLM_MODEL: inputs.model,
        CODEROAST_LLM_TOKEN: inputs.apiKey,
    };
}

// The seam the narration spawn goes through: @actions/exec's `exec`, whose `env` REPLACES the child's
// environment rather than merging into it.
export type ExecFn = (
    bin: string,
    args: string[],
    options: { ignoreReturnCode: true; env: Record<string, string> },
) => Promise<number>;

export interface NarrationParams {
    // `post` runs no engine and has nothing to narrate, so it never reaches here.
    mode: 'comment' | 'render';
    inputs: NarrationInputs;
    tamysBin: string;
    // The diff process's report.json, already validated by `readReport`.
    reportPath: string;
    outputPath: string;
    report: TamysReport;
}

export interface NarratedReport {
    // The report whose markdown starts with the narrative when one was drawn, else the report given.
    report: TamysReport;
    // The endpoint's host when a narrative is attached — what the comment footer names.
    host?: string;
}

// The narration file's text, or the reason it cannot be shown. It passes the same display guard as
// the engine's rendered markdown: well-formed UTF-8, and no control byte but the line feed.
async function readNarrative(outputPath: string): Promise<{ text: string } | { refused: string }> {
    let bytes: Uint8Array;
    try {
        bytes = await fs.readFile(outputPath);
    } catch {
        return { refused: 'the narration process wrote no file' };
    }
    if (bytes.length === 0) {
        return { refused: 'the narration file is empty' };
    }
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return { refused: 'the narration file is not well-formed UTF-8' };
    }
    const control = renderedControlUnit(text);
    if (control !== null) {
        return {
            refused:
                `the narration carries the control byte 0x${control.codeUnit.toString(16).padStart(2, '0')} ` +
                `at character index ${control.index}`,
        };
    }
    return { text };
}

// The endpoint's host, or null when the text is not a URL a WHATWG parser reads.
function hostOf(endpoint: string): string | null {
    try {
        return new URL(endpoint).hostname;
    } catch {
        return null;
    }
}

// The report with its narrative, or the report as given with one log line saying why there is none.
// The narrative is a pure PREFIX of the engine's markdown — everything after it is byte-identical to
// a report rendered without narration — so it is prepended here, before the frame measures the
// comment against its budget, and the comment, the job summary and the report artifact's `report.md`
// carry it where the engine's own markdown would.
export async function narrateReport(params: NarrationParams, execFn: ExecFn = exec.exec): Promise<NarratedReport> {
    const unchanged: NarratedReport = { report: params.report };
    if (params.inputs.apiKey === '') {
        core.info(NO_KEY_LINE);
        return unchanged;
    }
    if (params.mode === 'render') {
        core.warning(
            'explain: render mode never narrates — it is the untrusted-parse job of the fork topology, ' +
                'so the explain-api-key is not used here; the structural report alone.',
        );
        return unchanged;
    }
    if (params.report.summary.significant_changes === 0) {
        core.info(NOTHING_TO_NARRATE_LINE);
        return unchanged;
    }
    const exitCode = await execFn(params.tamysBin, narrationArgs(params.reportPath, params.outputPath), {
        ignoreReturnCode: true,
        env: narrationEnv(params.inputs),
    });
    const tail = 'the report, the comment and the gate are as they would be without a key.';
    if (exitCode !== 0) {
        core.warning(`explain: the narration process exited ${exitCode}, so no narrative is attached; ${tail}`);
        return unchanged;
    }
    const narrative = await readNarrative(params.outputPath);
    if ('refused' in narrative) {
        core.warning(
            `explain: ${narrative.refused}, so no narrative is attached (the engine's note above says why ` +
                `when it drew none); ${tail}`,
        );
        return unchanged;
    }
    const host = hostOf(params.inputs.endpoint);
    if (host === null) {
        core.warning(`explain: the explain-endpoint is not a URL whose host can be named, so no narrative is attached; ${tail}`);
        return unchanged;
    }
    return {
        report: { ...params.report, markdown: narrative.text + (params.report.markdown ?? '') },
        host,
    };
}
