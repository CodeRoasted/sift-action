#!/usr/bin/env bash
# Move the Action's ENGINE pin to a PUBLISHED sift engine release.
#
# WHY THIS LIVES HERE, AND NOT IN `malf bump`
# -------------------------------------------
# The Action's engine pin used to ride the workspace-wide platform bump: `malf bump X.Y.Z`
# rewrote src/sift-version.ts to X.Y.Z, and pin_coherence INV-8 then asserted the pin was
# <= the open dev baseline. That coupling was wrong in a specific, recurring way. The engine
# for a version is published by the eidos Release DURING that version's cut — so between the
# post-cut bump and the next cut, the platform baseline names an engine that does not exist
# yet. The bump therefore produced a commit that could not be pushed (it would 404 every
# consumer at download), and the repo sat deliberately dirty for a whole cycle, with the
# runbook carrying "sift-action is expected to be behind" as a standing exception.
#
# The fix is to invert the direction. The pin is not derived from what WE are developing; it
# is derived from what has been PUBLISHED. So this script reads the published release list and
# pins to that. The old INV-8 assertion (`pin <= baseline`) becomes unnecessary rather than
# relocated: a value taken FROM the published set cannot be ahead of it. Correct by
# construction beats asserted after the fact — and it is strictly stronger, because `<=`
# still permitted a pin that was below the baseline yet ahead of anything actually published.
#
# The Action's OWN version (package.json + the @v1 consumer tag) is a separate line and is
# untouched here; its lockfile coherence remains pin_coherence INV-9.
#
# USAGE
#   ./bump.sh              # pin to the latest published engine
#   ./bump.sh 1.8.5        # pin to a specific published engine
#
# Cadence: run it after an engine cut publishes engine-v<X.Y.Z>, then cut an Action release
# and re-point @v1. Until it is run the Action LAGS the newest engine — which is the intended
# posture (a consumer must never fetch an engine that is not published), not a defect.

set -euo pipefail

REPO="CodeRoasted/sift-action"
ASSET="sift-linux-x64"
here="$(cd "$(dirname "$0")" && pwd)"

err() { echo "bump: $*" >&2; exit 1; }

# ── 1. Resolve the target engine version ────────────────────────────────────────────────
# Same resolution idiom as install.sh: the releases API, no jq dependency, sort -V for a
# correct numeric ordering (lexical sort puts 1.8.10 before 1.8.9).
ver="${1:-}"
if [ -z "$ver" ]; then
    ver="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" 2>/dev/null \
        | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"engine-v[0-9]+\.[0-9]+\.[0-9]+"' \
        | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1)"
    [ -n "$ver" ] || err "could not resolve the latest published engine — pass one explicitly: ./bump.sh 1.8.5"
    echo "bump: latest published engine is $ver"
else
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "usage: ./bump.sh [X.Y.Z]"
fi

# ── 2. Refuse a pin whose assets do not exist ───────────────────────────────────────────
# The whole point of this script is that the pin is only ever a published one, so prove it
# BEFORE writing any file rather than leaving a bad pin behind on failure. Both the binary
# and its checksum must be there: install.sh treats a missing .sha256 as fatal, so a release
# carrying the binary alone would still break every installer.
base="https://github.com/$REPO/releases/download/engine-v$ver"
for suffix in "" ".sha256"; do
    code="$(curl -sSL -o /dev/null -w '%{http_code}' "$base/$ASSET$suffix" || echo 000)"
    case "$code" in
        200) echo "bump: ✓ $ASSET$suffix published (HTTP $code)" ;;
        *)   err "engine-v$ver/$ASSET$suffix is NOT published (HTTP $code) — refusing to pin an engine consumers cannot download." ;;
    esac
done

# ── 3. Rewrite the FOUR source pins ─────────────────────────────────────────────────────
# src/sift-version.ts is what the bundle bakes in; examples/jenkins/Jenkinsfile is a doc
# recipe a user copies verbatim, so a stale one silently installs an old engine. They moved
# in lock-step under `malf bump` + INV-8b and must keep doing so — enforced below by
# re-reading both after the write rather than trusting the substitution.
#
# install.sh / install.ps1 JOINED THIS LIST on 2026-08-02, and the reason is the whole point
# of the change that added them: both scripts used to default to `latest`, resolving the
# newest release at run time. That silently violated the delivery contract (every client
# version-pinned, never "latest") and made every unattended install irreproducible. They now
# carry a baked default pin — which only stays true if the SAME writer that owns the other
# pins owns these too. A hand-maintained pin beside a derived one is the drift class this
# script exists to remove: derive at the writer, from the PUBLISHED set, or it rots.
ver_ts="$here/src/sift-version.ts"
jenkinsfile="$here/examples/jenkins/Jenkinsfile"
install_sh="$here/install.sh"
install_ps1="$here/install.ps1"

