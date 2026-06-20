#!/usr/bin/env pwsh
# Sift CLI installer for Windows — download + sha256-verify the published windows-x64 binary.
#
#   irm https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/CodeRoasted/sift-action/main/install.ps1))) -Version 1.5.5   # pin
#   $env:SIFT_INSTALL_DIR = 'C:\tools\sift'; irm .../install.ps1 | iex                                                          # choose where
#
# The Windows mirror of install.sh / resolve-sift.ts: same engine-v<X.Y.Z> release, same sha256-fatal
# check. windows-x64 only. Diff works out of the box; `--explain` works via a BYO OpenAI-compatible
# endpoint (--explain-endpoint / $INSIGHT_LLM_ENDPOINT) — the bundled local-model pull is Linux-only.
# The download is public — no token.
param(
    [string]$Version = $env:SIFT_VERSION
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # Windows PowerShell 5.1 default is too old.

$Repo = 'CodeRoasted/sift-action'   # public — unauthenticated download
$Asset = 'sift-windows-x64.exe'
function Fail($msg) { Write-Error "sift-install: $msg"; exit 1 }

# 1. platform — only windows-x64 is published today.
if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "only 64-bit Windows (x64) is published today. Use the GitHub Action, or build from source."
}

# 2. version: -Version / $SIFT_VERSION > latest engine-v* release (REST API; no extra tooling).
$ver = $Version
if (-not $ver) {
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
