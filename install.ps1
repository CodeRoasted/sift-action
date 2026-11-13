#!/usr/bin/env pwsh
# Tamys CLI installer for Windows — download + sha256-verify the published windows-x64 binary.
#
#   irm https://raw.githubusercontent.com/CodeRoasted/tamys-action/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm .../install.ps1))) -Version 1.5.5     # a different pinned version
#   & ([scriptblock]::Create((irm .../install.ps1))) -Version latest    # the moving target, ASKED FOR
#   $env:TAMYS_INSTALL_DIR = 'C:\tools\tamys'; irm .../install.ps1 | iex  # choose where
#
# LATEST IS A CHOICE, NEVER A DEFAULT. With no -Version this installs the PINNED version
# below, so the same one-liner run twice a month apart installs the same bytes. Asking for
# `latest` is spelled out and resolves the newest published engine release at run time.
# This script used to default to latest silently, which made every unattended install
# irreproducible and contradicted the delivery contract (every client version-pinned,
# never "latest").
#
# The Windows mirror of install.sh / resolve-tamys.ts: same engine-v<X.Y.Z> release, same sha256-fatal
# check. windows-x64 only. Diff works out of the box; `--explain` works via an endpoint you name
# (--explain-endpoint / $CODEROAST_LLM_ENDPOINT) and a model (--explain-model / $CODEROAST_LLM_MODEL).
# The download is public — no token.
param(
    [string]$Version = $env:TAMYS_VERSION
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # Windows PowerShell 5.1 default is too old.

$Repo = 'CodeRoasted/tamys-action'   # public — unauthenticated download
# The asset is named by the release it comes from (DN-155.D11): every engine release up to
# 1.10.11 published `sift-windows-x64.exe`, and each from $TamysFirstAssetVersion on publishes
# `tamys-windows-x64.exe`. A -Version passed by hand may be older than the pin, so the name is
# read off the version being installed, never off the pin; no published asset is renamed or copied.
$TamysFirstAssetVersion = '1.10.12'

# The default engine pin. ./bump.sh OWNS this line — derived from the PUBLISHED release set
# (binary + .sha256 both live) exactly as src/tamys-version.ts and install.sh are. Never
# hand-edit it to the workspace dev line: an unpublished version 404s at download.
$TamysPinnedVersion = '1.10.11'
function Fail($msg) { Write-Error "tamys-install: $msg"; exit 1 }

# 1. platform — only windows-x64 is published today.
if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "only 64-bit Windows (x64) is published today. Use the GitHub Action, or build from source."
}

# 2. version: -Version / $TAMYS_VERSION > the baked pin. `latest` is honoured only when ASKED
#    for, never fallen into — the whole point of the pin above (REST API; no extra tooling).
$ver = $Version
if (-not $ver) { $ver = $TamysPinnedVersion }
if ($ver -eq 'latest') {
    Write-Warning "tamys-install: resolving 'latest' as requested — this install is NOT reproducible."
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers @{ 'User-Agent' = 'tamys-install' }
    $ver = ($releases.tag_name |
        Where-Object { $_ -match '^engine-v(\d+\.\d+\.\d+)$' } |
        ForEach-Object { [version]($_ -replace '^engine-v', '') } |
        Sort-Object -Descending | Select-Object -First 1).ToString()
    if (-not $ver) { Fail "could not resolve the latest engine version — pass one explicitly: ... -Version 1.5.5" }
}
$Asset = if ([version]$ver -ge [version]$TamysFirstAssetVersion) { 'tamys-windows-x64.exe' } else { 'sift-windows-x64.exe' }
$base = "https://github.com/$Repo/releases/download/engine-v$ver"

# 3. download + sha256-verify (fatal — never install an unverified binary).
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tamys-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    $exe = Join-Path $tmp 'tamys.exe'
    $shaFile = Join-Path $tmp 'tamys.sha256'
    Write-Host "tamys-install: downloading $Asset (engine v$ver)…"
    try { Invoke-WebRequest -Uri "$base/$Asset" -OutFile $exe } catch { Fail "download failed: $base/$Asset (does engine-v$ver publish a Windows asset?)" }
    try { Invoke-WebRequest -Uri "$base/$Asset.sha256" -OutFile $shaFile } catch { Fail "download failed: $base/$Asset.sha256" }

    $expected = ((Get-Content $shaFile -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) {
        Fail "sha256 MISMATCH (expected '$expected', got '$actual') — refusing to install."
    }

    # 4. install (chosen dir, else a per-user Programs dir; mirror install.sh's writable-fallback).
    $dir = if ($env:TAMYS_INSTALL_DIR) { $env:TAMYS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\tamys' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $dest = Join-Path $dir 'tamys.exe'
    Move-Item -Force $exe $dest
    Write-Host "tamys-install: installed engine v$ver -> $dest"

    # PATH hint (user scope) — don't silently mutate the machine PATH.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $dir) {
        Write-Host "tamys-install: $dir is not on your PATH. Add it (new shells):"
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"`$([Environment]::GetEnvironmentVariable('Path','User'));$dir`", 'User')"
    }
    # LIVENESS, not version — the Windows half of the same defect install.sh carried. This read
    # `& $dest --version` with the non-zero branch printing the friendly line, and that branch
    # was taken EVERY time: tamys has no version flag at all (no `--version`, no `-V`; the word
    # does not occur in tamys_cli.cpp). Measured on a windows-2025 runner 2026-08-24:
    # `error: unknown option '--version'`. So the installer's only post-write check was a
    # guaranteed failure with its stderr swallowed, and it reported done without once executing
    # the binary it had just sha256-verified.
    #
    # `--help` is a real flag and this is FATAL on purpose: a verified digest that will not run
    # is not an install. Output discarded — a usage dump is not an epilogue, and the version was
    # already printed above from $ver, which is what was actually installed.
    & $dest --help *> $null
    if ($LASTEXITCODE -ne 0) { Fail "installed $dest but it does not execute (--help exited $LASTEXITCODE) — the download verified, the binary does not run." }
    Write-Host "tamys-install: done — run 'tamys --help' to get started."
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
