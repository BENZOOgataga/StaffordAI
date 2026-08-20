/**
 * Checks a packaged bundle's native modules, from inside the built artefact.
 *
 * Run by the 7b.2 packaging CI job after electron-builder produces a bundle, per
 * matrix leg. It is the guard that reads the real thing rather than the source
 * tree, and it is deliberately loud: it prints what it checked and how many, so
 * a green job is a job that demonstrably ran the check rather than one that
 * found nothing and passed.
 *
 * The invariants it checks: better-sqlite3's native .node binary is unpacked from
 * the asar (or the database module cannot load in the packaged app), every
 * migration .sql survives into the asar at the runtime path openDatabase resolves,
 * and Stafford.exe ships unsigned (no local or work cert identity in a public build).
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

/**
 * The size of a PE file's embedded Authenticode signature, in bytes, or 0 when it
 * carries none. Reads the certificate table entry (data directory index 4) from the
 * PE optional header. null when the file is not a PE we can parse. The header is in
 * the first few KB, so it reads a slice rather than the whole (large) exe.
 */
function peSignatureSize(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(8192);
        fs.readSync(fd, buf, 0, 8192, 0);
        if (buf.readUInt16LE(0) !== 0x5A4D) return null;          // 'MZ'
        const peOff = buf.readUInt32LE(0x3C);
        if (peOff + 96 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null; // 'PE\0\0'
        const optStart = peOff + 24;
        const magic = buf.readUInt16LE(optStart);
        const dataDirStart = optStart + (magic === 0x20B ? 112 : 96); // PE32+ vs PE32
        const securitySizeOff = dataDirStart + 4 * 8 + 4;         // data directory index 4, its Size field
        if (securitySizeOff + 4 > buf.length) return null;
        return buf.readUInt32LE(securitySizeOff);
    } finally {
        fs.closeSync(fd);
    }
}

function main() {
    if (!fs.existsSync(DIST)) {
        fail('no dist/ directory. electron-builder did not produce a bundle.');
    }

    const files = walk(DIST, []);

    // better-sqlite3's .node binary must be unpacked from the asar rather than
    // sealed inside it, or it fails to load at runtime in the packaged app.
    // Checked on every bundle, darwin and windows both, because it ships on both.
    const sqliteUnpacked = files.filter(
        (f) => f.includes('app.asar.unpacked') && f.includes(sep('better-sqlite3')) && f.endsWith('.node'));
    if (sqliteUnpacked.length === 0) {
        fail('no unpacked better-sqlite3 .node file. asarUnpack for better-sqlite3 is missing or broken, ' +
            'so the database module is sealed in the asar and cannot load in the packaged app.');
    }
    for (const bin of sqliteUnpacked) console.log('  OK    unpacked native module: ' + rel(bin));
    console.log('  better-sqlite3 invariant: checked ' + sqliteUnpacked.length + ' .node file(s) unpacked');

    // The migration .sql must survive into the bundle at the exact path the app
    // resolves at runtime. openDatabase reads `./migrations/*.sql` relative to
    // its own module, which is bundled into out/main/index.js, so at runtime the
    // path is out/main/migrations/ inside the asar. The .sql is not unpacked;
    // Electron's patched fs reads it from inside the asar, so this reads the asar
    // the same way, with @electron/asar. A missing migration is a failed first
    // launch on a user's machine, invisible in dev, which is exactly the class
    // this guard exists to catch.
    const asar = require('@electron/asar');
    const asarPath = files.find((f) => path.basename(f) === 'app.asar');
    if (!asarPath) {
        fail('no app.asar found in dist. Cannot verify the migrations shipped.');
    }
    // Every migration in the source tree must survive into the bundle, not just
    // the first one. The list is read from the source so a new migration is checked
    // automatically and none can be forgotten. listPackage returns OS-separated
    // paths, so compare after normalising to forward slashes.
    const migrationsSrc = path.join(ROOT, 'src', 'main', 'storage', 'migrations');
    const migrationFiles = require('fs').readdirSync(migrationsSrc).filter((f) => f.endsWith('.sql')).sort();
    if (migrationFiles.length === 0) {
        fail('no migration .sql files found in ' + migrationsSrc + '; the guard has nothing to verify.');
    }
    const inAsar = asar.listPackage(asarPath)
        .map((p) => p.replace(/\\/g, '/').replace(/^\//, ''));
    for (const file of migrationFiles) {
        const runtimePath = 'out/main/migrations/' + file;
        if (!inAsar.includes(runtimePath)) {
            fail('migration ' + runtimePath + ' is not in app.asar at the path openDatabase resolves ' +
                'at runtime. electron-vite did not copy the .sql next to the main bundle, so the packaged app ' +
                'would throw at first launch trying to read its schema.');
        }
        const stat = asar.statFile(asarPath, ['out', 'main', 'migrations', file].join(path.sep));
        if (!stat || stat.size === 0) {
            fail('migration ' + runtimePath + ' is present in the asar but empty.');
        }
        console.log('  OK    migration in asar at runtime path: ' + runtimePath + ' (' + stat.size + ' bytes)');
    }

    console.log('packaged bundle check, platform ' + process.platform + ':');

    // The app exe must ship unsigned, deterministically. A public build must not carry
    // a local or work-issued cert, which would leak an employer identity into the
    // binary. This checks Stafford.exe itself, our artifact. A darwin bundle has no
    // Stafford.exe, so there is nothing to check there.
    const appExe = files.find((f) => path.basename(f) === 'Stafford.exe');
    if (appExe) {
        const sig = peSignatureSize(appExe);
        if (sig === null) {
            fail('could not read the PE headers of ' + rel(appExe) + ' to confirm it is unsigned.');
        }
        if (sig > 0) {
            fail('Stafford.exe carries an Authenticode signature (' + sig + ' bytes). A public build must ' +
                'ship unsigned so no local or work cert identity enters the artifact. Check the win.sign ' +
                'hook and that no CSC_* env is applied.');
        }
        console.log('  OK    Stafford.exe is unsigned (no Authenticode signature): ' + rel(appExe));
    } else {
        console.log('  Stafford.exe unsigned check: NOT APPLICABLE, no app exe in this bundle');
    }

    console.log('PASS  bundle checks complete (better-sqlite3 unpacked, migrations present' +
        (appExe ? ', exe unsigned' : '') + ')');
}

function rel(p) { return path.relative(DIST, p); }

main();
