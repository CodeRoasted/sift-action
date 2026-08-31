#!/usr/bin/env python3
"""Measure the ENGINE's wall time on a size ladder, with the runner's coordinate attached.

WHY THIS EXISTS
---------------
A wall-time number without its hardware, its input size and its change counts is not a
measurement — it is a rumour with a unit. This tool emits all four, because the claim it
feeds is a public one and a public claim gets audited by people who did not run it.

THE DEGENERATE-RUNG GUARD — and what it is NOT
----------------------------------------------
A rung yielding 0 significant changes is refused as a throughput sample: nothing was ranked
or rendered, so the run did not exercise the path the product's claim is about. That is a
VALIDITY rule, not a speed rule, and the distinction is load-bearing because the obvious
speed rationale turns out to be false on this corpus.

MEASURED 2026-08-30, desk (Ryzen 7 7800X3D), rung 16x, best-of-7, interleaved, engine
1.10.2, the three showcase pairs:

    green-a vs red      176 significant   1373 ms
    green-a vs green-b   16 significant   1471 ms
    green-a vs itself     0 significant   1367 ms      <-- 0 sig, and NOT faster

Spread 1.08x. Wall time here is dominated by PARSING and tracks input BYTES; the change
counts barely move it. So a 0-significant rung is not detectably "fast", and this guard must
not be described as catching an inflated number — it catches a rung that did not measure the
product. Anyone re-deriving a >1.1x significance effect on some other corpus should treat it
as a property of THAT corpus's content and say which corpus, because it is not a property of
the engine as measured here.

`--require-significant` (default on) makes the refusal fatal so a degenerate ladder cannot be
published by a reader who skimmed the table. NOTE its limit: passing this guard does NOT make
two ladders comparable — comparability is governed by the input CONTENT (which corpus, which
pair), which is why the pair's filenames and byte counts are printed with every result.

BEST-OF-N, NOT MEAN
-------------------
The minimum is the estimator here on purpose: a shared CI runner's noise is one-sided
(other tenants, page cache misses, throttling can only ADD time), so the mean of a noisy
sample estimates the noise, while the minimum estimates the machine. We report the mean and
the spread too, so a reader can see how noisy the box was rather than take our word for it.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MB = 1024.0 * 1024.0


def runner_coordinate() -> dict:
    """The hardware the numbers below belong to. A wall time without this is unfalsifiable."""
    coord: dict[str, object] = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "logical_cpus": os.cpu_count(),
    }
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text(errors="replace")
        models = re.findall(r"^model name\s*:\s*(.+)$", cpuinfo, re.M)
        coord["cpu_model"] = models[0].strip() if models else "unknown"
        coord["cpu_model_count"] = len(models)
    except OSError:
        coord["cpu_model"] = "unknown"
    try:
        meminfo = Path("/proc/meminfo").read_text(errors="replace")
        for key in ("MemTotal", "MemAvailable"):
            m = re.search(rf"^{key}:\s+(\d+) kB$", meminfo, re.M)
            if m:
                coord[key] = f"{int(m.group(1)) / 1024 / 1024:.2f} GiB"
    except OSError:
        pass
    # Present only on GitHub-hosted runners; absent at a desk, and the absence is the answer.
    #
    # `RUNNER_NAME` IS DELIBERATELY NOT COLLECTED, and this comment is the whole reason.
    # This payload is written to `wall-time.json` and uploaded as an Actions artifact of a
    # PUBLIC repository. Every other name here is a hardware or image COORDINATE, which is
    # what makes a wall time falsifiable; `RUNNER_NAME` is an IDENTIFIER and answers no
    # question the ladder asks — on a GitHub-hosted runner it is a scheduling label
    # ("GitHub Actions 5"), and on a self-hosted runner it is the box's registered name.
    # So it was worth nothing while `runs-on` said `ubuntu-latest`, and worth an internal
    # machine name published to the world the day someone changed that line. Removing the
    # field removes the coupling; a comment at `runs-on` would only have asked the next
    # person to notice it.
    for var in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH"):
        if os.environ.get(var):
            coord[var] = os.environ[var]
    return coord


def replicate(src: Path, times: int, dest: Path) -> tuple[int, int]:
    """Concatenate `src` `times` times into `dest`. Returns (bytes, lines).

    Byte-exact concatenation, deliberately: re-generating a larger log would change the
    CONTENT distribution and therefore the change counts, which is a different experiment.
    Replication scales volume while holding the structural signal fixed, so the delta and
    the significance survive — that is the property the ladder needs.
    """
    payload = src.read_bytes()
    with dest.open("wb") as out:
        for _ in range(times):
            out.write(payload)
    data_lines = payload.count(b"\n") * times
    return len(payload) * times, data_lines


def time_once(engine: Path, base: Path, changed: Path, report: Path) -> tuple[float, dict]:
    """One timed engine invocation. Wall time brackets the process, nothing else."""
    cmd = [
        str(engine), str(base), str(changed),
        "--format", "json", "-o", str(report),
    ]
    start = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.monotonic() - start
    if proc.returncode != 0:
        raise SystemExit(
            f"engine exited {proc.returncode} on {base.name} vs {changed.name}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
    with report.open() as fh:
        doc = json.load(fh)
    return elapsed, doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", required=True, type=Path, help="path to the sift binary under test")
    ap.add_argument("--logs", required=True, type=Path, help="directory holding the showcase logs")
    ap.add_argument("--baseline-log", default="logcraft__ci-build__green-a.log")
    ap.add_argument("--changed-log", default="logcraft__ci-build__red.log")
    ap.add_argument("--rungs", default="1,4,16,64", help="replication factors (comma-separated)")
    ap.add_argument("--reps", type=int, default=5, help="timed repetitions per rung; the MINIMUM is reported")
    ap.add_argument("--json-out", type=Path, help="write the full result set here")
    ap.add_argument(
        "--require-significant", action=argparse.BooleanOptionalAction, default=True,
        help="fail when any rung yields 0 significant changes (a degenerate measurement)",
    )
    args = ap.parse_args()

    engine = args.engine.resolve()
    if not os.access(engine, os.X_OK):
        raise SystemExit(f"engine is not executable: {engine}")

    base_src = (args.logs / args.baseline_log).resolve()
    chg_src = (args.logs / args.changed_log).resolve()
    for p in (base_src, chg_src):
        if not p.is_file():
            raise SystemExit(f"missing input log: {p}")

    version = subprocess.run([str(engine), "--version"], capture_output=True, text=True).stdout.strip()
    coord = runner_coordinate()

    print("=" * 78)
    print("SIFT WALL TIME — size ladder")
    print("=" * 78)
    print(f"engine        : {version}")
    print(f"engine sha256 : {subprocess.run(['sha256sum', str(engine)], capture_output=True, text=True).stdout.split()[0]}")
    print(f"baseline log  : {base_src.name}")
    print(f"changed log   : {chg_src.name}")
    print(f"reps per rung : {args.reps} (best-of, minimum reported)")
    print("-" * 78)
    print("RUNNER COORDINATE")
    for k, v in coord.items():
        print(f"  {k:18s}: {v}")
    print("=" * 78)

    rungs = [int(x) for x in args.rungs.split(",") if x.strip()]
    results = []
    tmp = Path(tempfile.mkdtemp(prefix="sift-ladder-"))
    try:
        for n in rungs:
            base = tmp / f"base_{n}.log"
            chg = tmp / f"chg_{n}.log"
            report = tmp / f"report_{n}.json"
            b_bytes, b_lines = replicate(base_src, n, base)
            c_bytes, c_lines = replicate(chg_src, n, chg)

            times = []
            doc = {}
            for _ in range(args.reps):
                elapsed, doc = time_once(engine, base, chg, report)
                times.append(elapsed)

            summary = doc.get("summary", {})
            inputs = doc.get("inputs", {})
            row = {
                "rung": n,
                "baseline_bytes": b_bytes,
                "changed_bytes": c_bytes,
                "baseline_lines_file": b_lines,
                "changed_lines_file": c_lines,
                "baseline_lines_observed": inputs.get("baseline", {}).get("lines_observed"),
                "changed_lines_observed": inputs.get("changed", {}).get("lines_observed"),
                "total_changes": summary.get("total_changes"),
                "significant_changes": summary.get("significant_changes"),
                "ranked_changes_len": len(doc.get("ranked_changes", [])),
                "best_s": min(times),
                "mean_s": sum(times) / len(times),
                "worst_s": max(times),
                "all_s": times,
            }
            # Throughput is defined over the bytes the engine actually read: BOTH sides.
            row["total_bytes"] = b_bytes + c_bytes
            row["mb_per_s_total"] = (row["total_bytes"] / MB) / row["best_s"]
            row["mb_per_s_baseline_side"] = (b_bytes / MB) / row["best_s"]
            row["valid"] = bool(row["significant_changes"])
            results.append(row)

            flag = "" if row["valid"] else "   <-- INVALID: 0 significant changes, time NOT quotable"
            print(
                f"rung {n:3d}x  base {b_bytes/MB:7.2f} MB / {b_lines:7d} lines"
                f"  chg {c_bytes/MB:7.2f} MB / {c_lines:7d} lines"
                f"  changes {str(row['total_changes']):>7s}"
                f"  sig {str(row['significant_changes']):>5s}"
                f"  ranked {row['ranked_changes_len']:>5d}"
                f"  best {row['best_s']*1000:9.1f} ms{flag}"
            )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("PASTEABLE TABLE (both sides' bytes; throughput is over the TOTAL bytes read)")
    print()
    print("| rung | MB base | MB changed | lines base | lines changed | total changes | significant | ranked | best (ms) | mean (ms) | MB/s total |")
    print("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in results:
        best = f"{r['best_s']*1000:.1f}" if r["valid"] else "INVALID"
        print(
            f"| {r['rung']}x | {r['baseline_bytes']/MB:.2f} | {r['changed_bytes']/MB:.2f} "
            f"| {r['baseline_lines_file']} | {r['changed_lines_file']} "
            f"| {r['total_changes']} | {r['significant_changes']} | {r['ranked_changes_len']} "
            f"| {best} | {r['mean_s']*1000:.1f} | {r['mb_per_s_total']:.2f} |"
        )

    payload = {"engine": version, "coordinate": coord, "rungs": results}
    if args.json_out:
        args.json_out.write_text(json.dumps(payload, indent=2))
        print(f"\nfull result set: {args.json_out}")

    degenerate = [r["rung"] for r in results if not r["valid"]]
    if degenerate:
        print(
            f"\n::error::rungs {degenerate} produced 0 significant changes — the ranking and "
            f"rendering path was never entered, so their wall times are NOT comparable to a "
            f"real pair's and MUST NOT be quoted."
        )
        if args.require_significant:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
