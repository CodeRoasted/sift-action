// Binary distribution boundary (Argos lane; sift_action_contract.md §6–7).
//
// The frame logic (sift.ts) shells out to a `sift` binary; THIS module decides how
// that binary reaches the runner. Two paths:
//   1. Override — the `sift-binary` input names a path (self-hosted runner, an
//      in-image build, or a Docker-bundle packaging). Used verbatim, no download.
//   2. Turnkey (default) — download the version-pinned `sift-linux-x64` release
//      asset from insight-eidos and VERIFY its sha256 before exec. The asset is a
//      supply-chain surface (we run it), so a checksum mismatch is fatal — never
//      run an unverified binary.
//
// v1 platform scope = linux x64 (GitHub-hosted runners are overwhelmingly
// ubuntu-latest). On any other platform we fail with an actionable message rather
// than download a wrong-arch binary — arm/macOS/Windows assets are a fast-follow.

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import { SIFT_VERSION } from './sift-version';

const RELEASE_REPO = 'CodeRoasted/insight-eidos';
const ASSET = 'sift-linux-x64';

async function download(url: string, dest: string): Promise<void> {
    // curl is present on all GitHub-hosted runners; -f fails the step on a 4xx/5xx
    // (a missing asset must error loudly, not write an HTML error page to the file).
    const code = await exec.exec('curl', ['-fsSL', url, '-o', dest], { ignoreReturnCode: true });
    if (code !== 0) {
        throw new Error(`Sift: failed to download ${url} (curl exit ${code}).`);
    }
}

export async function resolveSift(override: string, workDir: string): Promise<string> {
    if (override && override !== 'sift') {
        core.info(`Sift: using provided binary '${override}' (download skipped).`);
        return override;
    }

    if (process.platform !== 'linux' || process.arch !== 'x64') {
        throw new Error(
            `Sift v1 publishes a linux-x64 binary only; this runner is ` +
                `${process.platform}/${process.arch}. Run the Sift step on a linux x64 ` +
                `runner, or set 'sift-binary:' to a path you provide. ` +
                `(arm/macOS/Windows assets are a fast-follow — sift_action_contract.md §7.)`,
        );
    }

    const base = `https://github.com/${RELEASE_REPO}/releases/download/v${SIFT_VERSION}`;
    const bin = path.join(workDir, 'sift');
    const shaFile = path.join(workDir, 'sift.sha256');

    await download(`${base}/${ASSET}`, bin);
    await download(`${base}/${ASSET}.sha256`, shaFile);

    const expected = (await fs.readFile(shaFile, 'utf8')).trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(await fs.readFile(bin)).digest('hex');
    if (!expected || expected !== actual) {
        throw new Error(
            `Sift: sha256 mismatch for ${ASSET} v${SIFT_VERSION} — refusing to run an ` +
                `unverified binary (expected '${expected}', got '${actual}').`,
        );
    }

    await fs.chmod(bin, 0o755);
    core.info(`Sift: downloaded + sha256-verified ${ASSET} v${SIFT_VERSION}.`);
    return bin;
}
