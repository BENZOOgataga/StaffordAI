/**
 * The sandboxed preload is built as CommonJS, and nothing may quietly change it.
 *
 * A sandboxed preload (webPreferences.sandbox true) runs as CommonJS: the
 * sandbox loader has no ESM import. The root is `type: module`, so a `.js` or
 * `.mjs` preload is ESM and the bridge dies at launch with "Cannot use import
 * statement outside a module", with no build error. Found in 7a by launching,
 * not by reading, which is exactly why it needs a guard.
 *
 * Two layers, both existence assertions rather than reasoning about what would
 * fail:
 *  - The config is the source of truth and is always present, so it is checked
 *    every run, including CI, which does not build. The preload must be emitted
 *    as `index.cjs` and main must load `index.cjs`.
 *  - The built artefact is checked when a build exists (a local `npm run build`).
 *    CI does not build, so this half is a local backstop rather than the
 *    guarantee. The config half is the guarantee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the vite config emits the preload as index.cjs', () => {
    const config = readFileSync(root + 'electron.vite.config.ts', 'utf8');
    // The preload block must force CJS and name the artefact .cjs.
    assert.match(config, /formats:\s*\['cjs'\]/, 'the preload must be built in cjs format');
    assert.match(config, /entryFileNames:\s*'index\.cjs'/, 'the preload artefact must be index.cjs');
});

test('main loads the preload as .cjs, never .mjs', () => {
    const main = readFileSync(root + 'src/main/index.ts', 'utf8');
    assert.match(main, /preload\/index\.cjs/, 'main must load the .cjs preload');
    assert.doesNotMatch(main, /preload\/index\.mjs/, 'main must not reference an .mjs preload');
});

test('a built preload is a single .cjs file with no .mjs sibling', () => {
    const dir = root + 'out/preload';
    if (!existsSync(dir)) {
        // CI does not build, so there is nothing to check here. The config
        // tests above are the guarantee; this asserts the real artefact when a
        // build is present locally.
        assert.ok(true, 'no build present, artefact check is a local backstop');
        return;
    }
    const files = readdirSync(dir);
    assert.ok(files.includes('index.cjs'), 'the built preload must be index.cjs');
    assert.equal(files.some((f) => f.endsWith('.mjs')), false, 'no .mjs preload may be emitted');
});
