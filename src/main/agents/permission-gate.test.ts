import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makePermissionGate } from './permission-gate.ts';
import type { AskRequest, AskOutcome } from './approval-registry.ts';
import type { ProjectPolicy } from '../../domain/models.ts';
import type { PermissionDecision } from './claude-runner.ts';

const CWD = path.resolve('/proj');
const USERDATA = path.resolve('/userdata');

function policy(over: Partial<ProjectPolicy> = {}): ProjectPolicy {
    return {
        push: 'none', allowedRoles: [], toolCeiling: null, writePaths: null,
        requirePipeline: false, allowWebFetch: true, permissionMode: 'default', maxConcurrentAgents: 1, ...over
    };
}

/**
 * The phase-1 and phase-2 tests run with an identity fold, so they keep asserting exactly
 * what they always asserted: the resolver's own behaviour, unchanged by the case fix. The
 * platform-specific folding is covered separately at the bottom of this file.
 */
function gateFor(p: ProjectPolicy, onAsk?: (r: AskRequest) => Promise<AskOutcome>) {
    const g = makePermissionGate({
        getPolicy: () => p,
        getStoredRules: () => [],
        protectedPaths: [USERDATA],
        normalisePath: (v: string) => v,
        ...(onAsk ? { onAsk } : {})
    });
    return g({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
}

const behavior = async (decision: PermissionDecision | Promise<PermissionDecision>): Promise<string> =>
    (await decision).behavior;

test('an in-scope read and write are allowed; ordinary shell is allowed', async () => {
    const tool = gateFor(policy());
    assert.equal(await behavior(tool('Read', { file_path: 'src/main.ts' })), 'allow');
    assert.equal(await behavior(tool('Write', { file_path: 'src/main.ts' })), 'allow');
    assert.equal(await behavior(tool('Bash', { command: 'npm test' })), 'allow');
    assert.equal(await behavior(tool('Task', { description: 'do a thing' })), 'allow');
});

test('a write outside the repo is denied', async () => {
    const tool = gateFor(policy());
    assert.equal(await behavior(tool('Write', { file_path: path.resolve('/somewhere/else.txt') })), 'deny');
});

test('path traversal does not widen scope: src/../.. resolves outside and denies', async () => {
    const tool = gateFor(policy({ writePaths: ['src'] }));
    assert.equal(await behavior(tool('Write', { file_path: 'src/x.ts' })), 'allow');
    assert.equal(await behavior(tool('Write', { file_path: 'src/../../outside.txt' })), 'deny');
});

test('the security invariant: reading or writing the config store is denied', async () => {
    const tool = gateFor(policy());
    const configDb = path.resolve('/userdata/Stafford/stafford.db');
    assert.equal(await behavior(tool('Read', { file_path: configDb })), 'deny');
    assert.equal(await behavior(tool('Write', { file_path: configDb })), 'deny');
    assert.equal(await behavior(tool('Edit', { file_path: path.resolve('/userdata/claude-config/.claude.json') })), 'deny');
});

test('without an ask handler, an ask resolves as deny (the phase-1 fallback)', async () => {
    const tool = gateFor(policy());
    const decision = await Promise.resolve(tool('Bash', { command: 'git push --force origin main' }));
    assert.equal(decision.behavior, 'deny');
    assert.equal(await behavior(tool('SomeMcpTool', {})), 'deny');
});

test('with an ask handler, an approved ask allows and a denied ask denies with the note', async () => {
    const approve = gateFor(policy(), async () => ({ approve: true, note: null }));
    assert.equal(await behavior(approve('Bash', { command: 'git push --force origin main' })), 'allow');

    const deny = gateFor(policy(), async () => ({ approve: false, note: 'not on main' }));
    const decision = await Promise.resolve(deny('Bash', { command: 'git push --force origin main' }));
    assert.equal(decision.behavior, 'deny');
    assert.equal((decision as { message: string }).message, 'not on main');

    // an ordinary command does not reach the ask handler at all
    let asked = false;
    const gate = gateFor(policy(), async () => { asked = true; return { approve: true, note: null }; });
    assert.equal(await behavior(gate('Bash', { command: 'npm test' })), 'allow');
    assert.equal(asked, false, 'an allowed action never asks');
});

test('fetch follows allowWebFetch: allowed when set, denied (ask fallback) when not', async () => {
    assert.equal(await behavior(gateFor(policy({ allowWebFetch: true }))('WebFetch', { url: 'https://example.com' })), 'allow');
    assert.equal(await behavior(gateFor(policy({ allowWebFetch: false }))('WebFetch', { url: 'https://example.com' })), 'deny');
});

// --------------------------------------------------------------------------
// M1: the protected-path case bypass, and the platform rule that closes it.
//
// The gate compared paths case sensitively while macOS on APFS and Windows on NTFS are
// case insensitive, so a case-varied spelling of a protected path named the same file and
// missed the deny rule. Measured 2026-08-21 against the real gate: exact case denied,
// lowercased allowed, case varied allowed, all three the same file. That directory holds
// the permission store, the database and the managed credential.
//
// The fix folds both sides through platform.normalisePath. It is deliberately not a
// toLowerCase: linux and a case-sensitive APFS volume have genuinely distinct files at
// paths differing only in case, and folding there would make a write land somewhere else.
// --------------------------------------------------------------------------

/** The real folds, copied from the platform layer so this file needs no Electron. */
const FOLD_CASE_INSENSITIVE = (v: string): string => v.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const FOLD_CASE_SENSITIVE = (v: string): string => v.replace(/\/+$/, '');

const MIXED_USERDATA = path.resolve('/UserData');

function gateWithFold(normalisePath: (v: string) => string, protectedPath: string) {
    return makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => [],
        protectedPaths: [protectedPath],
        normalisePath
    })({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
}

test('M1: on a case-insensitive filesystem, every spelling of a protected path is denied', async () => {
    const gate = gateWithFold(FOLD_CASE_INSENSITIVE, MIXED_USERDATA);
    const spellings = [
        MIXED_USERDATA,
        MIXED_USERDATA.toLowerCase(),
        MIXED_USERDATA.toUpperCase(),
        path.resolve('/uSeRdAtA')
    ];

    for (const dir of spellings) {
        const target = path.join(dir, 'stafford.db');
        assert.equal(await behavior(gate('Read', { file_path: target })), 'deny',
            'every spelling names the same real file, so every spelling must deny: ' + target);
        assert.equal(await behavior(gate('Write', { file_path: target })), 'deny',
            'a write bypass is worse than a read bypass: ' + target);
    }
});

test('M1: the exact bypass from the findings report is closed', async () => {
    // Before the fix this returned deny, allow, allow. All three name one file.
    const gate = gateWithFold(FOLD_CASE_INSENSITIVE, MIXED_USERDATA);
    const results = await Promise.all([
        behavior(gate('Read', { file_path: path.join(MIXED_USERDATA, 'permissions.json') })),
        behavior(gate('Read', { file_path: path.join(MIXED_USERDATA.toLowerCase(), 'permissions.json') })),
        behavior(gate('Read', { file_path: path.join(path.resolve('/USERdata'), 'permissions.json') }))
    ]);
    assert.deepEqual(results, ['deny', 'deny', 'deny']);
});

test('M1: on linux the fold is NOT applied, since differently-cased paths are different files', async () => {
    const gate = gateWithFold(FOLD_CASE_SENSITIVE, path.resolve('/UserData'));

    // The protected path itself still denies.
    assert.equal(await behavior(gate('Read', { file_path: path.resolve('/UserData') + '/stafford.db' })), 'deny');

    // A differently-cased path is a genuinely different directory here, so it must NOT be
    // swept into the protected scope. Folding it would deny access to an unrelated file,
    // and the same error in the other direction is what makes a write land on the wrong path.
    assert.equal(await behavior(gate('Read', { file_path: path.resolve('/userdata') + '/notes.txt' })), 'allow',
        'a blanket lowercase would wrongly treat /userdata as the protected /UserData');
});

test('M1: the case fold does not defeat traversal resolution, which still happens first', async () => {
    const gate = gateWithFold(FOLD_CASE_INSENSITIVE, MIXED_USERDATA);
    // Resolves into the protected dir by traversal AND varies the case on the way.
    const sneaky = path.join(CWD, 'src', '..', '..', 'UsErDaTa', 'stafford.db');
    assert.equal(await behavior(gate('Read', { file_path: sneaky })), 'deny',
        'path.resolve must collapse the traversal before the fold, or a traversal plus a case ' +
        'variation would slip through both checks');
});

test('M1: folding both sides does not break an ordinary in-scope write', async () => {
    // The failure mode of folding one side only: nothing matches and everything falls to
    // the category default. This proves the normal path still resolves.
    const gate = gateWithFold(FOLD_CASE_INSENSITIVE, MIXED_USERDATA);
    assert.equal(await behavior(gate('Write', { file_path: path.join(CWD, 'src', 'index.ts') })), 'allow');
    assert.equal(await behavior(gate('Read', { file_path: path.join(CWD, 'README.md') })), 'allow');
});

test('M1: a case-varied repo root still resolves its own write scope, on a folding platform', async () => {
    const gate = makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => [],
        protectedPaths: [MIXED_USERDATA],
        normalisePath: FOLD_CASE_INSENSITIVE
    })({ hireId: 'h1', cwd: path.resolve('/PROJ'), projectId: 'proj' });

    assert.equal(await behavior(gate('Write', { file_path: path.resolve('/proj') + '/src/a.ts' })), 'allow',
        'the cwd and the request differ only in case, so on macOS and Windows they are one repo');
});

