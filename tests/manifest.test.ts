// The manifest's SHIPPED defaults — `action.yml` is what a consumer actually gets.
//
// `core.getInput` reads the value GitHub resolved from the manifest, so for every
// real Action run the default in `action.yml` IS the default; the fallback literal
// in `src/main.ts` only governs an invocation that bypasses the manifest entirely.
// That is why these arms read the manifest and not the source: a default that
// silently came back on would do so for consumers here, and nowhere else.
//
// Scope, deliberately: only defaults the Founder RULED, whose reversal is a product
// change rather than a tuning. The manifest's structural health — chiefly the
// `${{ }}`-in-a-description defect that aborts the action at load for every consumer
// — is already gated workspace-wide by `scripts/action_manifest_lint.py`, and is not
// re-asserted here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(__dirname, '..', '..', 'action.yml');

interface Manifest {
    inputs: Record<string, { default?: string; description?: string }>;
}

function manifest(): Manifest {
    return yaml.load(readFileSync(MANIFEST, 'utf8')) as Manifest;
}

function defaultOf(name: string): string {
    const input = manifest().inputs[name];
    assert.ok(input, `action.yml declares no \`${name}\` input`);
    assert.ok(
        typeof input.default === 'string',
        `\`${name}\` has no default — an unset input then arrives as '' and the behaviour ` +
            'is decided by a fallback literal no consumer can read',
    );
    return input.default as string;
}

test('annotations ship OFF: the manifest default is `never`', () => {
    // Three renderings of one result is two too many — the PR comment and the job
    // summary already carry it, and an annotation competes with the compiler's own in
    // the gutter where a real build error must stay findable. This is a DEFAULT change,
    // not a capability removal: `annotations: significant` restores the whole surface,
    // and the level ladder itself is covered in annotations.test.ts.
    assert.equal(
        defaultOf('annotations'),
        'never',
        'inline annotations came back on by default — every consumer of @v1 gets a third ' +
            'rendering of the same result, in the gutter reserved for build errors',
    );
});

test('the staleness bound ships at 72h — configurable, and it is the only value it may ship at', () => {
    // A bound the consumer never set is the one that has to be honest about a cadence
    // we cannot know. 72h flags a red streak on a near-daily trunk while tolerating a
    // weekend; a repo that ships weekly raises it. Empty would make the degrade silent
    // again, which is the failure this input exists to close.
    const shipped = defaultOf('baseline-max-age');
    assert.equal(
        shipped,
        '72h',
        `baseline-max-age ships at "${shipped}" — 72h is the ruled shipped default`,
    );
});
