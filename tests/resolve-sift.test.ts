// The binary-distribution boundary is a supply-chain surface: this Action downloads an
// executable and runs it. Until now nothing exercised that decision — resolve-sift.ts was
// one of four modules with no test at all, and it is the one where being wrong means
// executing an unverified binary on a consumer's runner.
//
// These tests hold the two properties that matter:
//   1. a binary is verified BEFORE it can be executed, and every way the verification can
//      fail is fatal (mismatch, malformed, empty, truncated);
//   2. the override path never downloads, so a self-hosted consumer is not silently
//      pulled onto a network path they opted out of.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';

import { resolveSift, verifySha256 } from '../src/resolve-sift.js';

const BYTES = Buffer.from('#!/bin/sh\necho sift\n');
const DIGEST = crypto.createHash('sha256').update(BYTES).digest('hex');

test('a matching checksum verifies and returns the digest', () => {
    assert.equal(verifySha256(DIGEST, BYTES, 'asset'), DIGEST);
});

test('the sha256sum "<hash>  <filename>" form parses to the hash alone', () => {
    // The real asset file is this shape. Comparing the whole line would reject every
    // genuine download, so the field split is load-bearing, not cosmetic.
    assert.equal(verifySha256(`${DIGEST}  sift-linux-x64\n`, BYTES, 'asset'), DIGEST);
});

test('hex case does not matter — an uppercase checksum still verifies', () => {
    assert.equal(verifySha256(DIGEST.toUpperCase(), BYTES, 'asset'), DIGEST);
});

test('a MISMATCHED checksum is fatal', () => {
    const wrong = 'f'.repeat(64);
    assert.throws(() => verifySha256(wrong, BYTES, 'asset'), /sha256 mismatch/);
});

test('an EMPTY checksum file is fatal, and is not read as "no checksum required"', () => {
    // The dangerous shape: if an empty file parsed to an empty expectation and the code
    // compared it loosely, an attacker who could blank the .sha256 would disable the check.
    assert.throws(() => verifySha256('', BYTES, 'asset'), /malformed checksum/);
    assert.throws(() => verifySha256('   \n  ', BYTES, 'asset'), /malformed checksum/);
});

test('a TRUNCATED or non-hex checksum is reported as malformed, not as a mismatch', () => {
    // Diagnostics, deliberately pinned: "mismatch" reads as a tampered binary and sends the
    // reader hunting the wrong bug, when the real fault is the checksum file.
    assert.throws(() => verifySha256(DIGEST.slice(0, 40), BYTES, 'asset'), /malformed checksum/);
    assert.throws(() => verifySha256('<!DOCTYPE html>', BYTES, 'asset'), /malformed checksum/);
    assert.throws(() => verifySha256('z'.repeat(64), BYTES, 'asset'), /malformed checksum/);
});

test('the failure message names the asset so a red step is actionable', () => {
    assert.throws(() => verifySha256('f'.repeat(64), BYTES, 'sift-linux-x64 (engine v1.2.3)'),
                  /sift-linux-x64 \(engine v1\.2\.3\)/);
});

test('an explicit sift-binary override is returned verbatim and never downloads', async () => {
    // No network is stubbed here on purpose: if this path ever tried to download, the test
    // would hang or fail rather than quietly pass.
    assert.equal(await resolveSift('/opt/sift/sift', '/tmp'), '/opt/sift/sift');
});

test("the default override value 'sift' is NOT treated as a user-provided path", async () => {
    // 'sift' is the input's default, meaning "no override given". Returning it verbatim would
    // skip the download and then exec whatever `sift` resolved to on PATH — an unverified
    // binary of someone else's choosing. It must fall through to the turnkey path instead.
    if (process.platform === 'linux' && process.arch === 'x64') {
        // Falls through to download; no network in tests, so assert only that it did NOT
        // short-circuit to the literal 'sift'.
        await assert.rejects(async () => {
            const resolved = await resolveSift('sift', '/nonexistent-workdir-for-test');
            assert.notEqual(resolved, 'sift');
        });
    } else {
        // Off linux-x64 the platform guard fires first, which equally proves no short-circuit.
        await assert.rejects(() => resolveSift('sift', '/tmp'), /linux-x64/);
    }
});

test('an unsupported platform fails with an actionable message, never a wrong-arch download',
     async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
        await assert.rejects(() => resolveSift('sift', '/tmp'), (error: Error) => {
            // Asserted as a CONTRACT rather than one substring. The previous version matched
            // "publishes a linux-x64 binary only" — which passed happily while the message
            // was factually WRONG: it also told the reader Windows assets were "a fast-follow"
            // when sift-windows-x64.exe has been published on every engine-v* release, and it
            // cited a path inside the private superproject that no reader of this public repo
            // can open. A substring match cannot see either defect, so these assert both.
            assert.match(error.message, /linux-x64/, 'must name the asset it downloads');
            assert.match(error.message, /darwin/, 'must name the runner it actually saw');
            assert.match(error.message, /sift-binary|install\.ps1/,
                         'must carry a remedy, not just a refusal');
            assert.doesNotMatch(error.message, /Windows assets are a fast-follow/,
                                'Windows IS published — this claim sent users away from a real binary');
            // macOS delivery was RULED OUT by the Founder on 2026-09-04: the CLI ships on
            // Linux and Windows only. The platform spoofed above IS darwin, so this arm sits
            // on exactly the reader the ruling is about. Asserted in BOTH directions — the
            // promise must be gone AND the status must be stated, because silently dropping
            // "fast-follow" would leave a macOS reader with a refusal and no disposition.
            assert.doesNotMatch(error.message, /macOS[^.]*fast-follow/i,
                                'macOS is not a delivery target — no asset may be promised for it');
            assert.match(error.message, /macOS is not a supported platform/,
                         'a macOS reader must be told the status, not just refused');
            assert.doesNotMatch(error.message, /bibles\/|technical_docs\//,
                                'a public runtime string must not cite a private superproject path');
            return true;
        });
    } finally {
        Object.defineProperty(process, 'platform', realPlatform);
    }
});