// --------------------------------------------------------------------------
// The symlink false-deny. A project reached through a symlink was refused its own files,
// because Claude Code reports a file's real path while the gate held the configured one.
// It was pre-existing and invisible until PR 112 made the gate actually decide. macOS puts
// /tmp and /var behind symlinks into /private, so it bit on the first real proof run.
// --------------------------------------------------------------------------

/** A constructed filesystem: `/link` is a symlink to `/real`. No disk involved. */
const LINK_ROOT = path.resolve('/link');
const REAL_ROOT = path.resolve('/real');
const fakeRealpath = (v: string): string => {
    const n = v.replace(/\\/g, '/');
    const link = LINK_ROOT.replace(/\\/g, '/');
    const real = REAL_ROOT.replace(/\\/g, '/');
    if (n === link) return REAL_ROOT;
    if (n.startsWith(link + '/')) return path.resolve(real + n.slice(link.length));
    // Anything not under the link resolves to itself, like a path with no symlinks in it.
    return v;
};

function gateAt(cwd: string, opts: { protectedPaths?: string[]; realPath?: (v: string) => string } = {}) {
    return makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => [],
        protectedPaths: opts.protectedPaths ?? [USERDATA],
        normalisePath: (v: string) => v,
        realPath: opts.realPath ?? fakeRealpath
    })({ hireId: 'h1', cwd, projectId: 'proj' });
}

