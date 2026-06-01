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
      - uses: coderoast/sift-action@v1
        with:
          log: build.log
          fail-on: regression                      # advisory gate (none | significant | regression)
          build-status: ${{ steps.build.outcome == 'success' && 'green' || 'red' }}
```

The first green run on the base branch seeds the baseline; every PR gets a diff
automatically thereafter (self-bootstrapping). No prior green run ⇒ an honest
"no baseline yet" comment.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `log` | yes | — | Path to the captured current-run log to diff. |
| `sift-binary` | no | `sift` | Path to the pinned `sift` binary (packaging provides it). |
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
