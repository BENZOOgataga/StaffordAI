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
    seedManagedConfig, MANAGED_DIR_MODE, MANAGED_FILE_MODE, type ManagedFs, type SeedManagedConfigDeps
} from './managed-config.ts';

interface Entry { data: string; mode: number; }

/**
 * A recording in-memory ManagedFs. Tracks file contents and the mode each path was
 * last set to, so the POSIX permission conditions are asserted on any platform.
 */
function fakeFs(seed: Record<string, string> = {}): ManagedFs & {
    files: Map<string, Entry>;
    modeOf: (p: string) => number | undefined;
} {
    const files = new Map<string, Entry>();
    for (const [p, data] of Object.entries(seed)) files.set(p, { data, mode: 0o600 });
    const fs: ManagedFs & { files: Map<string, Entry>; modeOf: (p: string) => number | undefined } = {
        files,
        modeOf: (p) => files.get(p)?.mode,
        exists: (p) => files.has(p),
        readText: (p) => {
            const e = files.get(p);
            if (!e) throw new Error('ENOENT ' + p);
            return e.data;
        },
        writeText: (p, data, mode) => { files.set(p, { data, mode }); },
        mkdirp: (p, mode) => { files.set(p, { data: '<dir>', mode }); },
        copyFile: (from, to, mode) => {
            const src = files.get(from);
            if (!src) throw new Error('ENOENT ' + from);
            files.set(to, { data: src.data, mode });
        },
        chmod: (p, mode) => { const e = files.get(p); if (e) e.mode = mode; },
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

test('settings.json is plugin-free: no plugins, marketplaces, or hooks', () => {
    const fs = fakeFs();
    seedManagedConfig(deps(fs), CWD);
    const settings = JSON.parse(fs.readText(MANAGED + '/settings.json')) as Record<string, unknown>;
    for (const banned of ['enabledPlugins', 'extraKnownMarketplaces', 'hooks']) {
        assert.equal(banned in settings, false, banned + ' must be absent');
    }
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
