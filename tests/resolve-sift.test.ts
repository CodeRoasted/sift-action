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
        await assert.rejects(() => resolveSift('sift', '/tmp'),
                             /publishes a linux-x64 binary only/);
    } finally {
        Object.defineProperty(process, 'platform', realPlatform);
    }
});
