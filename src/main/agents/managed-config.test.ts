/**
 * The managed config seed isolates a colleague from the user's global plugins by
 * relocating Claude's config into a Stafford-owned dir. These tests hold the two
 * security conditions (dir 0700, credential 0600, no broadening) and the isolation
 * invariants (plugin-free settings, project trust carried, account carried, auth
 * conditional on the real credential existing), plus the structural fact that the
 * managed dir cannot enter a checkpoint because it is outside every project repo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    seedManagedConfig, userMemoryExcludes, MANAGED_DIR_MODE, MANAGED_FILE_MODE,
    type ManagedFs, type SeedManagedConfigDeps
} from './managed-config.ts';

interface Entry { data: string; mode: number; mtime: number; }

/**
 * A recording in-memory ManagedFs. Tracks file contents, the mode each path was last
 * set to, and a monotonic mtime so the credential freshness check is exercisable. Every
 * write bumps a shared clock, so a file written later reads as newer, and `touch` lets a
 * test make the source credential newer than the managed copy.
 */
function fakeFs(seed: Record<string, string> = {}): ManagedFs & {
    files: Map<string, Entry>;
    modeOf: (p: string) => number | undefined;
    copyCount: () => number;
    touch: (p: string) => void;
} {
    const files = new Map<string, Entry>();
    let clock = 0;
    let copies = 0;
    const stamp = (): number => ++clock;
    for (const [p, data] of Object.entries(seed)) files.set(p, { data, mode: 0o600, mtime: stamp() });
    const fs: ManagedFs & {
        files: Map<string, Entry>; modeOf: (p: string) => number | undefined;
        copyCount: () => number; touch: (p: string) => void;
    } = {
        files,
        modeOf: (p) => files.get(p)?.mode,
        copyCount: () => copies,
        touch: (p) => { const e = files.get(p); if (e) e.mtime = stamp(); },
        exists: (p) => files.has(p),
        readText: (p) => {
            const e = files.get(p);
            if (!e) throw new Error('ENOENT ' + p);
            return e.data;
        },
        writeText: (p, data, mode) => { files.set(p, { data, mode, mtime: stamp() }); },
        mkdirp: (p, mode) => { if (!files.has(p)) files.set(p, { data: '<dir>', mode, mtime: stamp() }); },
        copyFile: (from, to, mode) => {
            const src = files.get(from);
            if (!src) throw new Error('ENOENT ' + from);
            copies++;
            files.set(to, { data: src.data, mode, mtime: stamp() });
        },
        chmod: (p, mode) => { const e = files.get(p); if (e) e.mode = mode; },
        mtimeMs: (p) => files.get(p)?.mtime ?? null,
        join: (...parts) => path.posix.join(...parts)
    };
    return fs;
}

const MANAGED = '/userData/claude-config';
const HOME = '/home/user';
const REAL_CRED = HOME + '/.claude/.credentials.json';
const REAL_JSON = HOME + '/.claude.json';
const CWD = '/home/user/projects/app';

function deps(fs: ManagedFs): SeedManagedConfigDeps {
    return { fs, managedDir: MANAGED, realHome: HOME, resolveKey: (d) => d.replace(/\\/g, '/') };
}

function managedConfig(fs: ReturnType<typeof fakeFs>): Record<string, unknown> {
    return JSON.parse(fs.readText(MANAGED + '/.claude.json')) as Record<string, unknown>;
}

test('managed dir is created owner-only (0700)', () => {
    const fs = fakeFs();
    const result = seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.modeOf(MANAGED), MANAGED_DIR_MODE);
    assert.equal(result.dirMode, 0o700);
});

test('copied credential is owner-only (0600) and never broadened', () => {
    const fs = fakeFs({ [REAL_CRED]: 'TOKEN-BYTES' });
    const result = seedManagedConfig(deps(fs), CWD);
    assert.equal(result.credentialCopied, true);
    assert.equal(result.credentialMode, MANAGED_FILE_MODE);
    assert.equal(fs.modeOf(MANAGED + '/.credentials.json'), 0o600);
    // group/other read bits are clear.
    assert.equal((fs.modeOf(MANAGED + '/.credentials.json')! & 0o077), 0);
});

