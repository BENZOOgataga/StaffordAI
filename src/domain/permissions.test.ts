import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolvePermission, effectiveRules,
    type PermissionRule, type PermissionRequest, type CategoryDefaults
} from './permissions.ts';

const DEFAULTS: CategoryDefaults = {
    read: 'allow', write: 'deny', shell: 'allow', fetch: 'ask', delegate: 'allow', other: 'ask'
};

function rule(action: PermissionRule['action'], pathScope: string | null, effect: PermissionRule['effect'], commandPattern: string | null = null): PermissionRule {
    return { action, pathScope, commandPattern, effect };
}
function readReq(path: string): PermissionRequest { return { action: 'read', path, command: null }; }
function writeReq(path: string): PermissionRequest { return { action: 'write', path, command: null }; }
function shellReq(command: string): PermissionRequest { return { action: 'shell', path: null, command }; }

test('no matching rule falls to the category default, never a silent allow', () => {
    assert.equal(resolvePermission([], writeReq('/proj/outside.txt'), DEFAULTS), 'deny');
    assert.equal(resolvePermission([], readReq('/proj/anything'), DEFAULTS), 'allow');
    assert.equal(resolvePermission([], { action: 'other', path: null, command: null }, DEFAULTS), 'ask');
});

test('deny override beats an allow baseline for the same scope (the worked example)', () => {
    const baseline = [rule('read', '/proj/src', 'allow')];
    const overrides = [rule('read', '/proj/src/secrets', 'deny')];
    const rules = effectiveRules(baseline, overrides);
    assert.equal(resolvePermission(rules, readReq('/proj/src/secrets/key.pem'), DEFAULTS), 'deny');
    // and a non-secret path under src still reads
    assert.equal(resolvePermission(rules, readReq('/proj/src/main.ts'), DEFAULTS), 'allow');
});

test('the most specific path match wins: a deeper deny beats a shallower allow', () => {
    const rules = [rule('read', '/proj/src', 'allow'), rule('read', '/proj/src/secrets', 'deny')];
    assert.equal(resolvePermission(rules, readReq('/proj/src/secrets/key'), DEFAULTS), 'deny');
    assert.equal(resolvePermission(rules, readReq('/proj/src/ok.ts'), DEFAULTS), 'allow');
});

test('on a specificity tie, deny beats ask beats allow', () => {
    assert.equal(resolvePermission([rule('read', '/proj/x', 'allow'), rule('read', '/proj/x', 'deny')], readReq('/proj/x/f'), DEFAULTS), 'deny');
    assert.equal(resolvePermission([rule('read', '/proj/x', 'allow'), rule('read', '/proj/x', 'ask')], readReq('/proj/x/f'), DEFAULTS), 'ask');
});

test('a resolved path outside the scope does not match, so traversal cannot widen scope', () => {
    // The caller resolves src/../outside to /proj/outside.txt before we see it.
    const rules = [rule('write', '/proj/src', 'allow')];
    assert.equal(resolvePermission(rules, writeReq('/proj/outside.txt'), DEFAULTS), 'deny');
    // and a sibling that merely shares a prefix is not inside the folder
    assert.equal(resolvePermission(rules, writeReq('/proj/src-other/f'), DEFAULTS), 'deny');
    // the real in-scope write allows
    assert.equal(resolvePermission(rules, writeReq('/proj/src/f.ts'), DEFAULTS), 'allow');
});

test('a baseline-only rule set resolves from the baseline', () => {
    const rules = effectiveRules([rule('write', '/proj', 'allow')], []);
    assert.equal(resolvePermission(rules, writeReq('/proj/a.ts'), DEFAULTS), 'allow');
});

test('an override can add a permission the baseline does not have', () => {
    const rules = effectiveRules([rule('write', '/proj/src', 'allow')], [rule('write', '/proj/docs', 'allow')]);
    assert.equal(resolvePermission(rules, writeReq('/proj/docs/x.md'), DEFAULTS), 'allow');
});

test('an override can remove a permission the baseline grants (deny for this colleague)', () => {
    const rules = effectiveRules([rule('read', '/proj', 'allow')], [rule('read', '/proj', 'deny')]);
    assert.equal(resolvePermission(rules, readReq('/proj/f'), DEFAULTS), 'deny');
});

test('a category-wide rule (no path) matches any request of its action', () => {
    assert.equal(resolvePermission([rule('read', null, 'deny')], readReq('/anywhere'), DEFAULTS), 'deny');
});

test('a glob scope matches by pattern', () => {
    assert.equal(resolvePermission([rule('read', '/proj/**/*.pem', 'deny')], readReq('/proj/src/secrets/key.pem'), DEFAULTS), 'deny');
    assert.equal(resolvePermission([rule('read', '/proj/**/*.pem', 'deny')], readReq('/proj/src/main.ts'), DEFAULTS), 'allow');
});

test('a shell command pattern matches a destructive command and beats the coarse default', () => {
    const rules = [rule('shell', null, 'deny', 'git\\s+push\\b[^\\n]*\\s(--force\\b|-f\\b)')];
    assert.equal(resolvePermission(rules, shellReq('git push --force origin main'), DEFAULTS), 'deny');
    // an ordinary command falls to the shell default (allow)
    assert.equal(resolvePermission(rules, shellReq('git status'), DEFAULTS), 'allow');
});

test('effectiveRules: an override with the same key replaces, a new key adds', () => {
    const baseline = [rule('read', '/proj', 'allow'), rule('write', '/proj/src', 'allow')];
    const overrides = [rule('read', '/proj', 'deny'), rule('write', '/proj/docs', 'allow')];
    const merged = effectiveRules(baseline, overrides);
    // read /proj replaced to deny, write /proj/src kept, write /proj/docs added
    assert.equal(merged.length, 3);
    assert.equal(resolvePermission(merged, readReq('/proj/f'), DEFAULTS), 'deny');
    assert.equal(resolvePermission(merged, writeReq('/proj/src/f'), DEFAULTS), 'allow');
    assert.equal(resolvePermission(merged, writeReq('/proj/docs/f'), DEFAULTS), 'allow');
});
