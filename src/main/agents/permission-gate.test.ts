import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makePermissionGate } from './permission-gate.ts';
import { protectedConfigPaths } from './protected-config-paths.ts';
import type { AskRequest, AskOutcome } from './approval-registry.ts';
import type { QuestionRequest, QuestionOutcome } from './question-registry.ts';
import type { ProjectPolicy, PermissionRuleRecord } from '../../domain/models.ts';
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
function gateFor(
    p: ProjectPolicy,
    onAsk?: (r: AskRequest) => Promise<AskOutcome>,
    onQuestion?: (r: QuestionRequest) => Promise<QuestionOutcome>
) {
    const g = makePermissionGate({
        getPolicy: () => p,
        getStoredRules: () => [],
        protectedPaths: [USERDATA],
        normalisePath: (v: string) => v,
        ...(onAsk ? { onAsk } : {}),
        ...(onQuestion ? { onQuestion } : {})
    });
    return g({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
}

const behavior = async (decision: PermissionDecision | Promise<PermissionDecision>): Promise<string> =>
    (await decision).behavior;

/** A gate whose stored rules loosen the whole `other` category to allow, the config that used to let an
 * MCP tool bypass the protected/secret floor. */
function gateWithOtherAllowed() {
    const loosen: PermissionRuleRecord = {
        id: 'loosen-other', projectId: 'proj', hireId: null,
        action: 'other', pathScope: null, commandPattern: null, effect: 'allow',
        createdAt: '2026-01-01T00:00:00Z', createdBy: 'owner'
    };
    const g = makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => [loosen],
        protectedPaths: [USERDATA],
        normalisePath: (v: string) => v
    });
    return g({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
}

const PROTECTED_DB = path.join(USERDATA, 'Stafford', 'stafford.db');
const SECRET_ENV = path.join(CWD, 'config', '.env');

test('THE FLOOR: an other-category (MCP) tool cannot reach a protected path even when other is allowed', async () => {
    const tool = gateWithOtherAllowed();
    // Sanity: the loosen is real, an other-category tool with no protected target is allowed.
    assert.equal(await behavior(tool('mcp__db__query', { sql: 'select 1' })), 'allow', 'other is genuinely loosened');
    assert.equal(await behavior(tool('mcp__fs__read_file', { path: path.join(CWD, 'src', 'main.ts') })), 'allow', 'a harmless path is unaffected');
    // The floor: a protected target through an MCP tool is denied regardless of the loosened other.
    assert.equal(await behavior(tool('mcp__fs__read_file', { path: PROTECTED_DB })), 'deny', 'protected db via MCP is denied');
    assert.equal(await behavior(tool('mcp__fs__read_text', { absolute_path: PROTECTED_DB })), 'deny', 'a non-standard path key is still caught');
});

test('THE FLOOR: an other-category tool cannot reach a secret file even when other is allowed, including a nested arg', async () => {
    const tool = gateWithOtherAllowed();
    assert.equal(await behavior(tool('mcp__fs__read_file', { path: SECRET_ENV })), 'deny', 'a project .env via MCP is denied');
    assert.equal(await behavior(tool('mcp__x__op', { args: { files: [SECRET_ENV] } })), 'deny', 'a secret nested in an array arg is caught');
});

test('the floor does not change the default: an other tool with no protected target still asks', async () => {
    // No loosen, onAsk denies. An other tool with a harmless path takes the other default (ask -> deny
    // here), NOT the floor deny, so nothing that was prompted before is short-circuited.
    let asked = false;
    const tool = gateFor(policy(), async () => { asked = true; return { approve: false, note: null }; });
    assert.equal(await behavior(tool('mcp__fs__read_file', { path: path.join(CWD, 'src', 'main.ts') })), 'deny');
    assert.equal(asked, true, 'the harmless other tool went through the ask flow, not the floor');
    // A protected target still hits the floor at the default too (never silently allowed).
    asked = false;
    assert.equal(await behavior(tool('mcp__fs__read_file', { path: PROTECTED_DB })), 'deny');
    assert.equal(asked, false, 'the protected target was refused by the floor before the ask flow');
});

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

const ASK_INPUT = {
    questions: [{ question: 'Which color?', header: 'Color', multiSelect: false,
        options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }]
};

test('AskUserQuestion routes to the question seam and folds the selection into the tool input', async () => {
    let seen: QuestionRequest | null = null;
    const onQuestion = (r: QuestionRequest): Promise<QuestionOutcome> => {
        seen = r;
        return Promise.resolve({ answers: { 'Which color?': ['Red'] } });
    };
    const tool = gateFor(policy(), undefined, onQuestion);
    const decision = await Promise.resolve(tool('AskUserQuestion', ASK_INPUT, 'tool-1'));
    assert.equal(seen!.toolUseId, 'tool-1', 'the tool_use_id reaches the registry so the UI can match it');
    assert.deepEqual(seen!.questions.map((q) => q.header), ['Color']);
    assert.equal(decision.behavior, 'allow', 'the tool is allowed once answered');
    assert.deepEqual(
        (decision as { behavior: 'allow'; updatedInput: { answers?: unknown } }).updatedInput.answers,
        { 'Which color?': ['Red'] },
        'the selection is folded in as answers, the shape the CLI accepts'
    );
});

test('a cancelled question allows the tool with the input unchanged, so the colleague continues unanswered', async () => {
    const onQuestion = (): Promise<QuestionOutcome> => Promise.resolve({ answers: null });
    const tool = gateFor(policy(), undefined, onQuestion);
    const decision = await Promise.resolve(tool('AskUserQuestion', ASK_INPUT, 'tool-1'));
    assert.equal(decision.behavior, 'allow');
    assert.equal((decision as { updatedInput: { answers?: unknown } }).updatedInput.answers, undefined, 'no answers added');
});

test('a malformed AskUserQuestion input falls through to the normal gate, never the question seam', async () => {
    let called = false;
    const onQuestion = (): Promise<QuestionOutcome> => { called = true; return Promise.resolve({ answers: null }); };
    // No parseable questions: the ask is not routed to onQuestion; it falls to the category default.
    const tool = gateFor(policy(), undefined, onQuestion);
    await Promise.resolve(tool('AskUserQuestion', { not: 'an ask' }, 'tool-1'));
    assert.equal(called, false, 'the question seam is not invoked for an unparseable ask');
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

// --------------------------------------------------------------------------
// Phase 3: a rule edited in the config UI has to reach the next turn.
//
// Rules are cached per project and colleague so resolution never touches the database on the
// hot path, which phase 1 chose deliberately. That cache is also what would make an edit
// invisible: without invalidation, changing a rule would do nothing until Stafford restarted,
// and the screen would look broken while being correct. These pin the round trip the UI
// depends on.
// --------------------------------------------------------------------------

test('phase 3: without invalidation the cache would serve stale rules, which is the trap', async () => {
    let stored: PermissionRuleRecord[] = [];
    const gate = makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => stored,
        protectedPaths: [USERDATA],
        normalisePath: (v: string) => v,
        realPath: (v: string) => v
    });
    const tool = gate({ hireId: 'h1', cwd: CWD, projectId: 'proj' });

    assert.equal(await behavior(tool('Write', { file_path: path.join(CWD, 'src', 'a.ts') })), 'allow');

    // The person adds a deny in the UI. The store now says deny, but nothing has told the gate.
    stored = [{
        id: 'r1', projectId: 'proj', hireId: null, action: 'write',
        pathScope: path.join(CWD, 'src'), commandPattern: null, effect: 'deny',
        createdAt: 't', createdBy: 'owner'
    }];

    assert.equal(await behavior(tool('Write', { file_path: path.join(CWD, 'src', 'a.ts') })), 'allow',
        'the cache is still serving the old rules, which is exactly why invalidate exists');
});

test('phase 3: after invalidate, the next turn resolves against the edited rule', async () => {
    let stored: PermissionRuleRecord[] = [];
    const gate = makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => stored,
        protectedPaths: [USERDATA],
        normalisePath: (v: string) => v,
        realPath: (v: string) => v
    });

    const before = gate({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
    assert.equal(await behavior(before('Write', { file_path: path.join(CWD, 'src', 'a.ts') })), 'allow');

    stored = [{
        id: 'r1', projectId: 'proj', hireId: null, action: 'write',
        pathScope: path.join(CWD, 'src'), commandPattern: null, effect: 'deny',
        createdAt: 't', createdBy: 'owner'
    }];
    gate.invalidate();

    // A new turn, which is what the runner builds per message.
    const next = gate({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
    assert.equal(await behavior(next('Write', { file_path: path.join(CWD, 'src', 'a.ts') })), 'deny',
        'this is the round trip the config UI depends on: edit a rule, the next turn enforces it');
});

test('phase 3: a colleague override added in the UI reaches that colleague and not the others', async () => {
    let stored: PermissionRuleRecord[] = [];
    const gate = makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => stored,
        protectedPaths: [USERDATA],
        normalisePath: (v: string) => v,
        realPath: (v: string) => v
    });

    stored = [{
        id: 'r1', projectId: 'proj', hireId: 'h1', action: 'write',
        pathScope: path.join(CWD, 'src'), commandPattern: null, effect: 'deny',
        createdAt: 't', createdBy: 'owner'
    }];
    gate.invalidate();

    const restricted = gate({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
    const other = gate({ hireId: 'h2', cwd: CWD, projectId: 'proj' });

    assert.equal(await behavior(restricted('Write', { file_path: path.join(CWD, 'src', 'a.ts') })), 'deny');
    assert.equal(await behavior(other('Write', { file_path: path.join(CWD, 'src', 'a.ts') })), 'allow',
        'an override names one colleague, so it must not leak onto another');
});

// --------------------------------------------------------------------------
// Finding A (audit 2026-08-24): the gate protected only userData, while the config UI and the
// edit warnings displayed a larger set (~/.claude, ~/.ssh, ~/.aws, ~/.gnupg, ~/.docker, ~/.kube,
// ~/.config/gh). Read defaults to allow, so a colleague could read ~/.ssh/id_rsa and
// ~/.claude/.credentials.json while the screen claimed those were protected. The fix wires the
// same `protectedConfigPaths` set into the gate, so enforcement matches display.
// --------------------------------------------------------------------------

const HOME = path.resolve('/home/benzoo');
const USERDATA_FOR_CONFIG = path.resolve('/userdata');

/** A concrete credential file the colleague must not be able to read, one per protected entry. */
const CREDENTIAL_READS: readonly string[] = [
    path.join(HOME, '.claude', '.credentials.json'),
    path.join(HOME, '.ssh', 'id_rsa'),
    path.join(HOME, '.aws', 'credentials'),
    path.join(HOME, '.gnupg', 'secring.gpg'),
    path.join(HOME, '.docker', 'config.json'),
    path.join(HOME, '.kube', 'config'),
    path.join(HOME, '.config', 'gh', 'hosts.yml'),
    path.join(HOME, '.gitconfig'),
    path.join(HOME, '.git-credentials'),
    path.join(HOME, '.azure', 'accessTokens.json'),
    path.join(HOME, '.config', 'gcloud', 'credentials.db'),
    path.join(HOME, 'AppData', 'Roaming', 'gcloud', 'credentials.db'),
    path.join(HOME, '.gcloud', 'credentials.db')
];

function gateWithProtected(protectedPaths: readonly string[]) {
    return makePermissionGate({
        getPolicy: () => policy(),
        getStoredRules: () => [],
        protectedPaths,
        normalisePath: (v: string) => v,
        realPath: (v: string) => v
    })({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
}

test('Finding A: protectedConfigPaths is userData plus the credential directories, locked in order', () => {
    assert.deepEqual(protectedConfigPaths(HOME, USERDATA_FOR_CONFIG), [
        USERDATA_FOR_CONFIG,
        path.join(HOME, '.claude'),
        path.join(HOME, '.ssh'),
        path.join(HOME, '.aws'),
        path.join(HOME, '.gnupg'),
        path.join(HOME, '.docker'),
        path.join(HOME, '.kube'),
        path.join(HOME, '.config', 'gh'),
        path.join(HOME, '.gitconfig'),
        path.join(HOME, '.git-credentials'),
        path.join(HOME, '.azure'),
        path.join(HOME, '.config', 'gcloud'),
        path.join(HOME, 'AppData', 'Roaming', 'gcloud'),
        path.join(HOME, '.gcloud')
    ]);
});

test('Finding A: every credential directory the UI shows as protected actually denies a read', async () => {
    // Wired exactly as the gate now is in index.ts: the full protectedConfigPaths set.
    const gate = gateWithProtected(protectedConfigPaths(HOME, USERDATA_FOR_CONFIG));
    for (const target of CREDENTIAL_READS) {
        assert.equal(await behavior(gate('Read', { file_path: target })), 'deny',
            'a colleague must not read a credential the config screen claims is protected: ' + target);
        assert.equal(await behavior(gate('Write', { file_path: target })), 'deny',
            'nor write it: ' + target);
    }
    // userData stays protected, and an unrelated file under home is still readable, so the fix
    // did not blanket-deny the home directory.
    assert.equal(await behavior(gate('Read', { file_path: path.join(USERDATA_FOR_CONFIG, 'stafford.db') })), 'deny');
    assert.equal(await behavior(gate('Read', { file_path: path.join(HOME, 'notes.txt') })), 'allow',
        'only the named credential directories are protected, not the whole home directory');
});

test('Finding A: the exact gap is closed, userData-only allowed these reads, the full set denies them', async () => {
    // This is the regression the fix closes, pinned as a before/after. The old wiring passed only
    // userData; the credential reads fell through to the read-allow default. The new wiring denies
    // them. If someone reverts the gate to userData-only, the "after" assertions below fail.
    const oldGate = gateWithProtected([USERDATA_FOR_CONFIG]);
    const newGate = gateWithProtected(protectedConfigPaths(HOME, USERDATA_FOR_CONFIG));
    for (const target of CREDENTIAL_READS) {
        assert.equal(await behavior(oldGate('Read', { file_path: target })), 'allow',
            'documents the gap: userData-only protection left this credential readable: ' + target);
        assert.equal(await behavior(newGate('Read', { file_path: target })), 'deny',
            'the fix: the credential is now denied at the gate: ' + target);
    }
});
