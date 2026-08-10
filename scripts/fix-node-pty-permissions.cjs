/**
 * Makes node-pty's darwin `spawn-helper` executable after install.
 *
 * node-pty 1.1.0 publishes `prebuilds/darwin-arm64/spawn-helper` and
 * `prebuilds/darwin-x64/spawn-helper` with mode 0644. `UnixTerminal` builds
 * `helperPath` from the loaded native module's directory and hands it to
 * `posix_spawnp`, which needs the execute bit. Without it every `pty.spawn`
 * on macOS throws `Error: posix_spawnp failed.` and no pseudo-terminal ever
 * opens.
 *
 * Measured on 2026-08-08, macOS 26.5.2 arm64, node-pty 1.1.0 installed by
 * `npm ci`. The mode comes from the published tarball rather than from npm's
 * extraction: `tar -tvf` on the registry artifact shows `-rw-r--r--`, and a
 * plain `tar -xzf` outside npm reproduces it. Raw output in
 * `docs/stack-migration-verification.md`, MacBook section.
 *
 * This is not widely reported because `loadNativeModule` checks
 * `build/Release` before `prebuilds/`, so anyone compiling from source gets an
 * executable helper from node-gyp and never reaches the packaged one. Darwin
 * prebuilds are new in 1.1.0.
 *
 * REMOVAL CONDITION, confirmed upstream rather than inferred.
 *
 * Reported as `microsoft/node-pty#850`. A node-pty contributor replied within a
 * minute: 1.1.0 is broken, the fix shipped in **v1.2.0-beta.2**, and there is no
 * stable release carrying it. He considers the beta stable in all but name.
 *
 * So this is a workaround with a documented exit rather than an open-ended one.
 * Delete this script and its `postinstall` entry when the pinned node-pty
 * version is at or past v1.2.0-beta.2, and let
 * `node-pty ships a spawn-helper macOS can execute` be what tells you it is
 * safe rather than a version number in a comment.
 *
 * Moving the pin is its own decision and has not been taken. The case for it is
 * that it removes this script entirely and a contributor calls the beta stable.
 * The case against is that the pin is exact and deliberate, a beta on a native
 * module whose internals this project already reaches into is a real risk, and
 * the current arrangement works and is tested in both directions. Whether the
 * beta still exposes `_agent.inSocket` is unmeasured, and
 * `node-pty still exposes the internals the leak fix reaches through` exists
 * precisely because a rename there is silent.
 *
 * CommonJS on purpose, and `.cjs` on purpose: it must keep working across the
 * root flip to `type: module` without joining the sweep list.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE_PTY = path.join(ROOT, 'node_modules', 'node-pty');

/**
 * Every darwin helper present, not only the one this machine would load.
 *
 * `loadNativeModule` checks `build/Release` before `prebuilds/`, so a source
 * build populates the first and a prebuild install the second, and
 * `npm_config_build_from_source` deletes the prebuilds directory outright.
 *
 * Both darwin arches are repaired rather than just `process.arch`, because
 * packaging is where the other one matters. Measured 2026-08-08: asar carries
 * file modes through pack and unpack faithfully, so whatever mode the tree has
 * at package time is the mode the shipped app has. A universal or cross-arch
 * build made on this machine would otherwise ship a working arm64 helper next
 * to a `darwin-x64` one still at 0644, and it would fail for exactly the users
 * who cannot reproduce it here.
 */
const CANDIDATES = [path.join(NODE_PTY, 'build', 'Release', 'spawn-helper')];

const PREBUILDS = path.join(NODE_PTY, 'prebuilds');
if (fs.existsSync(PREBUILDS)) {
    for (const entry of fs.readdirSync(PREBUILDS)) {
        if (entry.startsWith('darwin-')) {
            CANDIDATES.push(path.join(PREBUILDS, entry, 'spawn-helper'));
        }
    }
}

function fail(message) {
    console.error('node-pty spawn-helper: ' + message);
    process.exit(1);
}

if (process.platform !== 'darwin') {
    console.log('node-pty spawn-helper: SKIPPED, not darwin');
    process.exit(0);
}

if (!fs.existsSync(NODE_PTY)) {
    fail('ANCHOR NOT FOUND, node-pty is not installed at ' + NODE_PTY);
}

const present = CANDIDATES.filter((candidate) => fs.existsSync(candidate));

/**
 * An anchor that matched nothing is an error, never a silent no-op. If neither
 * location has a helper then node-pty's layout has changed and this script is
 * quietly protecting nothing, which is the failure mode worth being loud about.
 */
if (present.length === 0) {
    fail(
        'ANCHOR NOT FOUND, no spawn-helper at any known location. Checked:\n  ' +
        CANDIDATES.join('\n  ') +
        '\nnode-pty\'s layout has changed, so this script no longer guards anything.'
    );
}

const EXECUTABLE = 0o111;
let changed = 0;

for (const helper of present) {
    const before = fs.statSync(helper).mode & 0o777;
    if (before & EXECUTABLE) {
        console.log('node-pty spawn-helper: already executable, ' + before.toString(8) + ', ' + helper);
        continue;
    }

    fs.chmodSync(helper, 0o755);

    // Read the result back rather than trusting the call. A chmod that did not
    // take leaves the same broken install as no chmod at all.
    const after = fs.statSync(helper).mode & 0o777;
    if (!(after & EXECUTABLE)) {
        fail('chmod did not take on ' + helper + ', mode is still ' + after.toString(8));
    }

    changed += 1;
    console.log(
        'node-pty spawn-helper: ' + before.toString(8) + ' -> ' + after.toString(8) + ', ' + helper
    );
}

if (changed === 0) {
    console.log('node-pty spawn-helper: nothing to do, node-pty may have shipped the fix');
}

process.exit(0);
