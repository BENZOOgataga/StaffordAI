import test from 'node:test';
import assert from 'node:assert/strict';
import { toolCategory, defaultCategoryDefaults, defaultBaselineRules } from './permission-profile.ts';
import { resolvePermission, type PermissionRequest } from './permissions.ts';

test('tool names map to the right categories, unknown tools fall to other', () => {
    for (const t of ['Read', 'LS', 'Glob', 'Grep']) assert.equal(toolCategory(t), 'read', t);
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(toolCategory(t), 'write', t);
    for (const t of ['Bash', 'PowerShell']) assert.equal(toolCategory(t), 'shell', t);
    for (const t of ['WebFetch', 'WebSearch']) assert.equal(toolCategory(t), 'fetch', t);
    assert.equal(toolCategory('Task'), 'delegate');
    assert.equal(toolCategory('TodoWrite'), 'other');
    assert.equal(toolCategory('mcp__github__create_issue'), 'other');
    assert.equal(toolCategory('SomeFutureTool'), 'other');
});

test('the default profile allows normal work and denies the protected config paths', () => {
    const defaults = defaultCategoryDefaults(true);
    const rules = defaultBaselineRules({
        repoRoot: '/proj',
        writePaths: null,
        protectedPaths: ['/userdata/Stafford']
    });
    const req = (action: PermissionRequest['action'], path: string | null, command: string | null = null): PermissionRequest =>
        ({ action, path, command });

    // normal work
    assert.equal(resolvePermission(rules, req('read', '/proj/src/main.ts'), defaults), 'allow');
    assert.equal(resolvePermission(rules, req('write', '/proj/src/main.ts'), defaults), 'allow');
    assert.equal(resolvePermission(rules, req('shell', null, 'npm test'), defaults), 'allow');
    assert.equal(resolvePermission(rules, req('fetch', null, null), defaults), 'allow'); // allowWebFetch true
    assert.equal(resolvePermission(rules, req('delegate', null, null), defaults), 'allow');

    // the security invariant: the config store cannot be read or written
    assert.equal(resolvePermission(rules, req('read', '/userdata/Stafford/stafford.db'), defaults), 'deny');
    assert.equal(resolvePermission(rules, req('write', '/userdata/Stafford/stafford.db'), defaults), 'deny');

    // destructive shell asks
    assert.equal(resolvePermission(rules, req('shell', null, 'git push --force origin main'), defaults), 'ask');
    assert.equal(resolvePermission(rules, req('shell', null, 'rm -rf build'), defaults), 'ask');

    // unknown tool category defaults to ask
    assert.equal(resolvePermission(rules, req('other', null, null), defaults), 'ask');
});

test('write outside the allowed scope denies; a set writePaths narrows the scope', () => {
    const defaults = defaultCategoryDefaults(false);
    const rules = defaultBaselineRules({ repoRoot: '/proj', writePaths: ['/proj/src'], protectedPaths: [] });
    assert.equal(resolvePermission(rules, { action: 'write', path: '/proj/src/a.ts', command: null }, defaults), 'allow');
    assert.equal(resolvePermission(rules, { action: 'write', path: '/proj/docs/a.md', command: null }, defaults), 'deny');
    // fetch defaults to ask when allowWebFetch is false
    assert.equal(resolvePermission(rules, { action: 'fetch', path: null, command: null }, defaults), 'ask');
});