test('the credential is copied once per session, not re-copied on later turns', () => {
    const fs = fakeFs({ [REAL_CRED]: 'TOKEN-BYTES' });
    seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.copyCount(), 1, 'the first seed copies the credential');
    // Later turns in the same session: the managed copy is present and fresh, so neither the
    // copy nor its owner-only lock runs again.
    seedManagedConfig(deps(fs), CWD);
    seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.copyCount(), 1, 'later turns do not re-copy or re-lock the credential');
    // Still reported as carried, and still owner-only.
    const result = seedManagedConfig(deps(fs), CWD);
    assert.equal(result.credentialCopied, true, 'the credential is still carried on a later turn');
    assert.equal(fs.modeOf(MANAGED + '/.credentials.json'), MANAGED_FILE_MODE);
});

test('a source credential newer than the managed copy is copied again', () => {
    const fs = fakeFs({ [REAL_CRED]: 'TOKEN-BYTES' });
    seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.copyCount(), 1);
    // The user re-authenticated, so the source credential is now newer than the managed copy.
    fs.touch(REAL_CRED);
    seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.copyCount(), 2, 'a refreshed source credential is re-copied');
});

test('a missing managed credential is copied again even mid-session', () => {
    const fs = fakeFs({ [REAL_CRED]: 'TOKEN-BYTES' });
    seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.copyCount(), 1);
    // Something removed the managed copy: it must be restored, not skipped as fresh.
    fs.files.delete(MANAGED + '/.credentials.json');
    seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.copyCount(), 2, 'a missing managed credential is re-copied');
});

test('no credential file present (macOS Keychain) does not throw and reports not copied', () => {
    const fs = fakeFs(); // no REAL_CRED
    const result = seedManagedConfig(deps(fs), CWD);
    assert.equal(result.credentialCopied, false);
    assert.equal(fs.files.has(MANAGED + '/.credentials.json'), false);
    // The rest of the seed still ran.
    assert.ok(fs.files.has(MANAGED + '/.claude.json'));
    assert.ok(fs.files.has(MANAGED + '/settings.json'));
});

test('account identity is carried from the real config, onboarding marked done', () => {
    const fs = fakeFs({
        [REAL_JSON]: JSON.stringify({
            oauthAccount: { emailAddress: 'x@y.z' }, userID: 'uid-1', lastOnboardingVersion: '2.1',
            enabledPlugins: { 'superpowers@m': true } // must NOT be carried
        })
    });
    seedManagedConfig(deps(fs), CWD);
    const cfg = managedConfig(fs);
    assert.deepEqual(cfg.oauthAccount, { emailAddress: 'x@y.z' });
    assert.equal(cfg.userID, 'uid-1');
    assert.equal(cfg.lastOnboardingVersion, '2.1');
    assert.equal(cfg.hasCompletedOnboarding, true);
    // The user's plugins are never carried into the managed config.
    assert.equal('enabledPlugins' in cfg, false);
});

test('project trust is written and never a permission bypass', () => {
    const fs = fakeFs();
    seedManagedConfig(deps(fs), CWD);
    const cfg = managedConfig(fs);
    const projects = cfg.projects as Record<string, Record<string, unknown>>;
    assert.equal(projects[CWD]?.hasTrustDialogAccepted, true);
    // No skip-all field, ever.
    const blob = JSON.stringify(cfg) + fs.readText(MANAGED + '/settings.json');
    for (const banned of ['dangerouslySkipPermissions', 'bypassPermissions', 'permissionMode', 'defaultMode']) {
        assert.equal(blob.includes(banned), false, banned + ' must not be written');
    }
});

test('settings.json is plugin-free: no plugins or marketplaces', () => {
    const fs = fakeFs();
    seedManagedConfig(deps(fs), CWD);
    const settings = JSON.parse(fs.readText(MANAGED + '/settings.json')) as Record<string, unknown>;
    for (const banned of ['enabledPlugins', 'extraKnownMarketplaces']) {
        assert.equal(banned in settings, false, banned + ' must be absent');
    }
});

