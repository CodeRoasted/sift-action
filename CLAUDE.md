# sift-action — the Sift GitHub Action (TypeScript, public, MIT)

The distribution wrapper around the `sift` engine: pulls a job's log off the
GitHub API, diffs against the last green baseline, posts the sticky comment /
annotations / summary, seeds the next baseline. The engine binary is downloaded
pinned and sha256-verified; the Action never builds it.

## Arrival

- `npm run build` (tsc → `lib/`) · `npm test` (tsc + `node --test lib/tests/`)
  · `npm run package` (esbuild → `dist/`).
- Layout: `src/` (TS sources), `tests/`, `action.yml` (the manifest),
  `examples/` (simple, fork-safe, and named-baseline topologies), `dist/` (the
  committed bundle), `install.sh` / `install.ps1` (local CLI install).
- User-facing behavior (inputs, baseline resolution, verdict surfaces) is owned
  by `README.md` + `action.yml` — keep them in lockstep with `src/`.

## Constraints & traps

- `dist/` is what consumers RUN — `uses:` executes the committed bundle. A
  `src/` change is invisible until `npm run package` regenerates `dist/` and it
  lands in the same change.
- The engine pin (`src/sift-version.ts`) is moved ONLY by `bump.sh`, which pins
  to a PUBLISHED engine release — never hand-bump it to the workspace dev line
  (the header of `bump.sh` carries the why).
- `action.yml` description fields must not contain `${{ }}` expressions — they
  abort action load.
- Fork PRs are credential-free by design: the fork-safe render→post
  `workflow_run` pair (`examples/fork-safe/`) is the only sanctioned way to arm
  comments on forks. Never add credentials to the PR-triggered leg.
