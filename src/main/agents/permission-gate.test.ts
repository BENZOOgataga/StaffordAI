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
