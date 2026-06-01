// Engine invocation. The Action shells out to the pinned `sift` binary (provided
// by Argos's packaging — a downloaded release asset, or in-image for Docker) with
// `--format both -o report.json`: one file carrying the structured report AND the
// pre-rendered markdown body (the `markdown` sibling the <details> embeds). The
// `--fail-on` exit code is the authoritative advisory gate (sift exits 2 when the
// condition holds) — captured here, never recomputed.

import * as exec from '@actions/exec';
import { promises as fs } from 'fs';
import type { SiftReport } from './types';

export type FailOn = 'none' | 'significant' | 'regression';

export interface SiftInvocation {
    siftBin: string;
    baselineLog: string;
    changedLog: string;
    baselineLabel: string;
    changedLabel: string;
    failOn: FailOn;
    outputPath: string;
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

export async function runSift(invocation: SiftInvocation): Promise<SiftResult> {
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
    ];
    if (invocation.failOn !== 'none') {
        args.push('--fail-on', invocation.failOn);
    }
    // ignoreReturnCode: a non-zero exit is the advisory gate, not an Action error.
    // env: a scrubbed, credential-free environment (see engineEnv).
    const exitCode = await exec.exec(invocation.siftBin, args, {
        ignoreReturnCode: true,
        env: engineEnv(),
    });
    const raw = await fs.readFile(invocation.outputPath, 'utf8');
    const report = JSON.parse(raw) as SiftReport;
    return { report, exitCode };
}
