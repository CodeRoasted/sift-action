// Preflight: does the argument vector this Action BUILDS actually RUN on the engine it PINS?
//
// The class this exists for: the Action forwards a flag or a value its pinned engine does not
// understand. Three instances so far — `--outcome-vocabulary`, then `--transport none` twice.
// Every gate we owned went green on all three, because they answered "did it ship" (tsc, the
// unit suite, the dist staleness check) and never "will it run". The unit suite CANNOT catch
// this: it asserts the arg vector's CONTENT, and the vector was always exactly what we intended
// — the defect is that the engine on the other side rejects it.
//
// Reuse, not reimplementation. This imports the REAL `siftArgs` (the vector the Action sends),
// the REAL `resolveSift` (the pin, via SIFT_VERSION) and the REAL `engineEnv` (the allowlisted
// child environment). It restates none of them. A preflight that rebuilt the vector by hand
// would be a second copy of the predicate, and a second copy is precisely how a reproduction
// comes to disagree with the thing it reproduces.
//
// Same script in CI and on a developer's machine — `npm run preflight` in both — so the two can
// never drift into checking different things.
//
// Cost, stated: it DOWNLOADS the pinned engine (once per version bump; the resolver caches).
// That is the accepted price for catching this class before the push instead of after.
//
// COVERAGE BOUNDARY, declared rather than implied: this drives every flag `siftArgs` can emit
// EXCEPT the `--explain` / `--explain-model` pair, which would require provisioning the local
// model server. Those two are NOT covered here. Probing them with `--help` instead would be a
// reimplemented predicate — the very thing this file refuses to do — so the residue is recorded
// honestly rather than faked.
//
// SECOND BOUNDARY, and it is MEASURED rather than reasoned: this file drives ONE argument vector,
// the one with every optional field populated. That is deliberate (it takes every conditional
// push), and it means every CONDITION is exercised in exactly one cell. Measured 2026-08-10:
// mutating `siftArgs` so `--outcome-vocabulary` rides only when BOTH outcome tokens are present
// — which breaks the two single-token cells the Action really sends — leaves this preflight
// GREEN, because its invocation happens to populate both. The biconditional is therefore pinned
// where it is cheap and total, in `tests/sift.test.ts`. Neither instrument subsumes the other:
// preflight proves the vector RUNS on the pinned engine, the unit arm proves the vector is PAIRED
// in every cell. Read that as the standing rule for anything added here — a condition this file
// covers, it covers once.

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { engineEnv, siftArgs, type SiftInvocation } from '../src/sift.js';
import { resolveSift } from '../src/resolve-sift.js';
import { SIFT_VERSION } from '../src/sift-version.js';

const execFileAsync = promisify(execFile);

// Two logs that differ, so the engine does real work rather than short-circuiting on an
// identical pair. Content is irrelevant to what this proves — the subject is the ARGUMENT
// VECTOR, not the diff.
const BASELINE_LOG = ['Run actions/checkout@v5', 'building target', 'ok: 12 passed', 'done'].join('\n');
const CHANGED_LOG = ['Run actions/checkout@v5', 'building target', 'FAILED: 1 of 12', 'done'].join('\n');

async function main(): Promise<void> {
    const work = await mkdtemp(join(tmpdir(), 'sift-preflight-'));
    const baselineLog = join(work, 'baseline.log');
    const changedLog = join(work, 'changed.log');
    const outputPath = join(work, 'report.json');

    await writeFile(baselineLog, BASELINE_LOG);
    await writeFile(changedLog, CHANGED_LOG);

    process.stdout.write(`preflight: resolving the PINNED engine (SIFT_VERSION ${SIFT_VERSION})\n`);
    const siftBin = await resolveSift('', work);

    // Every optional field populated, so every conditional `args.push` in siftArgs is TAKEN.
    // A preflight that exercised the minimal vector would green on exactly the flags most
    // likely to be new.
    const invocation: SiftInvocation = {
        siftBin,
        baselineLog,
        changedLog,
        baselineLabel: 'preflight-baseline',
        changedLabel: 'preflight-changed',
        baselineOutcome: 'success',
        changedOutcome: 'failure',
        failOn: 'significant',
        outputPath,
    };

    const args = siftArgs(invocation);
    process.stdout.write(`preflight: ${args.length} args -> ${args.join(' ')}\n`);

    let stderr = '';
    let exitCode = 0;
    try {
        const r = await execFileAsync(siftBin, args, { env: engineEnv(), maxBuffer: 32 * 1024 * 1024 });
        stderr = r.stderr;
    } catch (e) {
        const err = e as { stderr?: string; code?: number; signal?: string };
        stderr = err.stderr ?? '';
        // `code` is absent when the child died on a SIGNAL — which is exactly how the `none`
        // instance presented (SIGABRT). Treating an undefined code as 0 would have greened it.
        exitCode = err.code ?? (err.signal ? 134 : 1);
    }

    if (stderr.trim()) {
        process.stdout.write(`--- engine stderr ---\n${stderr.trimEnd()}\n---------------------\n`);
    }

    // The engine's own rejection vocabulary. It fails CLOSED on an unknown token, which is the
    // behaviour that makes this check possible at all.
    const rejected = /^FATAL:/m.test(stderr) || /unknown|unrecognized/i.test(stderr);
    // sift exits 2 when --fail-on holds. That is a VERDICT, not a rejection, and the fixture
    // pair is built to trigger it — so 0 and 2 are both healthy here.
    const ranClean = exitCode === 0 || exitCode === 2;

    let wroteReport = true;
    try {
        await access(outputPath);
    } catch {
        wroteReport = false;
    }

    if (rejected || !ranClean || !wroteReport) {
        process.stderr.write(
            `\nPREFLIGHT FAILED — the pinned engine did not accept the vector this Action builds.\n` +
                `  engine     : ${siftBin} (SIFT_VERSION ${SIFT_VERSION})\n` +
                `  exit       : ${exitCode}${exitCode === 134 ? ' (ABORTED — died on a signal)' : ''}\n` +
                `  report.json: ${wroteReport ? 'written' : 'ABSENT'}\n` +
                `  rejected   : ${rejected}\n` +
                `\nA forwarded flag or value outruns the pin. Either the engine must ship the\n` +
                `capability first and SIFT_VERSION move with it, or the forwarding comes out.\n`,
        );
        process.exitCode = 1;
        return;
    }

    process.stdout.write(`preflight OK — pinned engine accepted all ${args.length} args (exit ${exitCode}).\n`);
}

await main();