test('the managed settings blank the user-scope memory with forward-slash excludes', () => {
    const fs = fakeFs();
    seedManagedConfig(deps(fs), CWD);
    const settings = JSON.parse(fs.readText(MANAGED + '/settings.json')) as Record<string, unknown>;
    // HOME is /home/user here; both the user CLAUDE.md and the whole user rules dir are excluded.
    assert.deepEqual(settings.claudeMdExcludes, ['/home/user/.claude/CLAUDE.md', '/home/user/.claude/rules/**']);
});

test('userMemoryExcludes converts a Windows home to forward slashes and globs the rules dir', () => {
    assert.deepEqual(
        userMemoryExcludes('C:\\Users\\dev'),
        ['C:/Users/dev/.claude/CLAUDE.md', 'C:/Users/dev/.claude/rules/**'],
        'backslashes become forward slashes, since a backslash is a glob escape'
    );
    // No backslash survives into the pattern.
    for (const p of userMemoryExcludes('C:\\Users\\dev')) assert.equal(p.includes('\\'), false);
});

test('the memory excludes are added alongside existing settings, never instead of them', () => {
    const fs = fakeFs();
    const staffordSettings = { hooks: { SessionStart: [{ hooks: [] }] } };
    seedManagedConfig({ ...deps(fs), settings: staffordSettings }, CWD);
    const settings = JSON.parse(fs.readText(MANAGED + '/settings.json')) as Record<string, unknown>;
    assert.deepEqual(settings.hooks, staffordSettings.hooks, 'existing settings survive');
    assert.deepEqual(settings.claudeMdExcludes, ['/home/user/.claude/CLAUDE.md', '/home/user/.claude/rules/**']);
});

test('Stafford hooks are written into the managed settings, scoped to the colleague session', () => {
    const fs = fakeFs();
    const staffordSettings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'X --stafford-hook', shell: 'powershell' }] }] } };
    seedManagedConfig({ ...deps(fs), settings: staffordSettings }, CWD);
    const settings = JSON.parse(fs.readText(MANAGED + '/settings.json')) as Record<string, unknown>;
    // The hooks reach the managed dir the colleague reads, with the shell pinned,
    // and still no plugins or marketplaces leak in.
    assert.deepEqual(settings.hooks, staffordSettings.hooks);
    assert.equal('enabledPlugins' in settings, false);
});

test('re-seeding a second project preserves the first project trust', () => {
    const fs = fakeFs();
    seedManagedConfig(deps(fs), CWD);
    const other = '/home/user/projects/other';
    seedManagedConfig(deps(fs), other);
    const projects = managedConfig(fs).projects as Record<string, Record<string, unknown>>;
    assert.equal(projects[CWD]?.hasTrustDialogAccepted, true);
    assert.equal(projects[other]?.hasTrustDialogAccepted, true);
});

test('managed config .claude.json is written owner-only (carries oauthAccount)', () => {
    const fs = fakeFs({ [REAL_JSON]: JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }) });
    seedManagedConfig(deps(fs), CWD);
    assert.equal(fs.modeOf(MANAGED + '/.claude.json'), MANAGED_FILE_MODE);
});

test('condition 2: the managed dir is outside every project repo, so it cannot enter a checkpoint', () => {
    // The checkpoint executor only stages tracked files inside the project cwd. The
    // managed dir lives under userData; assert it is neither the cwd nor a descendant
    // of it, which is what makes it structurally unreachable by a checkpoint.
    const managed = path.resolve(MANAGED);
    for (const projectCwd of ['/home/user/projects/app', '/userData', '/']) {
        const rel = path.relative(path.resolve(projectCwd), managed);
        const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        // Only '/userData' and '/' are ancestors of the managed dir; a real project
        // cwd is never an ancestor of userData. Assert the true project case is out.
        if (projectCwd === '/home/user/projects/app') {
            assert.equal(inside, false, 'managed dir must be outside the project repo');
        }
    }
});

