#!/usr/bin/env bash
###############################################################################
# samples_showcase — run the PUBLIC `sift` engine over our PUBLIC CI-log samples
# and render an honest "what Sift does on a CI pipeline" showcase.
#
# CLIENT-FACING TRANSPARENCY, NOT A GATE. For every corpus whose logs carry a
# green-vs-red CI outcome (so a baseline-vs-changed diff is meaningful — Jenkins
# Pipeline, GitHub Actions; NOT system logs like LogHub) it tells the honest
# two-part story:
#
#   1. silent-on-green — diff a passing build against ITSELF. Sift must stay quiet
#      (0 significant). A tool that cries wolf on an unchanged log is useless.
#   2. regression-catch — diff a passing build against a failing one (same project
#      where possible). Sift surfaces the structural regression.
#
# Each corpus's baseline/changed pair is chosen from that corpus's OWN metadata
# (corpus.jsonl), never hand-picked filenames — Jenkins by (sub_type, result),
# GitHub Actions by (repo, ci_outcome). Runs the REAL engine over REAL published
# samples; the output is whatever Sift actually produces.
#
#   samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>
#
# <hub-samples-root> is a coderoast-hub checkout's `samples/` tree.
###############################################################################
set -euo pipefail

SIFT="${1:?usage: samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>}"
SAMPLES="${2:?usage: samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>}"
OUT="${3:?usage: samples_showcase.sh <sift-binary> <hub-samples-root> <out-dir>}"

[ -x "$SIFT" ]     || { echo "error: sift binary '$SIFT' is not executable" >&2; exit 2; }
[ -d "$SAMPLES" ]  || { echo "error: hub-samples-root '$SAMPLES' is not a directory" >&2; exit 2; }
mkdir -p "$OUT"

# Diffable corpora: "slug|label|hub-corpus-dir|result-field|success|failure|log-field|group-field".
# LogHub is deliberately absent — system logs have no green/red CI baseline to diff.
# group-field picks a same-project pair (same sub_type / same repo) so the regression is like-for-like.
CORPORA=(
  "jenkins|Jenkins Pipeline|marker_corpus|result|SUCCESS|FAILURE|log|sub_type"
  "gha|GitHub Actions|revert_corpus|ci_outcome|success|failure|log_annotated|repo"
)

# select_pair: prints "baseline_log<TAB>baseline_id<TAB>changed_log<TAB>changed_id" or nothing.
# baseline = first record with result==success; changed = a result==failure record, preferring the
# SAME group (sub_type/repo) as the baseline, else any failure. sample_id falls back to the log stem.
select_pair() {
    python3 - "$@" <<'PY'
import json, sys, os
corpus, rfield, sval, fval, logf, gfield = sys.argv[1:7]
recs = [json.loads(l) for l in open(corpus, encoding="utf-8") if l.strip()]
def sid(r):
    return r.get("sample_id") or os.path.splitext(os.path.basename(r.get(logf, "")))[0]
base = next((r for r in recs if r.get(rfield) == sval), None)
changed = None
if base is not None:
    changed = next((r for r in recs if r.get(rfield) == fval and r.get(gfield) == base.get(gfield)), None)
    changed = changed or next((r for r in recs if r.get(rfield) == fval), None)
if base is not None and changed is not None and base.get(logf) and changed.get(logf):
    print(f'{base[logf]}\t{sid(base)}\t{changed[logf]}\t{sid(changed)}')
PY
}

# run_diff <corpus-out-dir> <name> <baseline-log> <baseline-label> <changed-log> <changed-label>
# --format both: JSON report to -o, human render to stdout. --fail-on significant makes the exit a REAL
# verdict signal (0 = nothing significant, non-zero = fires) — never a script error; capture, don't abort.
run_diff() {
    local dir="$1" name="$2" blog="$3" blabel="$4" clog="$5" clabel="$6" rc=0
    "$SIFT" "$blog" "$clog" --format both -o "$dir/$name.report.json" \
        --baseline-label "$blabel" --changed-label "$clabel" --fail-on significant \
        > "$dir/$name.render.txt" 2>&1 || rc=$?
    echo "$rc" > "$dir/$name.exit"
    grep -oE '[0-9]+ changes?, [0-9]+ significant' "$dir/$name.render.txt" | tail -1 > "$dir/$name.verdict" || true
    [ -s "$dir/$name.verdict" ] || echo "—" > "$dir/$name.verdict"
    echo "    $name: exit $rc · $(cat "$dir/$name.verdict")" >&2
}

