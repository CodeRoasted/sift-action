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
    const exitCode = await exec.exec(invocation.siftBin, args, { ignoreReturnCode: true });
    const raw = await fs.readFile(invocation.outputPath, 'utf8');
    const report = JSON.parse(raw) as SiftReport;
    return { report, exitCode };
}
