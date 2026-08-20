/**
 * Every dependency with an install script is on a reviewed allowlist.
 *
 * `.npmrc` sets `ignore-scripts`, which is a blunt switch: it stops npm building
 * better-sqlite3 from source (it carries a binding.gyp and sets gypfile:false,
 * which npm ignores, so npm would run node-gyp rebuild and fail without a
 * compiler), but it also silences every other dependency's install and
 * postinstall script, present and future. Silence is exactly what this project
 * distrusts.
 *
 * So this guard turns the silence loud. It reads which dependencies declare an
 * install script from the lockfile and fails if that set drifts from the
 * allowlist below. A new native dependency, or a version bump that adds a
 * postinstall, then cannot land without someone deciding, in review, whether
 * that script mattered and needs re-running explicitly the way the node-pty
 * spawn-helper repair is.
 *
 * Existence, not behaviour: it reads the committed lockfile and cannot pass
 * against the wrong subject.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Dependencies whose install script is knowingly skipped by ignore-scripts.
 * Each is here because its script was reviewed and is either unnecessary at
 * install (the module loads from a bundled prebuild) or re-run explicitly.
 *
 *   node-pty          loads from its bundled prebuild without its install
 *                     script; its darwin spawn-helper repair is run explicitly
 *                     in CI and via `npm run fix:native`.
 *   esbuild, fsevents native tooling deps that ship platform binaries; not
 *                     required to build from source here.
 *   electron-winstaller  Windows installer tooling, only used if packaging an
 *                     NSIS target, which this project does not.
 *
 * better-sqlite3 is deliberately NOT here: npm records it without an install
 * script (its build is npm's implicit node-gyp, not a declared script), so it
 * never appears in this set. It is guarded instead by native-externals and
 * native-prebuilds.
 */
const ALLOWED_INSTALL_SCRIPTS = new Set(['esbuild', 'fsevents', 'electron-winstaller']);

function installScriptDeps(): string[] {
    const lock = JSON.parse(readFileSync(root + 'package-lock.json', 'utf8')) as {
        packages?: Record<string, { hasInstallScript?: boolean }>;
    };
    const names = new Set<string>();
    for (const [key, value] of Object.entries(lock.packages ?? {})) {
        if (!value.hasInstallScript) continue;
        if (key === '') continue; // the root package itself
        const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (name) names.add(name);
    }
    return [...names].sort();
}

test('every dependency with an install script is on the reviewed allowlist', () => {
    const found = installScriptDeps();
    const unexpected = found.filter((n) => !ALLOWED_INSTALL_SCRIPTS.has(n));
    assert.deepEqual(
        unexpected, [],
        'a dependency declares an install script that .npmrc ignore-scripts now silences: ' +
        unexpected.join(', ') + '. Decide in review whether that script matters. If it must run, ' +
        'wire it as an explicit step the way scripts/fix-node-pty-permissions.cjs is, then add it ' +
        'to ALLOWED_INSTALL_SCRIPTS with the reason.'
    );
});

test('ignore-scripts is set, which is the premise this guard exists for', () => {
    const npmrc = readFileSync(root + '.npmrc', 'utf8');
    assert.match(npmrc, /^ignore-scripts\s*=\s*true\s*$/m,
        'this guard only matters while ignore-scripts is on; if it is removed, install scripts run ' +
        'again and the silence this guards against is gone');
});
