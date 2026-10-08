#!/usr/bin/env bash
# The engine pin is PUBLISHED: the pinned engine's binary and its sha256 must both be live.
#
# The Action downloads engine-v<SIFT_VERSION>/sift-linux-x64 at runtime, so a pin naming an
# unpublished release 404s every consumer — and does it silently, because the download sits
# behind continue-on-error (that is how the live @v1 came to pin a long-dead engine-v1.4.2 while
# every run looked green).
#
# This property used to live on the workspace pin-coherence gate as INV-8, which asserted
# `pin <= dev baseline` — a proxy, not the property, and one that still admitted a pin ahead of
# anything actually published. It is checked here instead, against the release list, on this
# repo's own push/tag/PR trigger rather than a workspace gate the Action's own changes never
# fire. bump.sh cannot write an unpublished pin; this is the standing guard against the release
# being deleted or the pin being hand-edited.
set -euo pipefail
# scripts/engine_pin.sh is the ONE parse of the pin, shared with wall-time.yml — which measures
# the engine a user receives, and would silently measure a different binary than this gate
# probes if it re-rolled its own regex.
ver="$(scripts/engine_pin.sh)"
echo "engine pin: $ver"
base="https://github.com/CodeRoasted/sift-action/releases/download/engine-v$ver"
rc=0
for suffix in "" ".sha256"; do
  code="$(curl -sSL -o /dev/null -w '%{http_code}' "$base/sift-linux-x64$suffix" || echo 000)"
  if [ "$code" = "200" ]; then
    echo "  ✓ sift-linux-x64$suffix → $code"
  else
    echo "::error::engine-v$ver/sift-linux-x64$suffix is NOT published (HTTP $code) — consumers would 404 at download. Run ./bump.sh to re-pin to a published engine."
    rc=1
  fi
done
# The Jenkins example is a recipe users copy verbatim; a stale one installs an old engine.
# bump.sh moves both together (this is what INV-8b used to assert).
if [ -f examples/jenkins/Jenkinsfile ]; then
  jver="$(grep -oE "SIFT_VERSION\s*=\s*['\"][0-9.]+['\"]" examples/jenkins/Jenkinsfile \
          | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sed -n 1p || true)"
  if [ "$jver" != "$ver" ]; then
    echo "::error::examples/jenkins/Jenkinsfile pins $jver but the Action pins $ver — run ./bump.sh, which rewrites both."
    rc=1
  else
    echo "  ✓ jenkins example agrees ($jver)"
  fi
fi
exit $rc