test('symlink: a project under a symlinked path can write its own files', async () => {
    // The failing case. cwd is the symlink, Claude Code reports the real path.
    const gate = gateAt(LINK_ROOT);
    assert.equal(await behavior(gate('Write', { file_path: path.join(REAL_ROOT, 'note.txt') })), 'allow',
        'the project was refused its own file because the two paths name one directory through ' +
        'a symlink and were compared as text');
});

test('symlink: the missing leaf is handled, so creating a NEW file resolves', async () => {
    // realpath throws on a path that does not exist, and a Write is always that case.
    const gate = gateAt(LINK_ROOT, { realPath: (v) => {
        if (/(note|fresh)\.txt$/.test(v)) throw new Error('ENOENT');
        return fakeRealpath(v);
    } });
    assert.equal(await behavior(gate('Write', { file_path: path.join(REAL_ROOT, 'fresh.txt') })), 'allow',
        'a file that does not exist yet must still resolve through its parent directory');
});

test('symlink: a deep new path under fresh directories still resolves to the project', async () => {
    const gate = gateAt(LINK_ROOT, { realPath: (v) => {
        if (v.replace(/\\/g, '/').includes('/newdir')) throw new Error('ENOENT');
        return fakeRealpath(v);
    } });
    assert.equal(await behavior(gate('Write', { file_path: path.join(REAL_ROOT, 'newdir', 'deep', 'x.ts') })), 'allow');
});

test('symlink: resolution does NOT weaken protection, a protected path via a symlink still denies', async () => {
    // The protected directory is configured through the symlink; the request arrives as the
    // real path. Both must land on the same place or userData stops being protected.
    const gate = gateAt(REAL_ROOT, { protectedPaths: [path.join(LINK_ROOT, 'userdata')] });
    assert.equal(await behavior(gate('Read', { file_path: path.join(REAL_ROOT, 'userdata', 'stafford.db') })), 'deny',
        'a protected path reached by its real name must still deny when it was configured by its link name');
    assert.equal(await behavior(gate('Write', { file_path: path.join(REAL_ROOT, 'userdata', 'x') })), 'deny');
});

