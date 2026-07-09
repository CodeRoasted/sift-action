#!/usr/bin/env bash
###############################################################################
# samples_showcase — run the PUBLIC `sift` engine over our PUBLIC Jenkins sample
# logs and render an honest "what Sift does on a Jenkins pipeline" showcase.
#
# CLIENT-FACING TRANSPARENCY, NOT A GATE. It tells the honest two-part story a
# prospective user needs to trust the tool:
#
#   1. silent-on-green — diff a passing build against ITSELF. Sift must stay quiet
#      (no significant change). A tool that cries wolf on an unchanged log is
#      useless; this proves Sift doesn't.
#   2. regression-catch — diff the SAME job's last green build against a failing
#      build. Sift surfaces the structural regression.
#
# The pair is chosen from the synthetic Jenkins slice's own metadata (declarative
# Pipeline: SUCCESS = baseline, FAILURE = changed) — no hand-picked filenames.
# This runs the REAL engine binary over REAL published samples; the output is
# whatever Sift actually produces (incl. any dialect-unawareness before the 1.7.6
# Jenkins semantic package — that is honest, load-bearing evidence, not a defect
# to hide).
#
#   samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>
#
# <hub-samples-root> is a coderoast-hub checkout's `samples/` tree; the Jenkins
# slice lives at `samples/marker_corpus/samples/` (corpus.jsonl + logs/).
###############################################################################
set -euo pipefail

SIFT="${1:?usage: samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>}"
SAMPLES="${2:?usage: samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>}"
OUT="${3:?usage: samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>}"

[ -x "$SIFT" ]     || { echo "error: sift binary '$SIFT' is not executable" >&2; exit 2; }
[ -d "$SAMPLES" ]  || { echo "error: hub-samples-root '$SAMPLES' is not a directory" >&2; exit 2; }

JENKINS="$SAMPLES/marker_corpus/samples"
CORPUS="$JENKINS/corpus.jsonl"
[ -f "$CORPUS" ] || { echo "error: no Jenkins corpus.jsonl at $CORPUS" >&2; exit 2; }
mkdir -p "$OUT"

# Pick the baseline/changed pair from the slice's own metadata: same sub-type (declarative Pipeline),
# green vs red. Emits four TSV fields (baseline_log, baseline_id, changed_log, changed_id) or nothing.
read -r BASE_LOG BASE_ID CHANGED_LOG CHANGED_ID < <(python3 - "$CORPUS" <<'PY'
import json, sys
recs = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
def pick(sub, res):
    for r in recs:
        if r.get("sub_type") == sub and r.get("result") == res:
            return r
    return None
base = pick("declarative", "SUCCESS")
changed = pick("declarative", "FAILURE")
if not (base and changed):   # fall back to any SUCCESS vs any FAILURE
    base = base or next((r for r in recs if r.get("result") == "SUCCESS"), None)
    changed = changed or next((r for r in recs if r.get("result") == "FAILURE"), None)
if base and changed:
    print(f'{base["log"]}\t{base["sample_id"]}\t{changed["log"]}\t{changed["sample_id"]}')
PY
)
if [ -z "${BASE_LOG:-}" ] || [ -z "${CHANGED_LOG:-}" ]; then
    echo "error: could not select a SUCCESS baseline + FAILURE changed pair from $CORPUS" >&2; exit 1
fi

BASE="$JENKINS/$BASE_LOG"
CHANGED="$JENKINS/$CHANGED_LOG"
if [ ! -f "$BASE" ] || [ ! -f "$CHANGED" ]; then
    echo "error: selected logs missing ($BASE / $CHANGED)" >&2; exit 1
fi
echo "baseline=$BASE_ID  changed=$CHANGED_ID" >&2

# run_diff <name> <baseline-log> <baseline-label> <changed-log> <changed-label>
# --format both: JSON report to -o, human render to stdout. A non-zero exit is the ADVISORY verdict
# (significant/regression), never a script error — capture it, don't abort.
run_diff() {
    local name="$1" blog="$2" blabel="$3" clog="$4" clabel="$5" rc=0
    "$SIFT" "$blog" "$clog" --format both -o "$OUT/$name.report.json" \
        --baseline-label "$blabel" --changed-label "$clabel" > "$OUT/$name.render.txt" 2>&1 || rc=$?
    echo "$rc" > "$OUT/$name.exit"
    echo "  $name: sift exit $rc → $name.report.json + $name.render.txt" >&2
}

run_diff "silent-on-green" \
    "$BASE"    "green build ($BASE_ID)" \
    "$BASE"    "same build, re-run ($BASE_ID)"
run_diff "regression-catch" \
    "$BASE"    "last green ($BASE_ID)" \
    "$CHANGED" "failing build ($CHANGED_ID)"

sig="$(cat "$OUT/silent-on-green.exit")"
reg="$(cat "$OUT/regression-catch.exit")"

{
  echo "# Sift over our public Jenkins samples"
  echo
  echo "**Sift** is the CodeRoast structural CI-log differ — it compares a build's log against a"
  echo "known-good baseline and surfaces the *structural* change, not a line-by-line text diff. This"
  echo "page is the real \`sift\` engine run over the **public Jenkins Pipeline sample logs** we ship in"
  echo "[coderoast-hub](https://github.com/CodeRoasted/coderoast-hub) under \`samples/marker_corpus/\`."
  echo
  echo "It is an **honest showcase, not a gate**. Two runs tell the whole story:"
  echo
  echo "| run | baseline → changed | sift exit | what it shows |"
  echo "| --- | --- | --- | --- |"
  echo "| **silent-on-green** | \`$BASE_ID\` → itself | \`$sig\` | an unchanged log must raise **nothing** (exit 0) — Sift does not cry wolf |"
  echo "| **regression-catch** | \`$BASE_ID\` → \`$CHANGED_ID\` | \`$reg\` | a green build vs a failing one — Sift surfaces the structural regression |"
  echo
  echo "> Sift's advisory exit code: \`0\` = no significant change · non-zero = significant / regression."
  echo "> Each run's machine-readable \`*.report.json\` and human render \`*.render.txt\` are alongside this file."
  echo
  echo "## The renders"
  echo
  for name in silent-on-green regression-catch; do
    echo "### \`$name\`  (sift exit \`$(cat "$OUT/$name.exit")\`)"
    echo
    echo '```'
    # Cap the embedded render so the README stays skimmable; the full text is in the artifact.
    head -c 8000 "$OUT/$name.render.txt"
    echo
    echo '```'
    echo
  done
  echo "> These logs are public-safe by construction — a fully synthetic Jenkins slice (fabricated"
  echo "> orgs/builds, zero third-party bytes) reproducing the engine-emitted marker skeleton. Our real"
  echo "> crawled Jenkins corpus stays private."
} > "$OUT/README.md"

echo "sift showcase rendered → $OUT (silent-on-green exit $sig · regression-catch exit $reg)" >&2
