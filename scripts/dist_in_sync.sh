#!/usr/bin/env bash
# dist/ is in sync with src/: the committed bundle is what runs.
#
# `runs: main: dist/index.js` — GitHub executes the COMMITTED bundle, not src/. A stale dist
# silently ships old behaviour, so this re-bundles and fails if the committed dist differs. The
# #1 JS-action footgun; this gate kills it.
#
# THERE IS NO EXEMPT CLASS OF src/ EDIT, AND "comments only" IS THE ONE THAT LOOKS EXEMPT.
# esbuild drops comments everywhere EXCEPT in array/object-literal element position, which it
# preserves verbatim into the bundle. Measured 2026-08-12: a citation rewrite in the argument
# array built by `siftArgs()` (src/sift.ts) reached dist/index.js and held main red for five
# consecutive pushes over three days, because a comment-only diff was read as owing no
# repackage. Regenerate and look; never reason about whether a change "counts".
set -euo pipefail
npm run package
if ! git diff --quiet --exit-code dist/; then
  echo "::error::dist/ is stale — run 'npm run package' and commit dist/."
  git --no-pager diff --stat dist/
  exit 1
fi
