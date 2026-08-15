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
// SECOND BOUNDARY, and its history is the reason it is written down. Until 2026-08-10 this file
// drove ONE argument vector, the one with every optional field populated — which took every
// conditional push but exercised every CONDITION in exactly one cell. Measured: mutating
// `siftArgs` so `--outcome-vocabulary` rides only when BOTH outcome tokens are present — which
// breaks the two single-token cells the Action really sends — left this preflight GREEN.
// The verdict coordinate is now driven in all four cells below, so that specific hole is closed.
//
// THE BOUNDARY THAT REMAINS, stated so the next reader does not re-derive the wrong lesson: the
// widenings cover TWO coordinates — the verdict pair (four cells) and the `--changed-job-graph`
// declaration (three cells, section A′ — the FOURTH instance of this class, named by DN-37.D18
// before it could become the fifth discovery). Every other conditional in `siftArgs` is still
// exercised in a single combination, and a mutation aimed at one of those would still green here.
// This file's sentence is *"the pinned engine ACCEPTS what the Action emits"*;
// `tests/sift.test.ts`'s is *"the Action emits a PAIRED vector in every cell"*. **Neither subsumes
// the other, and a property provable without the engine belongs in the unit arm, where it is total
// and free.**

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { DeclaredJobWire } from '../src/jobgraph.js';
import { engineEnv, siftArgs, type SiftInvocation } from '../src/sift.js';
import { resolveSift } from '../src/resolve-sift.js';
import { SIFT_VERSION } from '../src/sift-version.js';

const execFileAsync = promisify(execFile);

// Two logs that differ, so the engine does real work rather than short-circuiting on an
// identical pair. Content is irrelevant to what this proves — the subject is the ARGUMENT
// VECTOR, not the diff.
const BASELINE_LOG = ['Run actions/checkout@v5', 'building target', 'ok: 12 passed', 'done'].join('\n');
const CHANGED_LOG = ['Run actions/checkout@v5', 'building target', 'FAILED: 1 of 12', 'done'].join('\n');

// The four verdict cells the Action can emit. `joblog.ts` knows a side's conclusion only when it
// resolved that run, so a SINGLE-token invocation is not a corner case — it is what ships whenever
// one side's verdict is unknown, and it is the shape a bump makes fatal.
const VERDICT_CELLS: ReadonlyArray<{ name: string; baselineOutcome: string; changedOutcome: string }> = [
    { name: 'no verdict declared', baselineOutcome: '', changedOutcome: '' },
    { name: 'baseline verdict only', baselineOutcome: 'success', changedOutcome: '' },
    { name: 'changed verdict only', baselineOutcome: '', changedOutcome: 'failure' },
    { name: 'both verdicts', baselineOutcome: 'success', changedOutcome: 'failure' },
];

// ── The link between SIFT_VERSION and the ENGINE CAPABILITY it pins ──────────────────────────
//
// This is the one thing no other instrument here could hold. `tests/sift.test.ts` proves the
// Action never emits a half-pair; nothing proved what the PINNED ENGINE does when it receives
// one, and that behaviour changes underneath us at a bump.
//
// MEASURED on engine v1.9.2 (2026-08-10): a verdict token with NO `--outcome-vocabulary` was
// accepted, exit 0, output byte-identical to the paired invocation, and NOT ONE WORD of
// diagnostic. That is the silent degradation itself — the same shape cost `sift-crawl` 60
// critical/high `regression` rows across 63 identical-commit pairs whose ground truth was
// silence.
//
// MEASURED on engine v1.9.3 (2026-08-15, this bump): the half-pair is REFUSED — exit 1, a
// diagnostic naming the missing coordinate and enumerating the composed vocabularies ("error:
// --baseline-outcome / --changed-outcome need --outcome-vocabulary. … the composed vocabularies
// are: \"github\", \"gitlab\", \"jenkins\", \"test_frameworks\""). A usage error, not a SIGABRT:
// the CLI refuses before constructing the config (DN-37.D18 — fail-closed is a property of the
// OUTCOME, and a CLI has an exit code and must use it). This probe went red on exactly this bump
// and the declaration moved with the pin, which is this constant doing its one job.
//
// So this constant is the pin's other half, and it fails CLOSED: `bump.sh` moves SIFT_VERSION,
// this stops matching, preflight goes red, and whoever bumps must look at the difference rather
// than remember it. Do not "fix" a red here by editing this value alone — read the engine's new
// behaviour first and confirm it is the one intended.
const PINNED_ENGINE_HALF_PAIR: 'tolerated' | 'fatal' = 'fatal';

interface RunResult {
    exitCode: number;
    stderr: string;
    wroteReport: boolean;
    rejected: boolean;
    ranClean: boolean;
}

