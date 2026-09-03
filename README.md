# Sift Action

Structural diff of your CI logs, on every PR. Sift diffs this run's log against
the **last green run on your base branch** and posts **one sticky comment** —
ranked by what matters, with the noise suppressed — plus an optional advisory
gate. Deterministic; runs entirely in your CI (your logs never leave it).

The whole integration:

```yaml
- name: Sift Log Diff
  uses: CodeRoasted/sift-action@v1
  with:
    target-job: build
```

Your build job stays untouched — Sift pulls its log straight off the GitHub API,
forwards the job's own verdict to the engine (four-class: SUCCESS / FAILURE /
UNSTABLE / ABORTED), diffs, comments, and seeds the next baseline. Full hello
world: [`examples/simple/ci.yml`](examples/simple/ci.yml).

## Usage

The step above runs in a small job that `needs:` your build job:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: make ci    # your build — untouched, nothing to capture

  sift:
    needs: build
    if: ${{ !cancelled() }}   # still diff when the build went red — that's the point
    runs-on: ubuntu-latest
    permissions:
      actions: write          # read the build job's log + baselines; upload this run's baseline
      pull-requests: write    # post/update the sticky comment
      contents: read          # read this workflow's `needs:` graph (optional — see below)
    steps:
      - name: Sift Log Diff
        uses: CodeRoasted/sift-action@v1
        with:
          target-job: build
```

The first green run on the base branch seeds the baseline; every PR gets a diff
automatically thereafter (self-bootstrapping). No prior green run ⇒ an honest
"no baseline yet" comment.

With `contents: read`, Sift also reads this workflow's declared `needs:` job
graph and hands it to the engine, so a failure surfacing on a required-check
**aggregator** job is folded into the member job that actually failed instead
of being reported against the aggregator. Optional and fail-soft: without the
permission the diff runs exactly as before — aggregator rows just don't fold
(the run log says so).

## Advanced usage

Every default is overridable — the annotated tour (all knobs optional):

```yaml
- uses: CodeRoasted/sift-action@v1
  with:
    # ── Log sourcing ─────────────────────────────────────────────────────
    target-job: build                # diff a finished job's log (run Sift in a job that `needs:` it)
    capture: ci                      # auto (SIFT_CAPTURE sections if any, else whole log) | off | <name>
    # log: build.log                 # OR a file you captured yourself (tee) — see "Capturing the log"

    # ── Baseline — you are King ──────────────────────────────────────────
    baseline: artifact=sift-baseline-main-ci   # auto | branch=<name> | artifact=<name> | path=<file> | none
    baseline-name: sift-baseline-main-ci       # the artifact name THIS run publishes its log under
    publish-baseline: auto                     # auto (PRs always; pushes/tags verdict-gated) | always | never

    # ── Verdict surfaces (each its own level: never|regression|significant|always) ──
    fail-on: regression              # the advisory gate — exit code only (none | significant | regression)
    pr-comment: always               # sticky PR comment level
    commit-comment: never            # commit comment on push runs (needs contents: write)
    annotations: never               # inline ::error/::warning/::notice on the Checks tab (token-free);
                                     # OFF by default — opt in with `significant`
    baseline-max-age: 7d             # staleness bound on the resolved baseline (default 72h; empty = off)
    comment-tag: vs-main             # namespace for a SECOND sticky comment in the same job
    changed-outcome: auto            # this run's NATIVE verdict token, forwarded verbatim to the engine
                                     # (auto = target-job's own conclusion; else ${{ needs.<job>.result }})

    # ── Extras ───────────────────────────────────────────────────────────
    explain: false                   # opt-in local-model AI narrative (~2.4 GB, fail-soft) — see "Explain"
    # explain-model: <name>          # advanced: override the pinned model
    # sift-binary: /path/to/sift     # self-hosted/in-image override (default: pinned, sha256-verified download)
    github-token: ${{ github.token }}
