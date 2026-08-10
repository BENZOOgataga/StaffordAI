/**
 * Checks a packaged bundle's native modules, from inside the built artefact.
 *
 * Run by the 7b.2 packaging CI job after electron-builder produces a bundle, per
 * matrix leg. It is the guard that reads the real thing rather than the source
 * tree, and it is deliberately loud: it prints what it checked and how many, so
 * a green job is a job that demonstrably ran the check rather than one that
 * found nothing and passed.
 *
 * The darwin spawn-helper invariant is the reason 7b exists: node-pty's darwin
 * spawn-helper must be executable inside the bundle or posix_spawnp fails and no
 * pty opens, and the postinstall repair does nothing for a packaged app. That
 * invariant is darwin only. On a Windows bundle there is no darwin helper, so a
 * guard that looked for one and passed would be reading as coverage while
 * proving nothing. Instead this says the invariant is not applicable, and checks
 * the Windows equivalent: node-pty's native .node files are unpacked from the
 * asar, which is the same asarUnpack concern in the form Windows has.
 *
 * CommonJS and cross-platform: no `find`, no shell, a plain recursive walk, so
 * it runs identically on a macOS and a Windows runner.
 *
 * Exit non-zero on any failure, so the CI step fails rather than the log being
 * read by a human.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function walk(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

function fail(message) {
    console.error('  FAIL  ' + message);
    process.exit(1);
}

function main() {
    if (!fs.existsSync(DIST)) {
        fail('no dist/ directory. electron-builder did not produce a bundle.');
    }

    const files = walk(DIST, []);
    const unpacked = files.filter((f) => f.includes('app.asar.unpacked') && f.includes(sep('node-pty')));

    const darwinHelpers = unpacked.filter((f) =>
        path.basename(f) === 'spawn-helper' && !f.includes('win32'));
    const nodeBinaries = unpacked.filter((f) => f.endsWith('.node'));

    // Which kind of bundle is this? By the .app, not by the presence of a
    // spawn-helper. node-pty ships the darwin spawn-helpers in its prebuilds on
    // every platform, so a Windows bundle carries them too, at a mode Windows
    // never sets an execute bit on and never needs, since it never runs them.
    // Keying on the helper would classify a Windows bundle as darwin and then
    // fail on a helper that does not matter there. The .app is the darwin
    // signal; win-unpacked has none.
    const isDarwinBundle = files.some((f) => f.endsWith('.app') || f.includes('.app' + path.sep));

    console.log('packaged bundle check, platform ' + process.platform + ':');
    console.log('  unpacked node-pty files found: ' + unpacked.length);

    if (isDarwinBundle) {
        if (darwinHelpers.length === 0) {
            fail('a darwin bundle with no unpacked spawn-helper. asarUnpack for node-pty is broken, ' +
                'so the helper is sealed in the asar and no pty can open.');
        }
        let checked = 0;
        for (const helper of darwinHelpers) {
            const mode = fs.statSync(helper).mode & 0o777;
            if ((mode & 0o111) === 0) {
                fail('spawn-helper is mode 0' + mode.toString(8) + ' with no execute bit: ' + helper +
                    '. posix_spawnp cannot run it, so every pty spawn fails in the packaged app.');
            }
            console.log('  OK    executable spawn-helper: 0' + mode.toString(8) + '  ' + rel(helper));
            checked += 1;
        }
        console.log('  darwin spawn-helper invariant: checked ' + checked + ' helpers, all executable');
        console.log('PASS  darwin bundle, ' + checked + ' spawn-helpers executable');
        return;
    }

    // Not a darwin bundle. Say so rather than passing on an absent invariant.
    console.log('  darwin spawn-helper invariant: NOT APPLICABLE, this is not a darwin bundle');
    if (nodeBinaries.length === 0) {
        fail('no unpacked node-pty .node files. asarUnpack for node-pty is broken here too, ' +
            'so the native module cannot load from inside the asar.');
    }
    for (const bin of nodeBinaries) console.log('  OK    unpacked native module: ' + rel(bin));
    console.log('  windows equivalent invariant: checked ' + nodeBinaries.length + ' node-pty .node files unpacked');
    console.log('PASS  non-darwin bundle, ' + nodeBinaries.length + ' native modules unpacked');
}

function rel(p) { return path.relative(DIST, p); }
function sep(name) { return path.sep + name + path.sep; }

main();
