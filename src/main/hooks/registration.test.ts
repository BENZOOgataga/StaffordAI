import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCommand, hookShellFor, desiredHooks, merge, unregister, inspect,
    hasExcludeEntry, addExcludeEntry, isStaffordCommand,
    HOOK_MARKER, REGISTERED_EVENTS, EXCLUDE_ENTRY, type Settings
} from './registration.ts';

const COMMAND = buildCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Stafford\\hooks\\claude-hook.js', 'powershell');

test('the Windows hook command is PowerShell-valid and runs the forwarder as node without global node', () => {
    const command = buildCommand('C:\\App\\Stafford.exe', 'C:\\App\\claude-hook.cjs', 'powershell');
    // The call operator, or PowerShell parses "exe" "arg" as two expressions and
    // the hook cannot launch, which is the real Windows failure.
    assert.match(command, /^\$env:ELECTRON_RUN_AS_NODE=1; & "/);
    assert.ok(command.includes('"C:\\App\\Stafford.exe"'));
    assert.ok(command.includes(HOOK_MARKER));
});

test('the POSIX hook command prefixes the env and needs no call operator', () => {
    const command = buildCommand('/Applications/Stafford.app/x', '/Applications/Stafford.app/claude-hook.cjs', 'posix');
    assert.match(command, /^ELECTRON_RUN_AS_NODE=1 "/);
    assert.equal(command.includes('& '), false, 'the call operator is PowerShell-only');
    assert.ok(command.includes(HOOK_MARKER));
});

test('the hook shell is PowerShell on Windows and POSIX elsewhere', () => {
    assert.equal(hookShellFor('win32'), 'powershell');
    assert.equal(hookShellFor('darwin'), 'posix');
    assert.equal(hookShellFor('linux'), 'posix');
});
const OTHERS: Settings = {
    hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '"C:\\tools\\someone-else.exe"' }] }]
    },
    permissions: { allow: ['Read'] }
};

test('six events, and never the per-tool ones', () => {
    // The first registration since the global set was removed, which is exactly
    // when PreToolUse could quietly return.
    assert.deepEqual([...REGISTERED_EVENTS].sort(), [
        'Notification', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit'
    ]);
    assert.equal(REGISTERED_EVENTS.length, 6);

    const hooks = desiredHooks(COMMAND);
    assert.equal('PreToolUse' in hooks, false);
    assert.equal('PostToolUse' in hooks, false);
    assert.equal(Object.keys(hooks).length, 6);
});

test('registering is idempotent, however many times it runs', () => {
    const once = merge({}, COMMAND);
    const twice = merge(once, COMMAND);
    const thrice = merge(twice, COMMAND);

    assert.deepEqual(twice, once, 'a second registration must not duplicate anything');
    assert.deepEqual(thrice, once);
    for (const event of REGISTERED_EVENTS) {
        const entries = (thrice.hooks?.[event] ?? []).flatMap((g) => g.hooks);
        assert.equal(entries.length, 1, event + ' ended up with ' + entries.length + ' entries');
    }
});

test('somebody else\'s hooks survive, and nothing outside the hooks key is touched', () => {
    const merged = merge(OTHERS, COMMAND);

    const sessionStart = (merged.hooks?.SessionStart ?? []).flatMap((g) => g.hooks);
    assert.equal(sessionStart.some((h) => h.command.includes('someone-else')), true, 'their hook is still there');
    assert.equal(sessionStart.some((h) => isStaffordCommand(h.command)), true, 'and ours is too');

    assert.deepEqual(merged.permissions, { allow: ['Read'] }, 'nothing outside hooks may change');
});

test('unregistering removes only ours', () => {
    const merged = merge(OTHERS, COMMAND);
    const clean = unregister(merged);

    const remaining = Object.values(clean.hooks ?? {}).flatMap((g) => g.flatMap((x) => x.hooks));
    assert.equal(remaining.some((h) => isStaffordCommand(h.command)), false);
    assert.equal(remaining.some((h) => h.command.includes('someone-else')), true);
    assert.deepEqual(clean.permissions, { allow: ['Read'] });
});

test('unregistering from a project with only our hooks drops the key entirely', () => {
    const clean = unregister(merge({}, COMMAND));
    assert.equal('hooks' in clean, false, 'an empty hooks object left behind is litter');
});

test('the sweep sees a correct registration, a missing one, and a stale path', () => {
    assert.equal(inspect(merge({}, COMMAND), COMMAND).reason, 'correct');
    assert.equal(inspect({}, COMMAND).reason, 'missing');
    assert.equal(inspect(OTHERS, COMMAND).reason, 'missing', 'other people\'s hooks are not ours');

    // The case the marker exists for: the forwarder moved, so every hook in
    // this project is failing silently and no card would show it.
    const moved = buildCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Stafford\\resources\\stafford-hook.exe', 'powershell');
    const finding = inspect(merge({}, COMMAND), moved);
    assert.equal(finding.reason, 'stale-path');
    assert.match(finding.detail, /failing silently/);
});

test('the sweep notices a registration that lost events', () => {
    const merged = merge({}, COMMAND);
    delete merged.hooks?.SubagentStop;
    const finding = inspect(merged, COMMAND);

    assert.equal(finding.reason, 'wrong-events');
    assert.match(finding.detail, /Notification/);
});

test('entries are found by marker, never by path', () => {
    assert.equal(isStaffordCommand('"node" "C:\\anywhere\\at\\all.js" ' + HOOK_MARKER), true);
    assert.equal(isStaffordCommand('"node" "C:\\Stafford\\hooks\\claude-hook.js"'), false, 'path alone is not ours');
    assert.equal(isStaffordCommand(undefined), false);
    assert.equal(isStaffordCommand(42), false);
});

test('the exclude entry goes in info/exclude, and adding it twice adds it once', () => {
    assert.equal(hasExcludeEntry(''), false);

    const once = addExcludeEntry('');
    assert.equal(hasExcludeEntry(once), true);
    assert.equal(addExcludeEntry(once), once, 'idempotent');

    // Existing content survives, and a missing trailing newline does not glue
    // the entry onto somebody else's last line.
    const existing = '*.log\nbuild/';
    const merged = addExcludeEntry(existing);
    assert.match(merged, /^\*\.log\nbuild\/\n/);
    assert.equal(hasExcludeEntry(merged), true);
    assert.equal(merged.includes('build/' + EXCLUDE_ENTRY), false, 'never glued onto the previous line');
});
