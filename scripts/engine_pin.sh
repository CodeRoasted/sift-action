#!/usr/bin/env bash
# Print the ENGINE pin — the `sift` binary version this Action downloads at runtime.
#
# ONE definition, because there are now two readers with different failure modes and a
# drift between them is silent in both directions:
#   * ci.yml's "Engine pin is PUBLISHED" gate, which probes that this version's release
#     assets are live (a pin naming an unpublished release 404s every consumer);
#   * wall-time.yml, which measures the engine a user actually receives — a measurement of
#     a DIFFERENT binary than the one we ship is not a measurement of our product.
# A second hand-rolled `grep -oE` in the second reader would parse the same file with its
# own regex, and the day the declaration's spelling moves, one reader follows and the other
# keeps returning a stale version while still exiting 0.
#
# src/sift-version.ts is the truth (`./bump.sh` owns the value and refuses to write an
# unpublished one). This script only READS it, and fails loudly rather than emitting an
# empty string: an empty version composes into a URL that 404s, which reports as a missing
# release instead of as a parse failure and sends the reader hunting the wrong bug.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/src/sift-version.ts"

[ -f "$src" ] || { echo "engine_pin: $src not found" >&2; exit 1; }

# `|| true` is load-bearing under `set -eo pipefail`: on a mangled declaration the first
# grep matches nothing, the pipeline returns non-zero, and `set -e` would abort HERE —
# exiting 1 with no message, which is exactly the silent failure this script exists to
# prevent. Swallowing the pipeline status hands the decision to the `-z` test below, which
# names the file and the symbol. Verified by mangling the declaration and reading stderr.
ver="$(grep -oE "SIFT_VERSION[[:space:]]*=[[:space:]]*['\"][^'\"]+['\"]" "$src" \
       | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"

if [ -z "$ver" ]; then
    echo "engine_pin: could not parse SIFT_VERSION from $src" >&2
    exit 1
fi

printf '%s\n' "$ver"