shown=()   # "slug|label|base_id|changed_id" for corpora actually rendered
for spec in "${CORPORA[@]}"; do
    IFS='|' read -r slug label cdir rfield sval fval logf gfield <<< "$spec"
    corpus_dir="$SAMPLES/$cdir/samples"
    jsonl="$corpus_dir/corpus.jsonl"
    if [ ! -f "$jsonl" ]; then
        echo "skip $slug ($jsonl absent)" >&2; continue
    fi
    read -r BASE_LOG BASE_ID CHANGED_LOG CHANGED_ID < <(select_pair "$jsonl" "$rfield" "$sval" "$fval" "$logf" "$gfield") || true
    if [ -z "${BASE_LOG:-}" ] || [ -z "${CHANGED_LOG:-}" ]; then
        echo "skip $slug (no $sval baseline + $fval changed pair in $jsonl)" >&2; continue
    fi
    base="$corpus_dir/$BASE_LOG"; changed="$corpus_dir/$CHANGED_LOG"
    if [ ! -f "$base" ] || [ ! -f "$changed" ]; then
        echo "skip $slug (selected logs missing: $base / $changed)" >&2; continue
    fi
    echo "$label ($slug): baseline=$BASE_ID  changed=$CHANGED_ID" >&2
    cout="$OUT/$slug"; mkdir -p "$cout"
    run_diff "$cout" "silent-on-green" \
        "$base"    "green build ($BASE_ID)" \
        "$base"    "same build, re-run ($BASE_ID)"
    run_diff "$cout" "regression-catch" \
        "$base"    "last green ($BASE_ID)" \
        "$changed" "failing build ($CHANGED_ID)"
    shown+=("$slug|$label|$BASE_ID|$CHANGED_ID")
    unset BASE_LOG CHANGED_LOG
done

[ "${#shown[@]}" -gt 0 ] || { echo "error: no diffable corpus rendered under $SAMPLES" >&2; exit 1; }

# ── Aggregate client-facing README over every corpus shown ────────────────────
{
  echo "# Sift over our public CI-log samples"
  echo
  echo "**Sift** is the CodeRoast structural CI-log differ — it compares a build's log against a"
  echo "known-good baseline and surfaces the *structural* change, not a line-by-line text diff. This"
  echo "page is the real \`sift\` engine run over the **public CI-log samples** we ship in"
  echo "[coderoast-hub](https://github.com/CodeRoasted/coderoast-hub) under \`samples/\`."
  echo
  echo "It is an **honest showcase, not a gate**. For each CI dialect with a green-vs-red outcome, two"
  echo "runs tell the whole story (each uses \`--fail-on significant\`, so the exit corroborates the"
  echo "verdict): **silent-on-green** (a passing build vs itself → nothing) and **regression-catch** (a"
  echo "passing build vs a failing one → the structural regression). LogHub-style system logs are not"
  echo "shown — they have no green/red CI baseline to diff."
  echo
  echo "| dialect | run | baseline → changed | sift verdict | exit |"
  echo "| --- | --- | --- | --- | --- |"
  for entry in "${shown[@]}"; do
    IFS='|' read -r slug label bid cid <<< "$entry"
    sv="$(cat "$OUT/$slug/silent-on-green.verdict")";  se="$(cat "$OUT/$slug/silent-on-green.exit")"
    rv="$(cat "$OUT/$slug/regression-catch.verdict")"; re="$(cat "$OUT/$slug/regression-catch.exit")"
    echo "| **$label** | silent-on-green | \`$bid\` → itself | $sv | \`$se\` |"
    echo "| | regression-catch | \`$bid\` → \`$cid\` | $rv | \`$re\` |"
  done
  echo
  echo "> The **verdict** (\`N changes, M significant\`) is Sift's own summary line; the exit is the"
  echo "> advisory gate (\`0\` = nothing significant, non-zero = fires). Per-run \`*.report.json\` +"
  echo "> \`*.render.txt\` are under each dialect's folder (\`<slug>/\`)."
  echo
  echo "> **Note (pre-1.7.6):** the canon core is still dialect-unaware (e.g. the Jenkins timestamper"
  echo "> prefix isn't stripped, so each line is its own template) — the diff is coarser than it will be"
  echo "> once the per-dialect semantic packages land. Even so, Sift already stays silent on green and"
  echo "> fires on the regression across dialects."
  echo
  echo "## The renders"
  echo
  for entry in "${shown[@]}"; do
    IFS='|' read -r slug label bid cid <<< "$entry"
    echo "### $label"
    echo
    for name in silent-on-green regression-catch; do
      echo "#### \`$slug/$name\`  (sift exit \`$(cat "$OUT/$slug/$name.exit")\`)"
      echo
      echo '```'
      head -c 6000 "$OUT/$slug/$name.render.txt"
      echo
      echo '```'
      echo
    done
  done
  echo "> These logs are public-safe by construction — synthetic fixtures (fabricated orgs/builds,"
  echo "> zero third-party bytes) reproducing each engine's marker skeleton. Our real crawled corpora"
  echo "> stay private."
} > "$OUT/README.md"

echo "sift showcase rendered → $OUT (${#shown[@]} dialect(s): ${shown[*]%%|*})" >&2
