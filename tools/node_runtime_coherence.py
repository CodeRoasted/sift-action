#!/usr/bin/env python3
"""Node runtime coherence for `sift-action` — the runtime we PROVE on is the runtime we SHIP on.

Discharges the `sift-action` node cell of `OPS-7.S111` / `OPS-7.S112`, converting it
from JUDG to MECH.

The defect class this gate exists for
-------------------------------------
`sift-action` is the only artifact a stranger runs unsupervised, and it is a
BUNDLE: GitHub launches `dist/index.js` on the runtime named in `action.yml`
(`runs.using`), while CI proves the bundle on whatever `setup-node` installs and
esbuild lowers syntax to whatever `target` says. Those are independent
declarations of one fact.

WHAT A SKEW ACTUALLY COSTS — stated precisely, because the first version of this
docstring overshot and the overshoot was measured false on 2026-08-22. It claimed
that under a skew "the shipped bundle has never executed on the runtime it ships
on". That is wrong: `ci.yml`'s `manifest-load` job (and the dogfood step) run
`uses: ./`, which makes GitHub launch `dist/index.js` on the manifest's OWN
runtime on every push. The bundle has therefore been executing on node24 for as
long as the manifest has said node24.

What a skew really means is narrower and still serious: the TEST SUITE has never
run on the shipped runtime. The self-use jobs exercise one happy path; the 132
assertions run wherever `setup-node` points, and if that is a different major
then no runtime-specific break is ever asserted against — it reaches consumers
instead of CI. Measured at v1.9.6: manifest `node24`, CI `node20`, esbuild
`node20`, `engines.node` absent, ~7 weeks live. When CI was finally moved to
node24 the suite did not merely wobble, it died on contact —
`node --test lib/tests/` was passing a DIRECTORY, giving `pass 0 / fail 1` with
zero assertions executed. It had been broken the whole time and no green could
say so, because a second defect (a `| tee` pipeline swallowing the step's exit
status) was holding that verdict shut. Neither defect was detectable while the
other stood.

The gate's own claim is therefore bounded: it proves the declarations AGREE. It
does not prove the suite is meaningful — `ci.yml`'s `shell: bash` is what lets a
red suite be seen at all, and the two controls are independent.

The declaration sites (all must agree on ONE major)
---------------------------------------------------
  1. `action.yml`            `runs.using: 'nodeNN'`      — what GitHub launches
  2. `.github/workflows/*`   `node-version: 'NN'`        — what CI proves
  3. `esbuild.config.mjs`    `target: 'nodeNN'`          — what syntax is lowered to
  4. `package.json`          `engines.node`              — what the package declares
  5. `package.json`          `devDependencies.@types/node` — what typecheck believes

Site 4 is REQUIRED, not optional: its absence is exactly how the skew stayed
invisible — nothing in the repo stated the intended runtime, so no tool could
contradict any of the other three. A missing `engines.node` is a FAIL, not a skip
(`absent != skip`, `MEM:synthetic-gate-vacuity-vs-judgment`).

Site 5 is checked only when present, and that asymmetry with site 4 is
deliberate rather than a softening. `engines.node` is the repo's STATEMENT OF
INTENT — its absence is a hiding place, so it must fail. `@types/node` is a
derived convenience: its absence removes the axis instead of concealing a
disagreement, so there is nothing to contradict. It is still printed explicitly
when absent, so the narrowing is visible rather than silent. It earns a site
because it drifts the same way and is just as invisible: measured 2026-08-22,
`^20.12.0` against a node24 manifest — `tsc` was type-checking the Action against
a stdlib two majors older than the one it runs on, and typechecked green doing it.

Prose counts as a declaration. `esbuild.config.mjs`'s header comment names the
runtime it bundles for; a comment that states a fact the compiler does not check
is state, and stale state here mis-aims the next reader (root `CLAUDE.md`
§ Comments). It is checked as site 3b and reported separately from the `target:`.

WHY THIS LIVES IN `sift-action` AND NOT THE WORKSPACE PIN GATE. Every declaration
site above is a file in THIS repo, so the commit that introduces a skew is a
commit here — and this repo's `ci.yml` runs on its own push/PR/tag. The
superproject's `pin_coherence.py` only fires on a superproject push, which is why
a skew survived ~7 weeks: nothing in the changed repo's own CI ever looked. This
is the same ruling already applied to the engine pin when it left `lint.yml`
(see the note there): the property is owned where it changes, and a second home
is only somewhere to drift.

Vacuity discipline
------------------
  * A site whose file is missing, or whose pattern matches ZERO times, is a HARD
    ERROR (exit 2) — never a silent narrowing to the sites that still parse.
  * `--selftest` proves each extractor has teeth: known-good strings must yield
    the right major, known-bad strings must not match.

Exit: 0 coherent · 1 skew (or a missing `engines.node`) · 2 the gate could not run.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# `runs: using: 'node24'` in the Action manifest — what GitHub actually launches.
RE_USING = re.compile(r"^\s*using\s*:\s*['\"]?node(\d+)['\"]?\s*$", re.MULTILINE)
# `node-version: '20'` under a setup-node step — what CI proves the bundle on.
RE_SETUP_NODE = re.compile(r"^\s*node-version\s*:\s*['\"]?(\d+)(?:\.[\dx.]+)?['\"]?\s*$", re.MULTILINE)
# esbuild's lowering target.
RE_ESBUILD_TARGET = re.compile(r"^\s*target\s*:\s*['\"]node(\d+)['\"]", re.MULTILINE)
# The prose in esbuild's header that names the runtime it bundles for.
RE_ESBUILD_PROSE = re.compile(r"using\s*:\s*node(\d+)")
# `"engines": {"node": ">=24"}` / `"@types/node": "^24.13.3"` — read from parsed
# JSON, not by regex; this only lifts the MAJOR out of an already-extracted range.
RE_RANGE_MAJOR = re.compile(r"(\d+)")


@dataclass(frozen=True)
class Site:
    label: str
    relpath: str
    major: int
    lineno: int
    quote: str


def _lineno_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _quote(text: str, lineno: int) -> str:
    return text.splitlines()[lineno - 1].strip()


def _read(root: Path, rel: str, errors: list[str]) -> str | None:
    path = root / rel
    if not path.is_file():
        errors.append(f"declaration site '{rel}' does not exist — the layout moved; "
                      f"update this gate instead of letting coverage narrow silently.")
        return None
    return path.read_text(encoding="utf-8")


def collect(root: Path) -> tuple[list[Site], list[str], list[str], list[str]]:
    """Returns (sites, scope errors, violations, notes).

    Scope errors (exit 2) mean the gate could not read a declaration site at all.
    Violations (exit 1) are findings — an absent `engines.node` is one of them, and
    it must NOT be reported as a scope error: that would let the runtime skew hide
    behind a "cannot run", which is the exact rounding this gate exists to refuse.
    Notes are printed, never fatal: they record an axis that is legitimately absent
    so the narrowing stays visible.
    """
    sites: list[Site] = []
    errors: list[str] = []
    violations: list[str] = []
    notes: list[str] = []

    text = _read(root, "action.yml", errors)
    if text is not None:
        matches = list(RE_USING.finditer(text))
        if not matches:
            errors.append("action.yml declares no `runs.using: nodeNN` — the manifest's "
                          "runtime declaration is the anchor of this gate and it is unreadable.")
        for m in matches:
            ln = _lineno_of(text, m.start())
            sites.append(Site("action.yml runs.using", "action.yml", int(m.group(1)), ln, _quote(text, ln)))

    wf_dir = root / ".github" / "workflows"
    if not wf_dir.is_dir():
        errors.append(".github/workflows/ is absent — nothing proves the bundle at all.")
    else:
        wf_files = sorted(p for p in wf_dir.iterdir() if p.suffix in (".yml", ".yaml"))
        if not wf_files:
            errors.append(".github/workflows/ matched ZERO workflow files — refusing to pass vacuously.")
        found_any = False
        for wf in wf_files:
            wtext = wf.read_text(encoding="utf-8")
            for m in RE_SETUP_NODE.finditer(wtext):
                found_any = True
                ln = _lineno_of(wtext, m.start())
                rel = str(wf.relative_to(root))
                sites.append(Site(f"CI setup-node ({wf.name})", rel, int(m.group(1)), ln, _quote(wtext, ln)))
        if not found_any:
            errors.append("no `node-version:` in any workflow — the bundle is proven on the "
                          "runner default, which is unpinned and therefore unreproducible.")

    text = _read(root, "esbuild.config.mjs", errors)
    if text is not None:
        m = RE_ESBUILD_TARGET.search(text)
        if m is None:
            errors.append("esbuild.config.mjs declares no `target: 'nodeNN'` — the lowering "
                          "target is unpinned.")
        else:
            ln = _lineno_of(text, m.start())
            sites.append(Site("esbuild target", "esbuild.config.mjs", int(m.group(1)), ln, _quote(text, ln)))
        p = RE_ESBUILD_PROSE.search(text)
        if p is not None:
            ln = _lineno_of(text, p.start())
            sites.append(Site("esbuild header prose", "esbuild.config.mjs", int(p.group(1)), ln, _quote(text, ln)))

    text = _read(root, "package.json", errors)
    if text is not None:
        try:
            pkg = json.loads(text)
        except json.JSONDecodeError as exc:
            errors.append(f"package.json does not parse: {exc}")
            pkg = {}

        def _line_of(needle: str) -> int:
            return next((i for i, line in enumerate(text.splitlines(), 1) if needle in line), 1)

        node_range = (pkg.get("engines") or {}).get("node")
        if node_range is None:
            violations.append(
                "package.json declares no `engines.node`. That is not a missing nicety: it is the "
                "one place the repo states which runtime it intends, and its absence is why the "
                "manifest/CI/esbuild skew had nothing to contradict it. Declare it — an absent "
                "declaration is a FAIL here, never a skip."
            )
        else:
            m = RE_RANGE_MAJOR.search(str(node_range))
            if m is None:
                errors.append(f"package.json `engines.node` = {node_range!r} names no major version.")
            else:
                sites.append(Site("package.json engines.node", "package.json",
                                  int(m.group(1)), _line_of('"node"'), f'"node": "{node_range}"'))

        types_range = (pkg.get("devDependencies") or {}).get("@types/node")
        if types_range is None:
            notes.append("package.json declares no `devDependencies.@types/node` — no types axis "
                         "to check. Unlike `engines.node` this is not a hiding place: its absence "
                         "removes the axis rather than concealing a disagreement.")
        else:
            m = RE_RANGE_MAJOR.search(str(types_range))
            if m is None:
                errors.append(f"package.json `@types/node` = {types_range!r} names no major version.")
            else:
                sites.append(Site("package.json @types/node", "package.json", int(m.group(1)),
                                  _line_of('"@types/node"'), f'"@types/node": "{types_range}"'))
    return sites, errors, violations, notes


def run_selftest() -> int:
    cases: tuple[tuple[re.Pattern[str], str, int | None], ...] = (
        (RE_USING, "  using: 'node24'\n", 24),
        (RE_USING, "  using: node20\n", 20),
        (RE_USING, "  using: 'docker'\n", None),
        (RE_USING, "# using: 'node24' in a comment\n", None),
        (RE_SETUP_NODE, "          node-version: '20'\n", 20),
        (RE_SETUP_NODE, "          node-version: 24.1.0\n", 24),
        (RE_SETUP_NODE, "          node-version-file: .nvmrc\n", None),
        (RE_ESBUILD_TARGET, "    target: 'node20',\n", 20),
        (RE_ESBUILD_TARGET, "    target: 'es2022',\n", None),
        (RE_ESBUILD_PROSE, "// Bundles for `runs: using: node20`.\n", 20),
        (RE_ESBUILD_PROSE, "// Bundles the Action to a single ESM file.\n", None),
        (RE_RANGE_MAJOR, ">=24", 24),
        (RE_RANGE_MAJOR, "^24.13.3", 24),
        (RE_RANGE_MAJOR, "^20.12.0", 20),
    )
    failures = 0
    for pattern, sample, expected in cases:
        m = pattern.search(sample)
        got = int(m.group(1)) if m else None
        if got != expected:
            print(f"  SELFTEST FAIL: {sample.strip()!r} -> {got!r}, expected {expected!r}")
            failures += 1
    if failures:
        print(f"selftest: {failures} failure(s) — the extractor set is broken.")
        return 1
    print(f"selftest: OK ({len(cases)} extractor cases).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path,
                        default=Path(__file__).resolve().parent.parent,
                        help="The sift-action repo root (default: this script's parent repo).")
    parser.add_argument("--selftest", action="store_true", help="Prove the extractors and exit.")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()

    root = args.root.resolve()
    if not root.is_dir():
        print(f"SCOPE ERROR: {root} is not a directory.")
        return 2

    sites, errors, violations, notes = collect(root)

    print(f"node runtime coherence: {len(sites)} declaration site(s) read under {root}.")
    for s in sites:
        print(f"  node{s.major:<3} {s.relpath}:{s.lineno}  [{s.label}]  {s.quote}")
    for n in notes:
        print(f"  (note) {n}")

    if errors:
        print("\nSCOPE ERROR — the gate cannot answer honestly:")
        for e in errors:
            print(f"  - {e}")
        return 2

    failed = bool(violations)
    if violations:
        print(f"\nMISSING DECLARATION [{len(violations)}]:")
        for v in violations:
            print(f"  - {v}")

    majors = sorted({s.major for s in sites})
    if len(majors) > 1:
        failed = True
        print(f"\nRUNTIME SKEW: {len(majors)} different Node majors declared for one bundle: {majors}")
        for major in majors:
            for s in (x for x in sites if x.major == major):
                print(f"  node{major:<3} <- {s.relpath}:{s.lineno} [{s.label}]")
        print(
            "\nThe test suite is not running on the runtime this Action ships on, so a\n"
            "runtime-specific break reaches consumers instead of CI. Fix at root: pick ONE\n"
            "major, then move every declaration together — the manifest is what GitHub\n"
            "launches, so CI, esbuild and the types follow it, not the other way round."
        )

    if failed:
        return 1

    print(f"\nPASS: every declaration site agrees on node{majors[0]}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
