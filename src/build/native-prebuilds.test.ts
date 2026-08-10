/**
 * Every native dependency ships a prebuilt binary for every arch the build
 * targets, because npmRebuild is off.
 *
 * Packaging sets `npmRebuild: false`, so electron-builder does not rebuild
 * native modules from source. That is correct only while every native
 * dependency is Node-API and ships a prebuild for every target arch. The
 * failure mode if that premise breaks is the worst kind here: the build
 * succeeds, the bundle ships, and the module fails to load at runtime on a
 * user's machine. A comment in the config does not hold that; this does.
 *
 * The check is existence, not behaviour: for each native external and each arch
 * the build targets, a prebuild directory with a `.node` binary must exist. It
 * fails loudly and cannot pass against the wrong subject. It fails if a native
 * dependency is added without a prebuild for a target arch, and it fails if an
 * arch is added to the build config with no matching prebuild, because the
 * target arches are read from `electron-builder.yml` rather than restated.
 *
 * Fully checkable from any machine: node-pty bundles the prebuilds for every
 * platform and arch under `prebuilds/`, so a darwin checkout carries the win32
 * prebuilds too. The CI packaging legs prove the prebuilt binary actually works
 * once packaged; this proves it exists to be packaged.
 *
 * Two prebuild layouts, because the two native deps ship differently and the
 * guard must accept both without loosening into a check that passes on nothing:
 *   - node-pty:       a directory per arch, `prebuilds/<os>-<arch>/<name>.node`.
 *   - better-sqlite3: a flat file per arch, `prebuilds/<os>-<arch>.node`.
 * A prebuild counts only if one of those two exists with a real `.node` binary.
 * Neither present is a miss, and a miss still fails the run, proven by a red case
 * in the task that added the flat layout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NATIVE_EXTERNALS } from './native-externals.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** electron-builder platform key to node prebuild os name. */
const PLATFORM_OS: Record<string, string> = { mac: 'darwin', win: 'win32', linux: 'linux' };

/**
 * The arches the build targets, read from electron-builder.yml rather than
 * restated, so adding an arch there is caught here. A small hand parser for the
 * fixed structure: a top-level `mac:`/`win:` key, an `arch:` list under it.
 */
function targetArches(): { os: string; arch: string }[] {
    const lines = readFileSync(root + 'electron-builder.yml', 'utf8').split('\n');
    const out: { os: string; arch: string }[] = [];
    let currentOs: string | null = null;
    let inArch = false;

    for (const line of lines) {
        const topLevel = /^([a-z]+):\s*$/.exec(line);
        if (topLevel) {
            currentOs = PLATFORM_OS[topLevel[1] as string] ?? null;
            inArch = false;
            continue;
        }
        if (currentOs && /^\s+arch:\s*$/.test(line)) { inArch = true; continue; }
        if (inArch) {
            const item = /^\s+-\s+([A-Za-z0-9_]+)\s*$/.exec(line);
            if (item) { out.push({ os: currentOs as string, arch: item[1] as string }); continue; }
            // A non-list line ends the arch block.
            if (/^\s+\S/.test(line) && !/^\s+-/.test(line)) inArch = false;
        }
    }
    return out;
}

test('npmRebuild is off, which is the premise this guard exists for', () => {
    const config = readFileSync(root + 'electron-builder.yml', 'utf8');
    assert.match(config, /^npmRebuild:\s*false\s*$/m,
        'this guard only matters while npmRebuild is off; if it is on, native modules are rebuilt ' +
        'and the prebuild premise no longer holds');
});

test('the build targets at least one arch, read from the config', () => {
    const arches = targetArches();
    assert.ok(arches.length > 0, 'no target arches parsed from electron-builder.yml; the parser or the config changed');
});

test('every native dependency has a prebuild for every arch the build targets', () => {
    const arches = targetArches();
    const checked: string[] = [];

    for (const dep of NATIVE_EXTERNALS) {
        for (const { os, arch } of arches) {
            const base = root + 'node_modules/' + dep + '/prebuilds/' + os + '-' + arch;

            // node-pty's directory layout: prebuilds/<os>-<arch>/<name>.node.
            const dirBinaries = existsSync(base)
                ? readdirSync(base).filter((f) => f.endsWith('.node'))
                : [];
            // better-sqlite3's flat layout: prebuilds/<os>-<arch>.node.
            const flatFile = base + '.node';
            const flatExists = existsSync(flatFile);

            const layout = dirBinaries.length > 0
                ? 'dir(' + dirBinaries.length + ')'
                : flatExists ? 'flat' : null;

            assert.ok(
                layout !== null,
                dep + ' has no prebuild for ' + os + '-' + arch + ', in either a ' +
                'prebuilds/' + os + '-' + arch + '/ directory or a flat ' +
                'prebuilds/' + os + '-' + arch + '.node. npmRebuild is off, so there is no ' +
                'from-source fallback: this build would ship a bundle that fails to load at runtime.'
            );
            checked.push(dep + ' ' + os + '-' + arch + ' (' + layout + ')');
        }
    }

    // Loud, so a green run is a run that demonstrably checked something.
    for (const line of checked) console.log('  prebuild ok: ' + line);
    assert.ok(checked.length > 0, 'nothing was checked, which cannot be right');
});