test('symlink: traversal protection still holds after resolution', async () => {
    const gate = gateAt(LINK_ROOT);
    assert.equal(await behavior(gate('Write', { file_path: path.join(LINK_ROOT, 'src', '..', '..', 'outside.txt') })), 'deny',
        'path.resolve must still collapse the traversal before realpath, or resolution becomes an escape');
});

test('symlink: the case fold still applies on a folding platform, after resolution', async () => {
    const gate = makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => [],
        protectedPaths: [MIXED_USERDATA],
        normalisePath: FOLD_CASE_INSENSITIVE,
        realPath: (v) => v
    })({ hireId: 'h1', cwd: CWD, projectId: 'proj' });

    assert.equal(await behavior(gate('Read', { file_path: path.join(MIXED_USERDATA.toLowerCase(), 'db') })), 'deny',
        'adding realpath must not undo the M1 case fold');
});

test('symlink: linux stays case sensitive after resolution', async () => {
    const gate = makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => [],
        protectedPaths: [path.resolve('/UserData')],
        normalisePath: FOLD_CASE_SENSITIVE,
        realPath: (v) => v
    })({ hireId: 'h1', cwd: CWD, projectId: 'proj' });

    assert.equal(await behavior(gate('Read', { file_path: path.resolve('/userdata') + '/notes.txt' })), 'allow',
        'realpath must not smuggle in a case fold where paths of differing case are different files');
});

test('symlink: a filesystem that cannot resolve at all falls back to the textual path', async () => {
    const gate = gateAt(CWD, { realPath: () => { throw new Error('EACCES'); } });
    assert.equal(await behavior(gate('Write', { file_path: path.join(CWD, 'src', 'a.ts') })), 'allow',
        'an unresolvable filesystem must degrade to the previous behaviour, not deny everything');
});

/**
 * The same thing against a real symlink on a real filesystem, because the tests above use a
 * constructed one and a constructed filesystem agrees with whatever I assumed about the real
 * one. This is the shape that actually failed: a project directory reached through a link.
 *
 * Runs in the OS temp directory, never in the repository, per the probe rule in CONVENTIONS.
 */
// @real-machine
test('symlink, on a real filesystem: a linked project writes its own files and still protects userData', async () => {
    const { mkdtempSync, symlinkSync, mkdirSync, rmSync, realpathSync } = await import('node:fs');
    const os = await import('node:os');

    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate-symlink-')));
    const realProject = path.join(base, 'real-project');
    const linkedProject = path.join(base, 'linked-project');
    const protectedDir = path.join(realProject, 'userdata');
    mkdirSync(realProject);
    mkdirSync(protectedDir);
    symlinkSync(realProject, linkedProject, 'dir');

    try {
        const gate = makePermissionGate({
            getPolicy: () => policy(),
            getStoredRules: () => [],
            // Configured through the link, exactly as a person would paste it.
            protectedPaths: [path.join(linkedProject, 'userdata')],
            normalisePath: (v: string) => v
            // No realPath injected: this uses the real fs.realpathSync.native.
        })({ hireId: 'h1', cwd: linkedProject, projectId: 'proj' });

        // Claude Code reports the resolved real path. This is the write that was refused.
        assert.equal(await behavior(gate('Write', { file_path: path.join(realProject, 'note.txt') })), 'allow',
            'a project reached through a symlink must be able to write its own files');

        // And the leaf does not exist yet, which is what a Write always means.
        assert.equal(await behavior(gate('Write', { file_path: path.join(realProject, 'brand', 'new.txt') })), 'allow');

        // Protection survives the resolution, by the real name and by the link name.
        assert.equal(await behavior(gate('Read', { file_path: path.join(protectedDir, 'stafford.db') })), 'deny');
        assert.equal(await behavior(gate('Read', { file_path: path.join(linkedProject, 'userdata', 'stafford.db') })), 'deny');

        // And nothing outside the project became writable along the way.
        assert.equal(await behavior(gate('Write', { file_path: path.join(base, 'escape.txt') })), 'deny');
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});
