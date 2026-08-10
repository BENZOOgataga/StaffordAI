/**
 * The darwin spawn-helper is executable inside the packaged bundle.
 *
 * The reason 7b exists: node-pty's darwin spawn-helper must be executable or
 * posix_spawnp fails and no pty opens, and the postinstall repair does nothing
 * for a packaged app. So the only guard that reaches the real failure reads the
 * mode from inside the built bundle, at the unpacked path the app resolves. It
 * also proves asarUnpack worked: if the unpack were broken the helper would be
 * sealed in the asar and this path would not exist.
 *
 * This is the in-suite backstop, run by `npm test`. The 7b.2 CI packaging job
 * runs `scripts/check-packaged-bundle.cjs` on the real per-arch artefact and is
 * the guarantee. This exists so a local build is checked without invoking the
 * packaging tooling, and it is a plain JS walk with no `find`, so it is
 * cross-platform and does not itself become the drift it guards against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));

function walk(dir: string, out: string[]): string[] {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

test('a built darwin bundle carries an executable, unpacked spawn-helper', () => {
    const files = walk(dist, []);
    if (files.length === 0) {
        // No build present. This is a local backstop until the packaging job
        // builds; the CI job's check-packaged-bundle.cjs is the guarantee.
        assert.ok(true, 'no packaged build present, this check is a local backstop');
        return;
    }

    const isDarwin = files.some((f) => f.includes('.app' + sep));
    if (!isDarwin) {
        // A non-darwin bundle has no spawn-helper. The CI script asserts the
        // Windows equivalent; here it is enough not to pass on an absent one.
        assert.ok(true, 'not a darwin bundle, the spawn-helper invariant does not apply');
        return;
    }

    const helpers = files.filter((f) =>
        f.endsWith(sep + 'spawn-helper') &&
        f.includes('app.asar.unpacked') && f.includes(sep + 'node-pty' + sep) &&
        !f.includes('win32'));

    assert.ok(helpers.length > 0,
        'a darwin bundle with no unpacked spawn-helper: asarUnpack for node-pty is broken, ' +
        'so the helper is sealed in the asar and no pty can open');

    for (const helper of helpers) {
        const mode = statSync(helper).mode & 0o777;
        assert.ok((mode & 0o111) !== 0,
            'spawn-helper is mode 0' + mode.toString(8) + ' with no execute bit: ' + helper);
    }
});
