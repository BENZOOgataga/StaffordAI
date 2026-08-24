/**
 * Editing a default-profile rule, and the proof that agent scope and all scope actually differ.
 *
 * The confirm gate and the add-versus-update choice are the small decisions the edit UI makes, so
 * they are pinned here. The harder claim, that an agent-scope edit changes only the edited
 * colleague while an all-scope edit changes every colleague, is proved against the real resolver
 * the gate uses, composed exactly the way the main process composes it, so the test cannot pass
 * while the gate would disagree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { needsLoosenConfirm, targetHireId, findStoredRuleId } from './default-edit.ts';
import type { PermissionRuleView } from '../../shared/ipc.ts';
import { defaultBaselineRules, defaultCategoryDefaults } from '../../domain/permission-profile.ts';
import { resolvePermission, type PermissionRule } from '../../domain/permissions.ts';
import { effectiveRules } from '../../domain/permissions.ts';

test('loosening a deny needs a confirm; keeping or tightening to deny does not', () => {
    assert.equal(needsLoosenConfirm('deny', 'allow'), true);
    assert.equal(needsLoosenConfirm('deny', 'ask'), true);
    assert.equal(needsLoosenConfirm('deny', 'deny'), false);
    assert.equal(needsLoosenConfirm('allow', 'deny'), false);
    assert.equal(needsLoosenConfirm('ask', 'deny'), false);
    assert.equal(needsLoosenConfirm('allow', 'ask'), false);
});

test('agent scope writes to the colleague, all scope writes to the baseline', () => {
    assert.equal(targetHireId('agent', 'marion'), 'marion');
    assert.equal(targetHireId('all', 'marion'), null);
});

function stored(over: Partial<PermissionRuleView> = {}): PermissionRuleView {
    return {
        id: 'x', hireId: null, action: 'read', pathScope: null, commandPattern: null,
        effect: 'allow', createdAt: '', ...over
    };
}

test('an existing stored rule at the same identity and level is found, so the edit updates not adds', () => {
    const rules: PermissionRuleView[] = [
        stored({ id: 'base', hireId: null, action: 'read', pathScope: '/proj/**/.env', effect: 'deny' }),
        stored({ id: 'mine', hireId: 'marion', action: 'read', pathScope: '/proj/**/.env', effect: 'ask' })
    ];
    assert.equal(findStoredRuleId(rules, { action: 'read', pathScope: '/proj/**/.env', hireId: null }), 'base');
    assert.equal(findStoredRuleId(rules, { action: 'read', pathScope: '/proj/**/.env', hireId: 'marion' }), 'mine');
    // A genuine default-profile row has no stored rule at its key: an add, not an update.
    assert.equal(findStoredRuleId(rules, { action: 'read', pathScope: '/proj/**/*.key', hireId: 'marion' }), null);
    // A command-pattern rule is never matched here; path edits only.
    const withPattern = [stored({ id: 'p', action: 'shell', pathScope: null, commandPattern: 'rm -rf', effect: 'ask' })];
    assert.equal(findStoredRuleId(withPattern, { action: 'shell', pathScope: null, hireId: null }), null);
});

// The scope proof. Composed the way `effectivePolicyFor` composes it in the main process: the
// generated default profile is part of the baseline, a colleague's overrides layer on top, and the
// same `resolvePermission` the gate calls decides the outcome.

const REPO = '/proj';
const PROFILE: PermissionRule[] = defaultBaselineRules({
    repoRoot: REPO, writePaths: null, protectedPaths: ['/userdata']
});
const DEFAULTS = defaultCategoryDefaults(false);
const SECRET = REPO + '/x/.env'; // a concrete path a default read-deny covers
const readEnv = { action: 'read' as const, path: SECRET, command: null };

function resolveFor(
    baselineStored: PermissionRule[], overrides: PermissionRule[]
): 'allow' | 'deny' | 'ask' {
    const rules = effectiveRules([...PROFILE, ...baselineStored], overrides);
    return resolvePermission(rules, readEnv, DEFAULTS);
}

test('with no stored rules the default profile denies reading a secret', () => {
    assert.equal(resolveFor([], []), 'deny');
});

test('an agent-scope edit changes only the edited colleague', () => {
    // Marion gets an override allowing the secret; a different colleague has none.
    const marionOverride: PermissionRule[] = [
        { action: 'read', pathScope: REPO + '/**/.env', commandPattern: null, effect: 'allow' }
    ];
    assert.equal(resolveFor([], marionOverride), 'allow', 'Marion now reads it');
    assert.equal(resolveFor([], []), 'deny', 'another colleague still cannot');
});

test('an all-scope edit changes every colleague', () => {
    // The same edit written to the baseline (hire id null) instead.
    const baselineEdit: PermissionRule[] = [
        { action: 'read', pathScope: REPO + '/**/.env', commandPattern: null, effect: 'allow' }
    ];
    assert.equal(resolveFor(baselineEdit, []), 'allow', 'the edited colleague reads it');
    // A colleague with no override of their own inherits the loosened baseline: also allow.
    assert.equal(resolveFor(baselineEdit, []), 'allow', 'a different colleague inherits it too');
});
