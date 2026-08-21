/**
 * The effective-policy view: what applies to a colleague, and why.
 *
 * The screen this feeds exists to answer a question a list of rules cannot, so the thing
 * worth testing is not that rules are listed but that the explanation agrees with the gate.
 * Every case below therefore checks the attribution AND the effect, because a view that says
 * "override wins" while the gate allows is worse than no view at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePolicy, explain, ruleKey, widensProtectedAccess, type EffectiveRule } from './effective-policy.ts';
import { resolvePermission, type PermissionRule, type CategoryDefaults } from './permissions.ts';

const DEFAULTS: CategoryDefaults = {
    read: 'allow', write: 'deny', shell: 'ask', fetch: 'deny', delegate: 'ask', other: 'ask'
};

const rule = (
    action: PermissionRule['action'], pathScope: string | null, effect: PermissionRule['effect'],
    commandPattern: string | null = null
): PermissionRule => ({ action, pathScope, commandPattern, effect });

const find = (rows: EffectiveRule[], action: string, scope: string | null): EffectiveRule | undefined =>
    rows.find((r) => r.action === action && r.pathScope === scope);

test('a baseline rule with no override is attributed to the baseline', () => {
    const rows = effectivePolicy({
        baseline: [rule('write', '/proj/src', 'allow')], overrides: [], defaults: DEFAULTS
    });
    const row = find(rows, 'write', '/proj/src');
    assert.equal(row?.source, 'baseline');
    assert.equal(row?.overridesBaseline, false);
    assert.equal(row?.replacedEffect, null);
});

test('an override on the SAME scope replaces the baseline, and says what it replaced', () => {
    const rows = effectivePolicy({
        baseline: [rule('write', '/proj/src', 'allow')],
        overrides: [rule('write', '/proj/src', 'deny')],
        defaults: DEFAULTS
    });
    const row = find(rows, 'write', '/proj/src');
    assert.equal(row?.effect, 'deny', 'the override is what applies');
    assert.equal(row?.source, 'override');
    assert.equal(row?.overridesBaseline, true);
    assert.equal(row?.replacedEffect, 'allow', 'the screen must be able to say what it replaced');
});

test('an override on a NEW scope adds a rule and is not badged as overriding anything', () => {
    const rows = effectivePolicy({
        baseline: [rule('write', '/proj/src', 'allow')],
        overrides: [rule('write', '/proj/docs', 'allow')],
        defaults: DEFAULTS
    });
    const added = find(rows, 'write', '/proj/docs');
    assert.equal(added?.source, 'override');
    assert.equal(added?.overridesBaseline, false,
        'an addition is not an override of anything, and badging it as one would mislead on half the rows');
    assert.equal(find(rows, 'write', '/proj/src')?.source, 'baseline', 'the baseline rule survives');
});

test('a generated default-profile rule is attributed to the profile, not to something I wrote', () => {
    const profileRule = rule('read', '/userdata', 'deny');
    const rows = effectivePolicy({
        baseline: [profileRule, rule('write', '/proj/src', 'allow')],
        overrides: [],
        profileKeys: new Set([ruleKey(profileRule)]),
        defaults: DEFAULTS
    });
    assert.equal(find(rows, 'read', '/userdata')?.source, 'default-profile');
    assert.equal(find(rows, 'write', '/proj/src')?.source, 'baseline');
});

test('the explanation agrees with the resolver, which is the only reason to trust the screen', () => {
    const baseline = [rule('write', '/proj/src', 'allow'), rule('write', '/proj/src/secrets', 'deny')];
    const rows = effectivePolicy({ baseline, overrides: [], defaults: DEFAULTS });

    for (const [p, expected] of [['/proj/src/a.ts', 'allow'], ['/proj/src/secrets/k', 'deny']] as const) {
        const request = { action: 'write' as const, path: p, command: null };
        const e = explain(rows, request, DEFAULTS);
        assert.equal(e.effect, expected);
        assert.equal(e.effect, resolvePermission(baseline, request, DEFAULTS),
            'the view and the gate must never disagree about ' + p);
    }
});

test('the explanation names the most specific rule as the decider', () => {
    const rows = effectivePolicy({
        baseline: [rule('write', '/proj/src', 'allow'), rule('write', '/proj/src/secrets', 'deny')],
        overrides: [], defaults: DEFAULTS
    });
    const e = explain(rows, { action: 'write', path: '/proj/src/secrets/k', command: null }, DEFAULTS);
    assert.equal(e.decidedBy?.pathScope, '/proj/src/secrets');
    assert.equal(e.fromDefault, false);
});

test('when nothing matches, the explanation says the category default decided', () => {
    const rows = effectivePolicy({ baseline: [rule('write', '/proj/src', 'allow')], overrides: [], defaults: DEFAULTS });
    const e = explain(rows, { action: 'fetch', path: null, command: null }, DEFAULTS);
    assert.equal(e.fromDefault, true);
    assert.equal(e.decidedBy, null);
    assert.equal(e.effect, 'deny', 'the fetch default, never a silent allow');
});

test('deny beats ask beats allow on a specificity tie, in the explanation too', () => {
    const rows = effectivePolicy({
        baseline: [rule('read', '/proj/x', 'allow'), rule('read', '/proj/x', 'deny')],
        overrides: [], defaults: DEFAULTS
    });
    const e = explain(rows, { action: 'read', path: '/proj/x/f', command: null }, DEFAULTS);
    assert.equal(e.effect, 'deny');
});

test('a command-pattern rule is shown and explains a shell ask', () => {
    const rows = effectivePolicy({
        baseline: [rule('shell', null, 'ask', 'git\\s+push\\s+--force')], overrides: [], defaults: DEFAULTS
    });
    const e = explain(rows, { action: 'shell', path: null, command: 'git push --force origin main' }, DEFAULTS);
    assert.equal(e.effect, 'ask');
    assert.equal(e.decidedBy?.commandPattern, 'git\\s+push\\s+--force',
        'a shell command resolving to ask must be explainable, or it reads as unexplained');
});

test('rows are ordered most specific first inside an action, so a narrow rule sits under the broad one', () => {
    const rows = effectivePolicy({
        baseline: [rule('write', '/proj', 'allow'), rule('write', '/proj/src/deep/here', 'deny'), rule('write', '/proj/src', 'ask')],
        overrides: [], defaults: DEFAULTS
    });
    const scopes = rows.filter((r) => r.action === 'write').map((r) => r.pathScope);
    assert.deepEqual(scopes, ['/proj/src/deep/here', '/proj/src', '/proj']);
});

// --- the edit warning ------------------------------------------------------

test('allowing a colleague into a protected path is flagged', () => {
    const protectedPaths = ['/userdata'];
    assert.equal(widensProtectedAccess(rule('read', '/userdata', 'allow'), protectedPaths), true);
    assert.equal(widensProtectedAccess(rule('write', '/userdata/claude-config', 'allow'), protectedPaths), true,
        'a scope inside the protected directory widens access to it');
    assert.equal(widensProtectedAccess(rule('read', '/', 'allow'), protectedPaths), true,
        'a scope that contains the protected directory widens access to it');
});

test('an ask into a protected path is flagged too, since ask can be approved', () => {
    assert.equal(widensProtectedAccess(rule('read', '/userdata', 'ask'), ['/userdata']), true);
});

test('a deny is never flagged, and an unrelated allow is not either', () => {
    assert.equal(widensProtectedAccess(rule('read', '/userdata', 'deny'), ['/userdata']), false);
    assert.equal(widensProtectedAccess(rule('write', '/proj/src', 'allow'), ['/userdata']), false);
});

test('a category-wide read or write allow is flagged, since it competes with the protecting deny', () => {
    assert.equal(widensProtectedAccess(rule('read', null, 'allow'), ['/userdata']), true);
    assert.equal(widensProtectedAccess(rule('write', null, 'allow'), ['/userdata']), true);
    assert.equal(widensProtectedAccess(rule('fetch', null, 'allow'), ['/userdata']), false,
        'fetch cannot reach a path, so it is not a protected-path concern');
});
