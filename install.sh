#!/usr/bin/env sh
# Tamys CLI installer — download + sha256-verify the published linux-x64 binary, no GitHub Actions needed.
#
#   curl -fsSL https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- 1.4.2      # a different pinned version
#   curl -fsSL .../install.sh | sh -s -- latest     # the moving target, ASKED FOR
#   TAMYS_INSTALL_DIR="$HOME/bin" curl -fsSL .../install.sh | sh   # choose where
#
# LATEST IS A CHOICE, NEVER A DEFAULT. With no argument this installs the PINNED version
# below, so the same one-liner run twice a month apart installs the same bytes. Asking for
# `latest` is spelled out and resolves the newest published engine release at run time.
# This script used to default to latest silently, which made every unattended install
# irreproducible and contradicted the delivery contract (every client version-pinned,
# never "latest").
#
# Mirrors the GitHub Action's resolve-tamys.ts exactly: same engine-v<X.Y.Z> release, same asset,
# same sha256-fatal check. linux-x64 only here (arm is a fast-follow; macOS is not a delivery
# target -- Linux and Windows are the shipped platforms); refuses anything else
# rather than install a wrong-arch binary. The download is public — no token needed.
set -eu

REPO="CodeRoasted/sift-action"
# The asset is named by the release it comes from (DN-155.D11): every engine release up to
# 1.10.11 published `sift-linux-x64`, and each from TAMYS_FIRST_ASSET_VERSION on publishes
# `tamys-linux-x64`. A version passed by hand may be older than the pin, so the name is read
# off the version being installed, never off the pin; no published asset is renamed or copied.
TAMYS_FIRST_ASSET_VERSION="1.10.12"

# The default engine pin. ./bump.sh OWNS this line — it is derived from the PUBLISHED
# release set (the binary and its .sha256 must both be live before bump.sh will write it),
# exactly as src/tamys-version.ts is. Never hand-edit it to the workspace dev line: an
# unpublished version 404s every consumer at download.
TAMYS_PINNED_VERSION="1.10.11"
err() { echo "tamys-install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "missing required tool: $1"; }
need curl; need sha256sum; need awk

# 1. platform — only linux-x64 is published today.
os="$(uname -s 2>/dev/null || echo unknown)"
arch="$(uname -m 2>/dev/null || echo unknown)"
[ "$os" = "Linux" ] || err "this installer publishes linux-x64 only (got '$os'). On Windows use install.ps1, which installs the published Windows binary. macOS is not a supported platform."
case "$arch" in
    x86_64 | amd64) ;;
    *) err "only x86_64 is published today (got '$arch')." ;;
esac

# 2. version: arg > $TAMYS_VERSION > the baked pin. `latest` is honoured only when ASKED for,
#    never fallen into — the whole point of the pin above (no jq dependency).
ver="${1:-${TAMYS_VERSION:-$TAMYS_PINNED_VERSION}}"
if [ "$ver" = "latest" ]; then
    echo "tamys-install: resolving 'latest' as requested — this install is NOT reproducible." >&2
    ver="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" 2>/dev/null \
        | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"engine-v[0-9]+\.[0-9]+\.[0-9]+"' \
        | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1)"
    [ -n "$ver" ] || err "could not resolve the latest engine version — pass one explicitly: ... | sh -s -- 1.4.2"
fi
[ -n "$ver" ] || err "no version to install: the baked pin is empty and none was given."
if [ "$(printf '%s\n%s\n' "$TAMYS_FIRST_ASSET_VERSION" "$ver" | sort -V | head -n 1)" = "$TAMYS_FIRST_ASSET_VERSION" ]; then
    ASSET="tamys-linux-x64"
else
    ASSET="sift-linux-x64"
fi
base="https://github.com/$REPO/releases/download/engine-v$ver"

# 3. download + sha256-verify (fatal — never install an unverified binary).
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "tamys-install: downloading $ASSET (engine v$ver)…" >&2
curl -fsSL "$base/$ASSET" -o "$tmp/tamys" || err "download failed: $base/$ASSET (does engine-v$ver exist?)"
curl -fsSL "$base/$ASSET.sha256" -o "$tmp/tamys.sha256" || err "download failed: $base/$ASSET.sha256"
expected="$(awk '{print $1; exit}' "$tmp/tamys.sha256")"
actual="$(sha256sum "$tmp/tamys" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    err "sha256 MISMATCH (expected '$expected', got '$actual') — refusing to install."
fi
chmod +x "$tmp/tamys"

# 4. install (writable system dir if we can, else ~/.local/bin).
dir="${TAMYS_INSTALL_DIR:-/usr/local/bin}"
if [ "$(id -u)" = 0 ] || { [ -d "$dir" ] && [ -w "$dir" ]; }; then
    mv "$tmp/tamys" "$dir/tamys"
else
    dir="$HOME/.local/bin"
    mkdir -p "$dir"
    mv "$tmp/tamys" "$dir/tamys"
fi
echo "tamys-install: installed engine v$ver → $dir/tamys" >&2
case ":${PATH}:" in
    *":$dir:"*) ;;
    *) echo "tamys-install: $dir is not on PATH — add it: export PATH=\"$dir:\$PATH\"" >&2 ;;
esac
# LIVENESS, not version. This line read `"$dir/tamys" --version || echo <friendly>` and the
# friendly branch was taken EVERY time: tamys has no version flag — no `--version`, no `-V`,
# the word does not occur in tamys_cli.cpp. So the one check standing between "sha256 verified"
# and "installed" was a guaranteed failure whose output went to /dev/null, and the installer
# said done without ever executing the binary it had just written. Measured 2026-08-24 on a
# windows-2025 runner through install.ps1's identical probe: `error: unknown option
# '--version'`.
#
# `--help` is a real flag (tamys_cli.cpp handles -h/--help) and it is FATAL here on purpose: an
# installer that verified a digest and then could not run the result has not installed
# anything, and saying "done" would be the lie this line used to tell quietly. stdout is
# discarded — a usage dump is not an install epilogue; the version was already printed above
# from $ver, which is the value that was actually installed.
if ! "$dir/tamys" --help >/dev/null 2>&1; then
    err "installed $dir/tamys but it does not execute (--help failed) — the download verified, the binary does not run."
fi
echo "tamys-install: done — run 'tamys --help' to get started." >&2
