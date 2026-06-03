# Sift Action

Structural diff of your CI logs, on every PR. Sift diffs this run's log against
the **last green run on your base branch** and posts **one sticky comment** —
ranked by what matters, with the noise suppressed — plus an optional advisory
gate. Deterministic; runs entirely in your CI (your logs never leave it).

> Design: [`technical_docs/architecture/sift_action_contract.md`](../technical_docs/architecture/sift_action_contract.md).
> Comment copy: [`technical_docs/product/web_copy.md` § "Surface: Sift PR comment"](../technical_docs/product/web_copy.md).

## Usage

```yaml
permissions:
  contents: read
  actions: write          # upload + read the baseline-log artifact
  pull-requests: write    # post/update the sticky comment

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: build
        run: |
          set -o pipefail                          # `| tee` must not mask the build's real exit code,
                                                   # or build-status below is always (wrongly) green
          ./ci/build.sh 2>&1 | tee build.log       # capture the log you want diffed
      - uses: CodeRoasted/sift-action@v1
        if: ${{ !cancelled() }}                    # still diff + comment when the build went red — that's the point
        with:
          log: build.log
          fail-on: regression                      # advisory gate (none | significant | regression)
          build-status: ${{ steps.build.outcome == 'success' && 'green' || 'red' }}
```

The first green run on the base branch seeds the baseline; every PR gets a diff
automatically thereafter (self-bootstrapping). No prior green run ⇒ an honest
"no baseline yet" comment.

## On a push vs a PR

The trigger decides where the diff goes — Sift works whether you use PRs or push straight to `main`:

- **On a PR** — Sift posts/updates the sticky **comment** on the PR (this run vs the base branch's last green run).
- **On a push** (trunk commit to `main`, no PR) — Sift writes the diff to the run's **job summary**
  (`$GITHUB_STEP_SUMMARY`) instead, since there's no PR to comment on, and re-seeds the baseline
  **green-gated**: a red build still diffs against the prior green but never becomes the baseline.

`fail-on` applies in both cases. On either trigger, the first run on a fresh branch is a cold start
(seed only); every run after gets a structural diff.

## Capturing the log

`log:` just needs a file holding the build/test output you want diffed — capture it
whichever way fits your job. Always with `set -o pipefail` (a bare `… | tee` masks the
build's real exit code, so `build-status` would read green on a red build):

- **One command** (as in Usage above) — pipe it through `tee`:
  ```yaml
  - id: build
    run: |
      set -o pipefail
      make 2>&1 | tee build.log
  ```
- **Several commands in one step** — start capturing once, at the top:
  ```yaml
  - id: build
    run: |
      set -eo pipefail
      exec > >(tee build.log) 2>&1     # everything below this line is captured
      cmake --build build
      ctest --test-dir build
  ```
- **Output spread across several steps** — start an empty file, then append (`tee -a`):
  ```yaml
  - name: Start build-log capture
    run: truncate --size 0 "$GITHUB_WORKSPACE/build.log"
  - run: cmake --build build   2>&1 | tee -a "$GITHUB_WORKSPACE/build.log"
  - run: ctest --test-dir build 2>&1 | tee -a "$GITHUB_WORKSPACE/build.log"
  # … then point Sift at it:  with: { log: build.log }
  ```

## Platform & supply chain

- **Runner:** linux x64 (`ubuntu-latest`) for v1; arm/macOS/Windows are a
  fast-follow. On any other platform the Action fails with an actionable message
  rather than running a wrong-arch binary.
- **Binary distribution:** the Action downloads the **version-pinned**
  `sift-linux-x64` release asset and **verifies its sha256** before executing it —
  a checksum mismatch is fatal (the asset is a supply-chain surface: the Action
  runs it). The pinned version is fixed per Action release. Set `sift-binary:` only
  to override with your own build (self-hosted runner / in-image).

## Fork PRs

By default (one workflow), a fork PR gets a **read-only** token, so the sticky comment
and baseline upload **can't write**. The Action does **not** silently no-op — it warns
and the **advisory gate still applies** (the diff runs, `fail-on` gates). Safe default.

To actually **post comments on fork PRs**, use the two-workflow pattern (the secure
alternative to `pull_request_target`) — see [`examples/fork-safe/`](examples/fork-safe/):

1. **`build.yml`** (`on: pull_request`, **read-only**) builds the PR and runs Sift in
   `mode: render` → uploads the comment body as an artifact. Fork code runs here, but
   the token can't post or touch anything privileged.
2. **`post.yml`** (`on: workflow_run`, **`pull-requests: write`**) downloads that
   artifact and posts the sticky comment — and does **nothing else**.

> ⛔ **Forbidden pattern:** never `actions/checkout` the PR head and build/run it in a
> privileged job (`workflow_run` or `pull_request_target` with write access). That runs
> fork-controlled code with a write token — RCE + secret exfiltration. Build only in the
> unprivileged `pull_request` job; the privileged job consumes only the rendered artifact.

Fork-comment posting (the `render`/`post` modes + this pattern) **arms with contract §6.1**,
gated on the parser's **Fuzz/ASan gate** being green — keep `post.yml` disabled until then.

## Other CI / Jenkins

This Action is a thin adapter over a **CI-agnostic substrate**: the `sift` engine ships as a
**public, unauthenticated, checksummed** release asset — `sift-linux-x64` (+ `.sha256`) on this
repo's releases. Any CI with `curl` + `sha256sum` is just another client. The download URL is
**stable** — only the version tag varies, the asset names are fixed:

```
https://github.com/CodeRoasted/sift-action/releases/download/v<VERSION>/sift-linux-x64
```

**Jenkins** has a ready, **doc-only** Tier-0 recipe: [`examples/jenkins/Jenkinsfile`](examples/jenkins/Jenkinsfile).
It reproduces the Action's advisory-first posture with zero new code — `--fail-on regression` is the
gate; the archived `sift-report.json` + build status are the surface. The baseline is **user-wired**
(last green build's archived log via the Copy Artifact plugin, or a committed known-good log);
base-branch-aware "last green" resolution and a native PR/MR comment are platform-specific Tier-1 work
(see `sift_action_contract.md` § 9). The same curl-verify-run pattern ports to GitLab CI, Buildkite, or
a local shell.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `log` | yes | — | Path to the captured current-run log to diff. |
| `sift-binary` | no | _(auto)_ | Override path to a `sift` binary. Default: download + sha256-verify the version-pinned `sift-linux-x64` release asset. |
| `fail-on` | no | `none` | `none` \| `significant` \| `regression` — advisory gate (exit code only; the comment never says "blocked"). |
| `build-status` | no | `unknown` | `green` \| `red` \| `unknown` — enhancer; drives the green-build headline. |
| `github-token` | no | `${{ github.token }}` | Runs/artifacts API + comment + artifact upload. |

## Architecture

The **engine** (`sift`, C++) owns all content — the ranked rows (`summary`) and
the full report body. The **Action** (this, TS) owns only the *frame* (header,
verdict headline, state selection, footer) and the GitHub transport (sticky
comment, baseline artifact, check status). A bad row is an engine fix at the
root — never re-authored here.

- `src/frame.ts` — the pure, deterministic comment renderer (the governed copy).
- `src/verdict.ts` — the four-state machine (cold-start / clean / drift / regression).
- `src/baseline.ts` — last-green-on-base resolution via the GitHub API.
- `src/sift.ts` — engine invocation (`--format both`, `--fail-on`).
- `src/comment.ts` — sticky-comment upsert. `src/artifact.ts` — baseline publish.
- `src/main.ts` — orchestration.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # builds + runs the frame integration tests (node:test)
npm run package     # ncc bundle → dist/ (packaging; owned by the release lane)
```

> Packaging (final bundling to `dist/`, the `sift` release-asset publish, the home
> repo, token/fork-PR posture) is the DevOps lane — see contract § 6–7.

## License

This Action wrapper is **MIT** (see [LICENSE](LICENSE)) — commodity glue: resolve
the baseline, fetch + verify the binary, run it, render the comment frame.

It downloads and runs the `sift` engine binary at runtime: a version-pinned,
checksum-verified release asset that is **© 2026 Emmanuel Prunet (CodeRoast), proprietary**
(free to run for any purpose incl. commercial; binary only; no redistribution or
reverse-engineering) and **not covered by this repository's MIT license**. The
binary is never vendored here — see [NOTICE](NOTICE). Bundled third-party
dependencies in `dist/` keep their own licenses (`dist/licenses.txt`).

"Sift" and "CodeRoast" are trademarks of Emmanuel Prunet (CodeRoast) — separate from the code license.