```

The fork-safe two-workflow topology adds `mode` / `run-id` / `build-workflow`
(the render → post pair) — see [Fork PRs](#fork-prs) and
[`examples/fork-safe/`](examples/fork-safe/). The named-baseline topology
(main lineage + per-PR previous-run diff) is
[`examples/baselines/ci.yml`](examples/baselines/ci.yml).

## On a push vs a PR

Sift works whether you use PRs or push straight to `main`. **The diff is always written to the run's
job summary (`$GITHUB_STEP_SUMMARY`) and to step outputs** — that's the result, retrievable no matter
how you configure comments. Comments are an optional overlay on top, each surface with its own level:

- **PR runs** — `pr-comment` controls the sticky comment: `never` | `regression` | `significant`
  (drift or regression) | **`always`** (default — keeps the green "✅ no change" reassurance).
- **Push runs** (trunk commit to `main`, no PR) — `commit-comment` controls a comment on the pushed
  commit: **`never`** (default — job summary only) | `regression` | `significant` | `always`. Needs
  `contents: write`; upserts per-commit (re-runs don't duplicate). The baseline re-seed is
  **green-gated** (a red build still diffs against the prior green but never becomes the baseline).

Each surface has its **own** level (no shared floor), so you can keep the reassuring PR comment while
staying silent on routine pushes. `fail-on` is a separate axis — it gates the **build** (exit code),
not the comment. The first run on a fresh branch is a cold start (seed only); every run after diffs.

## Choosing the baseline — you are King

By default (`baseline: auto`) Sift diffs against the last green run of **this workflow** on the PR's
base branch (push: the pushed branch; **tag: the repo's default branch** — so a tag build diffs
against `main`'s last green out of the box). Every part of that is overridable:

- **`baseline`** selects the source: `auto` · `branch=<name>` · `artifact=<name>` (a **named
  baseline** — the newest non-expired artifact with that exact name, repo-wide) · `path=<file>`
  (bring your own) · `none` (forced cold start / seed-only).
- **`baseline-name`** names the artifact this run **publishes** its log under (and what
  `auto`/`branch=` look for on the resolved run). Compose per-job / per-PR names with expressions.
- **`publish-baseline`** controls seeding: `auto` (PRs always; pushes/tags green-gated) ·
  `always` · `never`.
- **`baseline-max-age`** bounds the resolved baseline's **staleness** (`72h`, `7d`; **default
  `72h`**, empty disables it). The green-gated re-seed means a long red streak ages the baseline
  without limit — every diff then compares against an ever-older green, silently. An exceeded
  baseline still diffs, posts and seeds (an aged comparison is information) but **announces
  itself**: a stale banner in the comment and a warning annotation. **It is a warning, never a
  failure** — your build cadence is yours, a repo that ships weekly is not misconfigured, and
  `fail-on` stays the only axis that touches the exit code. Raise the bound to match your cadence.
  The age is always in the comment footer and the `baseline-age-hours` output, bound or no bound.
- **`comment-tag`** namespaces the sticky comment, so two diffs in one job (vs `main` **and** vs
  the PR's previous run) each keep their own comment.

Named baselines decouple the diff from "this workflow ran on that branch": a `push`-to-`main` job
seeds `sift-baseline-main-build`; PRs and tag builds resolve it by name from any event. The
canonical topology — main/tag runs diff vs the main baseline and re-seed it; PR runs diff vs main
**and** vs their own previous run — is in
[`examples/baselines/ci.yml`](examples/baselines/ci.yml).

## Inline annotations

Sift can also emit the significant rows as native **check-run annotations** (`::error` / `::warning` /
`::notice`) — they show in the **Checks** tab and the PR "checks were not successful" strip, inline with
the run. **They are OFF by default** (`annotations: never`) — the PR comment and the job summary already
render the same result, and an annotation competes with the compiler's own in the gutter where a real
build error must stay findable. Opt in and the surface is whole: `annotations` takes `never` (default) |
`regression` | `significant` (drift or regression) | `always`. Polarity drives the severity:

- a **regression** row → `::error::`
- a **recovery** (the un-grep-able win) → `::notice::`
- any other significant drift → `::warning::`

They **fire on a green build** too — exactly where GitHub's own "Explain error" is silent (it only fires
on a *red* check). The message is the engine's ranked `summary` + its first evidence line, **verbatim**;
there is **no `file:line` anchor** — Sift diffs *logs*, not source, so it never guesses a source location
(the full report stays in the PR comment + `<details>`). A clean run has no significant rows, so even
`significant` stays quiet on a green, unchanged build.

**Annotations are fork-safe by construction.** They are GitHub *workflow commands* written to stdout —
they need **no write token** — so the unprivileged `mode: render` build job (the `on: pull_request` job
in [`examples/fork-safe/`](examples/fork-safe/)) emits them and they appear on a **fork PR's** checks,
with nothing privileged involved (the `workflow_run` poster is untouched). Engine content is encoded per
GitHub's workflow-command rules before it is emitted, so an attacker-controlled CI log line cannot forge
or break an annotation (`src/annotations.ts`).

## Capturing the log

**The default (`target-job`) needs no capture at all** — Sift downloads the finished
job's log from the GitHub API, timestamps stripped. For precision, bracket the
region(s) you want diffed with capture markers — plain echoed lines in any step:

```yaml
- run: |
    echo "SIFT_CAPTURE ci"     # optional — no markers ⇒ the whole job log
    make ci
    echo "SIFT_CAPTURE_END"