[ -f "$ver_ts" ] || err "$ver_ts not found"
[ -f "$install_sh" ] || err "$install_sh not found"
[ -f "$install_ps1" ] || err "$install_ps1 not found"
python3 - "$ver" "$ver_ts" "$jenkinsfile" "$install_sh" "$install_ps1" <<'PY'
import pathlib, re, sys
ver = sys.argv[1]
ver_ts, jenkinsfile, install_sh, install_ps1 = (pathlib.Path(p) for p in sys.argv[2:6])
targets = (
    (ver_ts,      r"(SIFT_VERSION\s*=\s*['\"])[^'\"]*(['\"])",        True),
    (jenkinsfile, r"(SIFT_VERSION\s*=\s*['\"])\d+\.\d+\.\d+(['\"])",  False),
    (install_sh,  r"(SIFT_PINNED_VERSION=\")\d+\.\d+\.\d+(\")",        True),
    (install_ps1, r"(\$SiftPinnedVersion = ')\d+\.\d+\.\d+(')",        True),
)
for path, pattern, required in targets:
    if not path.exists():
        if required:
            sys.exit(f"bump: {path} is required and missing")
        continue
    text = path.read_text()
    new, n = re.subn(pattern, lambda m: f"{m.group(1)}{ver}{m.group(2)}", text, count=1)
    if n != 1:
        sys.exit(f"bump: expected exactly 1 substitution in {path}, made {n}")
    if new != text:
        path.write_text(new)
        print(f"bump: rewrote {path.name} -> {ver}")
    else:
        print(f"bump: {path.name} already at {ver}")
PY

# ── 4. Repackage the bundle — the committed dist IS what runs ───────────────────────────
# action.yml declares `main: dist/index.js`, so GitHub executes the COMMITTED bundle and
# esbuild bakes SIFT_VERSION in at build time. Rewriting only the source leaves the bundle
# still downloading the previous engine. `malf bump` used to do this repackage; dropping the
# Action from that bump means the step has to live here or the bundle silently rots. ci.yml's
# dist-sync gate catches it after the fact — this keeps it coherent by construction.
[ -d "$here/node_modules" ] || err "node_modules missing — run 'npm ci' first; the pins are rewritten but dist/index.js cannot be regenerated."
( cd "$here" && npm run package ) || err "'npm run package' failed — dist/index.js still bakes in the old engine."

grep -q "SIFT_VERSION = \"$ver\"" "$here/dist/index.js" \
    || err "dist/index.js does not embed SIFT_VERSION = \"$ver\" after repackage."

# ── 5. Prove every source pin agrees (what INV-8b used to assert) ───────────────────────
# Re-READ after the write rather than trusting the substitution: a regex that silently
# matched nothing would otherwise leave a stale pin and report success.
a="$(grep -oE "SIFT_VERSION\s*=\s*['\"][^'\"]+['\"]" "$ver_ts" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ "$a" = "$ver" ] || err "src/sift-version.ts reads $a, expected $ver after the rewrite."
if [ -f "$jenkinsfile" ]; then
    b="$(grep -oE "SIFT_VERSION\s*=\s*['\"][0-9.]+['\"]" "$jenkinsfile" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    [ "$a" = "$b" ] || err "src/sift-version.ts ($a) and the Jenkins example ($b) disagree after the rewrite."
fi
c="$(grep -oE 'SIFT_PINNED_VERSION="[0-9.]+"' "$install_sh" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ "$a" = "$c" ] || err "src/sift-version.ts ($a) and install.sh ($c) disagree after the rewrite."
d="$(grep -oE "\\\$SiftPinnedVersion = '[0-9.]+'" "$install_ps1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ "$a" = "$d" ] || err "src/sift-version.ts ($a) and install.ps1 ($d) disagree after the rewrite."

# The installers must never fall back to `latest` again: the default has to be the pin, and
# `latest` reachable only when the user names it. Asserted here because this is the writer
# that would otherwise re-introduce it.
grep -q 'SIFT_PINNED_VERSION' "$install_sh" \
    || err "install.sh lost its baked pin — it would default to 'latest' again."
grep -q 'SiftPinnedVersion' "$install_ps1" \
    || err "install.ps1 lost its baked pin — it would default to 'latest' again."

echo "✓ sift-action pinned to published engine v$ver (src + jenkins example + install.sh + install.ps1 + dist bundle)"
echo "  next: commit, cut an Action release, and re-point @v1 at it."