async function runVector(siftBin: string, args: readonly string[], outputPath: string): Promise<RunResult> {
    let stderr = '';
    let exitCode = 0;
    try {
        const r = await execFileAsync(siftBin, [...args], { env: engineEnv(), maxBuffer: 32 * 1024 * 1024 });
        stderr = r.stderr;
    } catch (e) {
        const err = e as { stderr?: string; code?: number; signal?: string };
        stderr = err.stderr ?? '';
        // `code` is absent when the child died on a SIGNAL — which is exactly how the `none`
        // instance presented (SIGABRT). Treating an undefined code as 0 would have greened it.
        exitCode = err.code ?? (err.signal ? 134 : 1);
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

    return { exitCode, stderr, wroteReport, rejected, ranClean };
}

async function main(): Promise<void> {
    const work = await mkdtemp(join(tmpdir(), 'sift-preflight-'));
    const baselineLog = join(work, 'baseline.log');
    const changedLog = join(work, 'changed.log');

    await writeFile(baselineLog, BASELINE_LOG);
    await writeFile(changedLog, CHANGED_LOG);

    process.stdout.write(`preflight: resolving the PINNED engine (SIFT_VERSION ${SIFT_VERSION})\n`);
    const siftBin = await resolveSift('', work);

    const failures: string[] = [];
    let bothCellArgs: readonly string[] = [];
    let bothCellOutput = '';

    // ── A) every verdict cell the Action can emit, each against the PINNED engine ────────────
    // Every other optional field stays populated, so every conditional `args.push` in siftArgs is
    // still TAKEN in each cell. Only the verdict coordinate varies.
    for (const [index, cell] of VERDICT_CELLS.entries()) {
        const outputPath = join(work, `report-${index}.json`);
        const invocation: SiftInvocation = {
            siftBin,
            baselineLog,
            changedLog,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: cell.baselineOutcome,
            changedOutcome: cell.changedOutcome,
            failOn: 'significant',
            outputPath,
        };
        const args = siftArgs(invocation);
        if (cell.baselineOutcome && cell.changedOutcome) {
            bothCellArgs = args;
            bothCellOutput = outputPath;
        }

        const r = await runVector(siftBin, args, outputPath);
        const ok = !r.rejected && r.ranClean && r.wroteReport;
        process.stdout.write(
            `preflight cell ${index + 1}/${VERDICT_CELLS.length} [${cell.name}]: ` +
                `${args.length} args, exit ${r.exitCode} — ${ok ? 'accepted' : 'REJECTED'}\n`,
        );
        if (!ok) {
            if (r.stderr.trim()) {
                process.stdout.write(`--- engine stderr ---\n${r.stderr.trimEnd()}\n---------------------\n`);
            }
            failures.push(
                `  cell [${cell.name}]: exit ${r.exitCode}` +
                    `${r.exitCode === 134 ? ' (ABORTED — died on a signal)' : ''}` +
                    `, report.json ${r.wroteReport ? 'written' : 'ABSENT'}, rejected=${r.rejected}\n` +
                    `      vector: ${args.join(' ')}`,
            );
        }
    }

    // ── A′) the `--changed-job-graph` coordinate, in its three ship shapes ───────────────────
    // The graph is the wire jobgraph.ts produces (DN-37.D18), and each shape below is one the
    // Action REALLY emits — not a synthetic corner. The verdict cells above stay graph-FREE
    // because acquisition-absent is itself a ship shape (a denied `contents: read`, a missing
    // GITHUB_WORKFLOW_REF), so both halves of the conditional stay driven on the real engine.
    const GRAPH_CELLS: ReadonlyArray<{
        name: string;
        jobs: DeclaredJobWire[];
        baselineOutcome: string;
        changedOutcome: string;
    }> = [
        {
            // The full PR shape: run tokens AND a graph with an edge, a resolved conclusion, a
            // fan-out anchor, and a key-less quoted rendering — every wire feature at once.
            name: 'graph + both verdicts',
            jobs: [
                { key: 'build', display: 'build', needs: [], conclusion: 'success' },
                { key: 'gate', display: 'gate', needs: ['build'], conclusion: 'failure' },
                { key: '', display: 'Bazel / test windows', needs: [], conclusion: 'failure' },
            ],
            baselineOutcome: 'success',
            changedOutcome: 'failure',
        },
        {
            // `log:` sourcing with no outcome wiring: the graph's conclusions are the ONLY
            // declared verdicts, so the vocabulary rides on them alone — the exact pairing branch
            // DN-37.D18 added, driven with no run token to mask it.
            name: 'graph conclusions only, no run tokens',
            jobs: [{ key: 'build', display: 'build', needs: ['deps'], conclusion: 'failure' },
                   { key: 'deps', display: 'deps', needs: [], conclusion: '' }],
            baselineOutcome: '',
            changedOutcome: '',
        },
        {
            // The edge-gated acquisition (no edges ⇒ the jobs listing is skipped ⇒ displays and
            // conclusions all empty) — the shape this repo's own dogfood emits. No verdict
            // anywhere, so NO vocabulary rides: the engine must accept a conclusion-less graph
            // bare (all-empty is fine — the refusal trigger is incomplete ∧ unresolved).
            name: 'inert graph, no verdicts, no vocabulary',
            jobs: [
                { key: 'build', display: '', needs: [], conclusion: '' },
                { key: 'actionlint', display: '', needs: [], conclusion: '' },
            ],
            baselineOutcome: '',
            changedOutcome: '',
        },
    ];
    for (const [index, cell] of GRAPH_CELLS.entries()) {
        const outputPath = join(work, `report-graph-${index}.json`);
        const graphPath = join(work, `graph-${index}.json`);
        // The file body is written the way runSift writes it — JSON.stringify of the typed wire —
        // so this drives the bytes the engine will really receive, not a hand-authored guess.
        await writeFile(graphPath, JSON.stringify(cell.jobs));
        const invocation: SiftInvocation = {
            siftBin,
            baselineLog,
            changedLog,
            baselineLabel: 'preflight-baseline',
            changedLabel: 'preflight-changed',
            baselineOutcome: cell.baselineOutcome,
            changedOutcome: cell.changedOutcome,
            failOn: 'significant',
            outputPath,
            changedJobGraph: { path: graphPath, jobs: cell.jobs },
        };
        const args = siftArgs(invocation);
        const r = await runVector(siftBin, args, outputPath);
        const ok = !r.rejected && r.ranClean && r.wroteReport;
        process.stdout.write(
            `preflight graph cell ${index + 1}/${GRAPH_CELLS.length} [${cell.name}]: ` +
                `${args.length} args, exit ${r.exitCode} — ${ok ? 'accepted' : 'REJECTED'}\n`,
        );
        if (!ok) {
            if (r.stderr.trim()) {
                process.stdout.write(`--- engine stderr ---\n${r.stderr.trimEnd()}\n---------------------\n`);
            }
            failures.push(
                `  graph cell [${cell.name}]: exit ${r.exitCode}` +
                    `${r.exitCode === 134 ? ' (ABORTED — died on a signal)' : ''}` +
                    `, report.json ${r.wroteReport ? 'written' : 'ABSENT'}, rejected=${r.rejected}\n` +
                    `      vector: ${args.join(' ')}`,
            );
        }
    }

    // ── B) the CAPABILITY PROBE — what does the PINNED engine do with a HALF-PAIR? ───────────
    // This is deliberately NOT a vector the Action can build (`tests/sift.test.ts` proves it never
    // emits one). It is derived from the real both-token vector by REMOVING the vocabulary, so it
    // stays a fact about the engine rather than a hand-written guess at one. The probe asserts
    // nothing about the Action; it asserts that the pin's behaviour is still the one declared
    // above, and it is what makes a bump self-announcing instead of remembered.
    const probeOutput = join(work, 'report-halfpair.json');
    const vocabAt = bothCellArgs.indexOf('--outcome-vocabulary');
    if (vocabAt < 0) {
        failures.push(
            '  capability probe: could not derive a half-pair — the both-token vector carried no\n' +
                '      --outcome-vocabulary at all, which the unit arm should already have caught.',
        );
    } else {
        const probeArgs = [...bothCellArgs.slice(0, vocabAt), ...bothCellArgs.slice(vocabAt + 2)].map((a) =>
            a === bothCellOutput ? probeOutput : a,
        );
        const r = await runVector(siftBin, probeArgs, probeOutput);
        const observed: 'tolerated' | 'fatal' =
            r.rejected || r.exitCode === 134 || !r.ranClean ? 'fatal' : 'tolerated';
        process.stdout.write(
            `preflight probe [half-pair on the pinned engine]: exit ${r.exitCode} — observed '${observed}', ` +
                `declared '${PINNED_ENGINE_HALF_PAIR}'\n`,
        );
        if (observed !== PINNED_ENGINE_HALF_PAIR) {
            failures.push(
                `  capability probe: the pinned engine now treats a HALF-PAIR as '${observed}',\n` +
                    `      but PINNED_ENGINE_HALF_PAIR in this file still declares '${PINNED_ENGINE_HALF_PAIR}'.\n` +
                    `      THIS IS THE BUMP CHANGING THE CONTRACT, not a flake. A 'fatal' engine turns any\n` +
                    `      regression that drops --outcome-vocabulary from a silent degradation into a usage\n` +
                    `      error on EVERY consumer run. Confirm the Action still pairs (npm test), then move\n` +
                    `      the declaration in the same change as the pin.`,
            );
        }
    }

    if (failures.length > 0) {
        process.stderr.write(
            `\nPREFLIGHT FAILED — engine ${siftBin} (SIFT_VERSION ${SIFT_VERSION})\n` +
                `${failures.join('\n')}\n` +
                `\nA forwarded flag or value outruns the pin, or the pin's behaviour moved under us.\n` +
                `Either the engine must ship the capability first and SIFT_VERSION move with it, or the\n` +
                `forwarding comes out.\n`,
        );
        process.exitCode = 1;
        return;
    }

    process.stdout.write(
        `preflight OK — the pinned engine accepted all ${VERDICT_CELLS.length} verdict cells and ` +
            `all ${GRAPH_CELLS.length} graph cells, and its half-pair behaviour is still ` +
            `'${PINNED_ENGINE_HALF_PAIR}'.\n`,
    );
}

await main();