```

`capture:` selects `auto` (marked sections if any, else the whole log) | `off` | a
section name — several named sections (`SIFT_CAPTURE ci`, `SIFT_CAPTURE release`) give
independent diffs/lineages from one job, one Sift step each, each with its own
`baseline-name` (+ `comment-tag`).

**The in-job way** (`log:`) — a file holding the output you want diffed, captured
however fits your job; Sift then runs as a step of the build job itself. Always with
`set -o pipefail` (a bare `… | tee` masks the build's real exit code), and set
`changed-outcome` explicitly (there is no target job to derive it from):

- **One command** — pipe it through `tee`:
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
  # … then point Sift at it:
  #   with: { log: build.log, changed-outcome: "${{ steps.build.outcome }}" }
  ```

## Explain (opt-in AI narrative)

`explain: true` adds a short plain-English story above the deterministic diff. The Action provisions a
**local** model + inference server — a pinned, checksum-verified [Phi-3.5-mini GGUF + a static
`llama.cpp` server](https://huggingface.co/CodeRoasted/sift-explain-model), fetched anonymously (no token, fork-safe)
— and runs it on the runner. **Nothing leaves the runner**, and the narrative is **advisory + fail-soft**:
if anything goes wrong (offline, low memory) you still get the full deterministic report, unchanged, and
the gate is untouched. (Cloud "bring your own key" is a **CLI-only** affordance; the Action never carries
a credential.)

It costs a one-time **~2.4 GB model download** + a few seconds of CPU. Cache it across runs with one
standard step — the engine caches under `~/.cache/coderoast`:

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/coderoast          # the pinned model + server (~2.4 GB)
          key: sift-explain-${{ runner.os }}-v<ENGINE_VERSION>   # bump with the Sift engine version
      - uses: CodeRoasted/sift-action@v1
        with:
          log: build.log
          explain: true
```

Without the cache step it still works — it just re-downloads the model each run. Leave `explain` unset
(the default) for the lean diff-only path; the model is never downloaded unless you opt in.

**Provisioning is time-bounded at 15 minutes.** It runs in your CI, so it is never allowed to stall
there: the download has its own connect and stalled-transfer bounds, and the Action puts a wall-clock
bound around the whole provisioning step on top of them, because a wedged process reports no exit code
and would otherwise burn your minutes silently. Hitting the bound is treated exactly like every other
provisioning failure — a **warning**, never a failed run: you get the full deterministic report and the
same gate, just without the narrative. If you ever see it on a cold run, the cache step above is the fix.

## Platform & supply chain

- **Runner:** linux x64 (`ubuntu-latest`) — **this Action** downloads the linux-x64
  engine asset only, and on any other runner it fails with an actionable message
  rather than running a wrong-arch binary. That is a statement about the Action, not
  about what the engine publishes: **`sift-windows-x64.exe` is published** on every
  `engine-v*` release and `install.ps1` installs it as a standalone CLI (see
  [Other CI / Jenkins](#other-ci--jenkins)). **arm and macOS assets are a fast-follow.**
- **Binary distribution:** the Action downloads the **version-pinned**
  `sift-linux-x64` release asset and **verifies its sha256** before executing it —
  a checksum mismatch is fatal (the asset is a supply-chain surface: the Action
  runs it). The pinned version is fixed per Action release. Set `sift-binary:` only
  to override with your own build (self-hosted runner / in-image).

## Fork PRs

By default (one workflow), a fork PR gets a **read-only** token, so the sticky comment
and baseline upload **can't write**. The Action does **not** silently no-op — it warns,
the **advisory gate still applies** (the diff runs, `fail-on` gates), **and the [inline
annotations](#inline-annotations) still surface if you turned them on** (they are token-free
stdout workflow commands — off by default, `annotations: significant` arms them), so a fork PR
can keep a visible structural signal even without the two-workflow pattern. Safe default.

To actually **post comments on fork PRs**, use the two-workflow pattern (the secure
alternative to `pull_request_target`) — see [`examples/fork-safe/`](examples/fork-safe/):

1. **`build.yml`** (`on: pull_request`, **read-only**) builds the PR and runs Sift in
   `mode: render` → uploads the comment body (stamped with the `pr-comment` verdict) as an
   artifact. Fork code runs here, but the token can't post or touch anything privileged.
2. **`post.yml`** (`on: workflow_run`, **`pull-requests: write`**) downloads that artifact and
   posts the sticky comment **when the stamped verdict clears `pr-comment`** — and does **nothing else**.

> ⛔ **Forbidden pattern:** never `actions/checkout` the PR head and build/run it in a
> privileged job (`workflow_run` or `pull_request_target` with write access). That runs
> fork-controlled code with a write token — RCE + secret exfiltration. Build only in the
> unprivileged `pull_request` job; the privileged job consumes only the rendered artifact.

Fork-comment posting (the `render`/`post` modes + this pattern) is **live** — the parser
runs fork-controlled input only under the unprivileged job, and its fuzz/ASan gate is part
of the engine's release train.

## Other CI / Jenkins

This Action is a thin adapter over a **CI-agnostic substrate**: the `sift` engine ships as
**public, unauthenticated, checksummed** release assets — `sift-linux-x64` and `sift-windows-x64.exe`
(each with a `.sha256`) on this repo's releases. Any CI with `curl` + `sha256sum` is just another client.

**No GitHub Actions? Install the CLI** — one line, downloads + sha256-verifies a **pinned**
binary. With no argument you get the version the installer is pinned to, so the same command
run months apart installs the same bytes; `latest` is available but must be **asked for**:

```sh
# Linux / macOS shell (macOS asset is a fast-follow):
curl -fsSL https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.sh | sh
# a different version:    ...install.sh | sh -s -- <X.Y.Z>
# the moving target:      ...install.sh | sh -s -- latest      # not reproducible, and it says so
# choose the location:    SIFT_INSTALL_DIR="$HOME/bin"  (default: /usr/local/bin, else ~/.local/bin)
```

```powershell
# Windows (PowerShell) — diff + `--explain` via a BYO endpoint (local model pull is Linux-only):
irm https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.ps1 | iex
# a different version: & ([scriptblock]::Create((irm .../install.ps1))) -Version <X.Y.Z>
# the moving target:   & ([scriptblock]::Create((irm .../install.ps1))) -Version latest
# choose location: $env:SIFT_INSTALL_DIR = 'C:\tools\sift'  (default: %LOCALAPPDATA%\Programs\sift)
```

Then `sift <baseline.log> <changed.log>` in any CI or locally. The download URLs are **stable** — only
the version tag varies, the asset names are fixed (the engine binaries ride a distinct `engine-v…` tag):

```
https://github.com/CodeRoasted/sift-action/releases/download/engine-v<VERSION>/sift-linux-x64
https://github.com/CodeRoasted/sift-action/releases/download/engine-v<VERSION>/sift-windows-x64.exe
```

**Jenkins** has a ready, **doc-only** Tier-0 recipe: [`examples/jenkins/Jenkinsfile`](examples/jenkins/Jenkinsfile).
It reproduces the Action's advisory-first posture with zero new code — `--fail-on regression` is the
gate; the archived `sift-report.json` + build status are the surface. The baseline is **user-wired**
(last green build's archived log via the Copy Artifact plugin, or a committed known-good log);
base-branch-aware "last green" resolution and a native PR/MR comment are platform-specific Tier-1 work
(see `bibles/sift_action.md` § 9). The same curl-verify-run pattern ports to GitLab CI, Buildkite, or
a local shell.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `target-job` | no | _(none)_ | Zero-plumbing sourcing: diff the log of this finished job (run Sift in a job that `needs:` it). Wins over `log`. See [Capturing the log](#capturing-the-log). |
| `capture` | no | `auto` | With `target-job`: `auto` (SIFT_CAPTURE sections if any, else whole log) \| `off` \| `<name>` (that section only; absent ⇒ the run fails). |
| `log` | unless `target-job` | — | Path to the captured current-run log to diff. |
| `sift-binary` | no | _(auto)_ | Override path to a `sift` binary. Default: download + sha256-verify the version-pinned `sift-linux-x64` release asset. |
| `fail-on` | no | `none` | `none` \| `significant` \| `regression` — advisory gate (exit code only; the comment never says "blocked"). |
| `explain` | no | `false` | `true` opts into an AI narrative header: the Action provisions a pinned, checksum-verified **local** model + server (no credential, fork-safe — nothing leaves the runner) and adds a short plain-English story. Advisory + fail-soft — never blocks or changes the gate, and provisioning is bounded at 15 minutes so it cannot stall your run. Adds a ~2.4 GB model download (cache it — see [Explain](#explain-opt-in-ai-narrative)) + a few seconds of CPU. |
| `explain-model` | no | _(pinned)_ | Advanced: override the model name passed to `sift --explain`. Leave unset for the auto-provisioned default. |
| `baseline` | no | `auto` | Baseline **selection**: `auto` \| `branch=<name>` \| `artifact=<name>` (named baseline, repo-wide) \| `path=<file>` \| `none`. Malformed values fail the run — never a silent fallback. See [Choosing the baseline](#choosing-the-baseline--you-are-king). |
| `baseline-name` | no | `sift-baseline-log` | Artifact name this run **publishes** its log under (and what `auto`/`branch=` resolvers look for). |
| `publish-baseline` | no | `auto` | `auto` (PRs always seed; pushes/tags verdict-gated: FAILURE/UNSTABLE/ABORTED never re-seeds) \| `always` \| `never`. |
| `baseline-max-age` | no | `72h` | Staleness bound on the resolved baseline (`<n>h` \| `<n>d`; empty disables it). Exceeded ⇒ stale banner + warning annotation, **never a failed step** (still diffs, posts, seeds). Malformed values fail the run. See [Choosing the baseline](#choosing-the-baseline--you-are-king). |
| `comment-tag` | no | _(none)_ | Namespaces the sticky comment (marker + title) so two sift invocations in one job keep separate comments. |
| `changed-outcome` | no | `auto` | This run's **native** CI verdict token, forwarded verbatim to the engine (four-class-aware: UNSTABLE is never folded into FAILURE). `auto` = `target-job`'s own conclusion; set `${{ needs.<job>.result }}` when sourcing via `log:`, else the engine reads the log's console tail / no verdict. |
| `pr-comment` | no | `always` | `never` \| `regression` \| `significant` \| `always` — sticky PR comment at/above this verdict. |
| `commit-comment` | no | `never` | `never` \| `regression` \| `significant` \| `always` — commit comment on push at/above this verdict (needs `contents: write`). |
| `annotations` | no | `never` | `never` \| `regression` \| `significant` \| `always` — inline check-run annotations (`::error`/`::warning`/`::notice`) at/above this verdict. **Off by default**; opt in with `significant`. Fork-safe (stdout workflow commands, no token); fires on green. See [Inline annotations](#inline-annotations). |
| `github-token` | no | `${{ github.token }}` | Runs/artifacts API + comment + artifact upload. |

## Outputs

Set on **every** run, whatever the comment config — branch on them in a later step
(`if: steps.sift.outputs.state == 'regression'`):

| Output | Description |
|---|---|
| `state` | `cold-start` \| `clean` \| `drift` \| `regression` |
| `total-changes` | Total observed deltas (before significance suppression). |
| `significant-changes` | Deltas that cleared the significance floor. |
| `regression` | `true` when a regression was flagged (a regression row **or** a run-verdict regression), else `false`. |
| `baseline-outcome` | The baseline run's engine-resolved verdict: `SUCCESS` \| `FAILURE` \| `UNSTABLE` \| `ABORTED` \| `UNKNOWN`. |
| `changed-outcome` | This run's engine-resolved verdict (same values). |
| `outcome-regressed` | `true` when the run verdict got strictly worse (`Success < Unstable < Failure`; Aborted/Unknown excluded). |
| `baseline-age-hours` | Resolved baseline's age in whole hours; empty when unknown (cold start, `path=` baseline, pre-sidecar artifact) — never 0-for-unknown. |
| `baseline-stale` | `true` when a `baseline-max-age` bound is in force and the resolved baseline exceeds it, else `false`. Advisory — it never fails the step. |
| `report-path` | Path to this run's `report.json` on a stable, cross-step location (empty on cold start). A later step on the **same runner** can narrate it with `sift explain --report <path>` — same content as the comment; no credential. |

## Architecture

The **engine** (`sift`, C++) owns all content — the ranked rows (`summary`) and
the full report body. The **Action** (this, TS) owns only the *frame* (header,
verdict headline, state selection, footer) and the GitHub transport (sticky
comment, baseline artifact, check status). A bad row is an engine fix at the
root — never re-authored here.

- `src/frame.ts` — the pure, deterministic comment renderer (the governed copy). The ranked rows
  are grouped into one **collapsible section per severity**, hottest first (CRITICAL → HIGH →
  MEDIUM → LOW), with the heat badge stated once on the section heading instead of repeated on
  every row; a row keeps only what the heading cannot carry — its `regression` / `recovery`
  direction. The **hottest section opens by default** so the incident is readable at the top of
  the comment; every other section, and the full report, starts collapsed. Grouping is framing:
  no row's text is touched.
- `src/annotations.ts` — the pure check-run annotation builder + the workflow-command encoder (the stdout-surface trust boundary, the `escapeInline` analogue).
- `src/verdict.ts` — the four-state machine (cold-start / clean / drift / regression).
- `src/baseline.ts` — baseline source selection (auto / branch= / artifact= / path= / none) via the GitHub API.
- `src/joblog.ts` — `target-job` log sourcing: job lookup, timestamp strip, SIFT_CAPTURE slicing, the native-conclusion token for `changed-outcome: auto`.
- `src/sift.ts` — engine invocation (`--format both`, `--fail-on`).
- `src/comment.ts` — sticky-comment upsert. `src/artifact.ts` — baseline publish.
- `src/main.ts` — orchestration.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # tsc → lib/ then node --test (ESM)
npm run package     # esbuild ESM bundle → dist/index.js + dist/licenses.txt (esbuild.config.mjs)
```

The Action is **ESM** (`"type": "module"`, `runs: using: node24`): the `@actions`
toolchain (core@3 / github@9 / artifact@6) and octokit@7 are ESM-only, so `dist/index.js`
is an ESM bundle built by esbuild (ncc only emits CJS). `dist/licenses.txt` is regenerated
from the build metafile (the exact bundled set) on every package.

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
