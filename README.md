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
        run: ./ci/build.sh 2>&1 | tee build.log   # capture the log you want diffed
      - uses: CodeRoasted/sift-action@v1
        with:
          log: build.log
          fail-on: regression                      # advisory gate (none | significant | regression)
          build-status: ${{ steps.build.outcome == 'success' && 'green' || 'red' }}
```

The first green run on the base branch seeds the baseline; every PR gets a diff
automatically thereafter (self-bootstrapping). No prior green run ⇒ an honest
"no baseline yet" comment.

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

PRs from forks get a **read-only** `GITHUB_TOKEN`, so the sticky comment and the
baseline-artifact upload **cannot write**. The Action **does not silently no-op**:
it logs a warning and the **advisory gate still applies** (the diff still runs and
`fail-on` still gates). Posting comments on fork PRs requires `pull_request_target`,
which is **deferred pending a security review** (fork-controlled log content is an
output-injection surface) — see the contract § 6.

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