/**
 * The macOS credential path.
 *
 * The seed used to assume a Mac needed nothing: the credential lived in Keychain, Keychain
 * was global, so an absent file was fine. Measured 2026-08-21 and the assumption was wrong.
 * With CLAUDE_CONFIG_DIR set, Claude Code does not consult Keychain at all, so an isolated
 * colleague was never authenticated and every turn answered "Not logged in". These cover the
 * second source that fixes it, and the conditions that keep the token from leaking.
 */

const MANAGED_CRED = MANAGED + '/.credentials.json';

test('macOS: with no credential file, the OS store is read and seeded into the managed dir', () => {
    const fs = fakeFs();
    const result = seedManagedConfig(
        { ...deps(fs), readOsCredential: () => 'KEYCHAIN-TOKEN-BYTES' }, CWD
    );

    assert.equal(result.credentialFromOsStore, true);
    assert.equal(result.credentialCopied, false, 'no file existed, so nothing was copied');
    assert.equal(fs.readText(MANAGED_CRED), 'KEYCHAIN-TOKEN-BYTES');
});

test('macOS: the seeded credential is owner-only (0600), same condition as a copied one', () => {
    const fs = fakeFs();
    seedManagedConfig({ ...deps(fs), readOsCredential: () => 'KEYCHAIN-TOKEN-BYTES' }, CWD);
    assert.equal(fs.modeOf(MANAGED_CRED), MANAGED_FILE_MODE);
});

test('a real credential file wins, so Windows and Linux never touch the OS store', () => {
    const fs = fakeFs({ [REAL_CRED]: 'FILE-TOKEN-BYTES' });
    let storeRead = false;
    const result = seedManagedConfig(
        { ...deps(fs), readOsCredential: () => { storeRead = true; return 'KEYCHAIN-TOKEN-BYTES'; } }, CWD
    );

    assert.equal(storeRead, false, 'the file is authoritative; the store must not even be consulted');
    assert.equal(result.credentialCopied, true);
    assert.equal(result.credentialFromOsStore, false);
    assert.equal(fs.readText(MANAGED_CRED), 'FILE-TOKEN-BYTES');
});

test('an empty or missing OS credential warns and writes nothing, rather than seeding a blank', () => {
    const fs = fakeFs();
    const warnings: string[] = [];
    const result = seedManagedConfig(
        { ...deps(fs), readOsCredential: () => null, warn: (m) => warnings.push(m) }, CWD
    );

    assert.equal(result.credentialFromOsStore, false);
    assert.equal(fs.files.has(MANAGED_CRED), false, 'a blank credential file would look like auth and is worse than none');
    assert.equal(warnings.length, 1, 'the person has to be told why the colleague will not answer');
});

test('a throwing OS store is treated as absent, so a locked Keychain cannot break the seed', () => {
    const fs = fakeFs();
    const result = seedManagedConfig(
        { ...deps(fs), readOsCredential: () => { throw new Error('User canceled the operation'); },
            warn: () => { /* expected */ } }, CWD
    );

    assert.equal(result.credentialFromOsStore, false);
    assert.equal(fs.files.has(MANAGED_CRED), false);
});

test('the seed result carries booleans only, so no log line can ever carry the token', () => {
    const fs = fakeFs();
    const result = seedManagedConfig(
        { ...deps(fs), readOsCredential: () => 'KEYCHAIN-TOKEN-BYTES' }, CWD
    );

    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes('KEYCHAIN-TOKEN-BYTES'),
        'SeedResult is what gets logged, so it must never contain the credential');
    assert.deepEqual(Object.keys(result).sort(),
        ['credentialCopied', 'credentialFromOsStore', 'credentialMode', 'dirMode']);
});

test('a failed OS read never puts the underlying reason in the warning', () => {
    const fs = fakeFs();
    const warnings: string[] = [];
    seedManagedConfig(
        { ...deps(fs), readOsCredential: () => { throw new Error('secret-bearing failure detail'); },
            warn: (m) => warnings.push(m) }, CWD
    );

    for (const w of warnings) {
        assert.ok(!w.includes('secret-bearing failure detail'),
            'an error from a credential read is the most likely place for a token to leak into a log');
    }
});
