import test from 'node:test';
import assert from 'node:assert/strict';
import { toolCategory, defaultCategoryDefaults, defaultBaselineRules } from './permission-profile.ts';
import { resolvePermission, effectiveRules, type PermissionRequest, type PermissionRule } from './permissions.ts';

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

// --- default secret rules ---------------------------------------------------
//
// Read defaults to allow, which is right (a colleague that cannot read cannot work) and is
// exactly why these exist: without them every file in the project is readable, including the
// one file whose whole purpose is to hold a credential.

const PROFILE_INPUT = { repoRoot: '/proj', writePaths: null, protectedPaths: ['/userdata'] };

function resolveWith(rules: PermissionRule[], action: 'read' | 'write', p: string): string {
    return resolvePermission(rules, { action, path: p, command: null }, defaultCategoryDefaults(false));
}

test('a .env in the project is denied for read, despite read defaulting to allow', () => {
    const rules = defaultBaselineRules(PROFILE_INPUT);
    assert.equal(resolveWith(rules, 'read', '/proj/.env'), 'deny');
    assert.equal(resolveWith(rules, 'read', '/proj/src/.env'), 'deny', 'nested too, not just at the root');
    assert.equal(resolveWith(rules, 'read', '/proj/.env.production'), 'deny');
});

test('a secret file is denied for write as well as read', () => {
    const rules = defaultBaselineRules(PROFILE_INPUT);
    // The repo is writable by default, so the secret deny has to beat that broad allow.
    assert.equal(resolveWith(rules, 'write', '/proj/src/a.ts'), 'allow');
    assert.equal(resolveWith(rules, 'write', '/proj/.env'), 'deny');
    assert.equal(resolveWith(rules, 'write', '/proj/certs/server.key'), 'deny');
});

test('keys and credential files are covered, wherever they sit in the project', () => {
    const rules = defaultBaselineRules(PROFILE_INPUT);
    for (const p of [
        '/proj/certs/server.pem', '/proj/deep/nested/id_rsa', '/proj/.npmrc',
        '/proj/a/b/c/id_ed25519', '/proj/.netrc', '/proj/sub/credentials.json'
    ]) {
        assert.equal(resolveWith(rules, 'read', p), 'deny', p + ' should be denied');
    }
});

test('ordinary project files are untouched, so normal work still runs', () => {
    const rules = defaultBaselineRules(PROFILE_INPUT);
    for (const p of ['/proj/src/index.ts', '/proj/README.md', '/proj/package.json', '/proj/environment.ts']) {
        assert.equal(resolveWith(rules, 'read', p), 'allow', p + ' should stay readable');
    }
    // The trap this one guards: `.environment` ends in neither `.env` nor `.env.*`, and a
    // sloppy pattern would swallow it.
    assert.equal(resolveWith(rules, 'read', '/proj/src/.environment'), 'allow');
});

test('the secret denies are scoped to the project, not to every path on the machine', () => {
    const rules = defaultBaselineRules(PROFILE_INPUT);
    assert.equal(resolveWith(rules, 'read', '/somewhere-else/.env'), 'allow',
        'a rule that says .env means this project. Another repo is not this project.');
});

test('a stored baseline rule can override a secret deny, since it is my machine', () => {
    // Same action and scope as the generated rule, which is how effectiveRules layers.
    const generated = defaultBaselineRules(PROFILE_INPUT);
    const mine: PermissionRule = {
        action: 'read', pathScope: '/proj/**/.env.*', commandPattern: null, effect: 'allow'
    };
    const merged = effectiveRules(generated, [mine]);
    assert.equal(resolveWith(merged, 'read', '/proj/.env.example'), 'allow',
        'the template case: I can put it back in one edit');
    assert.equal(resolveWith(merged, 'read', '/proj/.env'), 'deny',
        'and overriding the template pattern does not reopen the real one');
});
