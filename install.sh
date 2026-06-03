#!/usr/bin/env sh
# Sift CLI installer — download + sha256-verify the published linux-x64 binary, no GitHub Actions needed.
#
#   curl -fsSL https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.sh | sh -s -- 1.4.2   # pin a version
#   SIFT_INSTALL_DIR="$HOME/bin" curl -fsSL .../install.sh | sh                                              # choose where
#
# Mirrors the GitHub Action's resolve-sift.ts exactly: same engine-v<X.Y.Z> release, same asset,
# same sha256-fatal check. linux-x64 only today (arm/macOS are a fast-follow); refuses anything else
# rather than install a wrong-arch binary. The download is public — no token needed.
set -eu

REPO="CodeRoasted/sift-action"
ASSET="sift-linux-x64"
err() { echo "sift-install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "missing required tool: $1"; }
need curl; need sha256sum; need awk

# 1. platform — only linux-x64 is published today.
os="$(uname -s 2>/dev/null || echo unknown)"
arch="$(uname -m 2>/dev/null || echo unknown)"
[ "$os" = "Linux" ] || err "only Linux is published today (got '$os') — use the GitHub Action, or build from source."
case "$arch" in
    x86_64 | amd64) ;;
    *) err "only x86_64 is published today (got '$arch')." ;;
esac

# 2. version: arg > $SIFT_VERSION > latest engine-v* release (no jq dependency).
ver="${1:-${SIFT_VERSION:-}}"
if [ -z "$ver" ]; then
    ver="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" 2>/dev/null \
        | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"engine-v[0-9]+\.[0-9]+\.[0-9]+"' \
        | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1)"
    [ -n "$ver" ] || err "could not resolve the latest engine version — pass one explicitly: ... | sh -s -- 1.4.2"
fi
base="https://github.com/$REPO/releases/download/engine-v$ver"

# 3. download + sha256-verify (fatal — never install an unverified binary).
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "sift-install: downloading $ASSET (engine v$ver)…" >&2
curl -fsSL "$base/$ASSET" -o "$tmp/sift" || err "download failed: $base/$ASSET (does engine-v$ver exist?)"
curl -fsSL "$base/$ASSET.sha256" -o "$tmp/sift.sha256" || err "download failed: $base/$ASSET.sha256"
expected="$(awk '{print $1; exit}' "$tmp/sift.sha256")"
actual="$(sha256sum "$tmp/sift" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    err "sha256 MISMATCH (expected '$expected', got '$actual') — refusing to install."
fi
chmod +x "$tmp/sift"

# 4. install (writable system dir if we can, else ~/.local/bin).
dir="${SIFT_INSTALL_DIR:-/usr/local/bin}"
if [ "$(id -u)" = 0 ] || { [ -d "$dir" ] && [ -w "$dir" ]; }; then
    mv "$tmp/sift" "$dir/sift"
else
    dir="$HOME/.local/bin"
    mkdir -p "$dir"
    mv "$tmp/sift" "$dir/sift"
fi
echo "sift-install: installed engine v$ver → $dir/sift" >&2
case ":${PATH}:" in
    *":$dir:"*) ;;
    *) echo "sift-install: $dir is not on PATH — add it: export PATH=\"$dir:\$PATH\"" >&2 ;;
esac
"$dir/sift" --version 2>/dev/null || echo "sift-install: done — run 'sift --help' to get started." >&2
