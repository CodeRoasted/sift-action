#!/usr/bin/env pwsh
# Sift CLI installer for Windows — download + sha256-verify the published windows-x64 binary.
#
#   irm https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm .../install.ps1))) -Version 1.5.5     # a different pinned version
#   & ([scriptblock]::Create((irm .../install.ps1))) -Version latest    # the moving target, ASKED FOR
#   $env:SIFT_INSTALL_DIR = 'C:\tools\sift'; irm .../install.ps1 | iex  # choose where
#
# LATEST IS A CHOICE, NEVER A DEFAULT. With no -Version this installs the PINNED version
# below, so the same one-liner run twice a month apart installs the same bytes. Asking for
# `latest` is spelled out and resolves the newest published engine release at run time.
# This script used to default to latest silently, which made every unattended install
# irreproducible and contradicted the delivery contract (every client version-pinned,
# never "latest").
#
# The Windows mirror of install.sh / resolve-sift.ts: same engine-v<X.Y.Z> release, same sha256-fatal
# check. windows-x64 only. Diff works out of the box; `--explain` works via a BYO OpenAI-compatible
# endpoint (--explain-endpoint / $CODEROAST_LLM_ENDPOINT) — the bundled local-model pull is Linux-only.
# The download is public — no token.
param(
    [string]$Version = $env:SIFT_VERSION
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # Windows PowerShell 5.1 default is too old.

$Repo = 'CodeRoasted/sift-action'   # public — unauthenticated download
$Asset = 'sift-windows-x64.exe'

# The default engine pin. ./bump.sh OWNS this line — derived from the PUBLISHED release set
# (binary + .sha256 both live) exactly as src/sift-version.ts and install.sh are. Never
# hand-edit it to the workspace dev line: an unpublished version 404s at download.
$SiftPinnedVersion = '1.9.5'
function Fail($msg) { Write-Error "sift-install: $msg"; exit 1 }

# 1. platform — only windows-x64 is published today.
if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "only 64-bit Windows (x64) is published today. Use the GitHub Action, or build from source."
}

# 2. version: -Version / $SIFT_VERSION > the baked pin. `latest` is honoured only when ASKED
#    for, never fallen into — the whole point of the pin above (REST API; no extra tooling).
$ver = $Version
if (-not $ver) { $ver = $SiftPinnedVersion }
if ($ver -eq 'latest') {
    Write-Warning "sift-install: resolving 'latest' as requested — this install is NOT reproducible."
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers @{ 'User-Agent' = 'sift-install' }
    $ver = ($releases.tag_name |
        Where-Object { $_ -match '^engine-v(\d+\.\d+\.\d+)$' } |
        ForEach-Object { [version]($_ -replace '^engine-v', '') } |
        Sort-Object -Descending | Select-Object -First 1).ToString()
    if (-not $ver) { Fail "could not resolve the latest engine version — pass one explicitly: ... -Version 1.5.5" }
}
$base = "https://github.com/$Repo/releases/download/engine-v$ver"

# 3. download + sha256-verify (fatal — never install an unverified binary).
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sift-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    $exe = Join-Path $tmp 'sift.exe'
    $shaFile = Join-Path $tmp 'sift.sha256'
    Write-Host "sift-install: downloading $Asset (engine v$ver)…"
    try { Invoke-WebRequest -Uri "$base/$Asset" -OutFile $exe } catch { Fail "download failed: $base/$Asset (does engine-v$ver publish a Windows asset?)" }
    try { Invoke-WebRequest -Uri "$base/$Asset.sha256" -OutFile $shaFile } catch { Fail "download failed: $base/$Asset.sha256" }

    $expected = ((Get-Content $shaFile -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) {
        Fail "sha256 MISMATCH (expected '$expected', got '$actual') — refusing to install."
    }

    # 4. install (chosen dir, else a per-user Programs dir; mirror install.sh's writable-fallback).
    $dir = if ($env:SIFT_INSTALL_DIR) { $env:SIFT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\sift' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $dest = Join-Path $dir 'sift.exe'
    Move-Item -Force $exe $dest
    Write-Host "sift-install: installed engine v$ver -> $dest"

    # PATH hint (user scope) — don't silently mutate the machine PATH.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $dir) {
        Write-Host "sift-install: $dir is not on your PATH. Add it (new shells):"
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"`$([Environment]::GetEnvironmentVariable('Path','User'));$dir`", 'User')"
    }
    & $dest --version 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "sift-install: done — run 'sift --help' to get started." }
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
