import test from 'node:test';
import assert from 'node:assert/strict';
import {
    toolCategory, defaultCategoryDefaults, defaultBaselineRules,
    SECRET_FILE_GLOBS, SECRET_FILE_EXCEPTIONS, secretFileScopes, exceptionFileScopes,
    nativeReadFloorDeny, loosensSecretRead
} from './permission-profile.ts';
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

test('the native read floor is the secret globs, then the template negations after them', () => {
    const deny = nativeReadFloorDeny();
    // Deny entries first, straight from SECRET_FILE_GLOBS, then a gitignore-style negation per template
    // exception. Order matters: the negation only re-includes a file if it comes after the broad deny.
    assert.deepEqual(deny, [
        ...SECRET_FILE_GLOBS.map((g) => 'Read(' + g + ')'),
        ...SECRET_FILE_EXCEPTIONS.map((n) => 'Read(!' + n + ')')
    ]);
    // Every negation sits after every deny, so none is ordered ahead of the pattern it lifts out of.
    const firstNeg = deny.findIndex((d) => d.startsWith('Read(!'));
    const lastDeny = deny.map((d) => !d.startsWith('Read(!')).lastIndexOf(true);
    assert.ok(firstNeg > lastDeny, 'negations come after the deny entries');
});

test('the read floor, the write floor, and the native floor derive from the same lists, so they cannot diverge', () => {
    const repoRoot = '/proj';
    const scopes = secretFileScopes(repoRoot);
    assert.deepEqual(scopes, SECRET_FILE_GLOBS.map((g) => repoRoot + '/**/' + g));

    const rules = defaultBaselineRules({ repoRoot, writePaths: null, protectedPaths: [] });
    const gateScopes = (action: 'read' | 'write', effect: 'deny' | 'allow'): string[] =>
        rules.filter((r) => r.action === action && r.effect === effect && r.pathScope !== null)
            .map((r) => r.pathScope as string);
    // The gate's read-deny and write-deny secret scopes are exactly secretFileScopes.
    for (const s of scopes) {
        assert.ok(gateScopes('read', 'deny').includes(s), 'gate read floor covers ' + s);
        assert.ok(gateScopes('write', 'deny').includes(s), 'gate write floor covers ' + s);
    }
    // The gate's template allow scopes are exactly exceptionFileScopes, the same list the native
    // negations and the write-path refusal read, so the carve-out cannot disagree across the four.
    for (const s of exceptionFileScopes(repoRoot)) {
        assert.ok(gateScopes('read', 'allow').includes(s), 'gate read exception covers ' + s);
        assert.ok(gateScopes('write', 'allow').includes(s), 'gate write exception covers ' + s);
    }
    const nativeDenyGlobs = nativeReadFloorDeny().filter((d) => !d.startsWith('Read(!')).map((d) => d.slice('Read('.length, -1));
    const nativeNegGlobs = nativeReadFloorDeny().filter((d) => d.startsWith('Read(!')).map((d) => d.slice('Read(!'.length, -1));
    assert.deepEqual(nativeDenyGlobs, [...SECRET_FILE_GLOBS]);
    assert.deepEqual(nativeNegGlobs, [...SECRET_FILE_EXCEPTIONS]);
});

test('a template file is readable and writable, a real secret is not, at the root and nested', () => {
    const rules = defaultBaselineRules({ repoRoot: '/proj', writePaths: null, protectedPaths: [] });
    // The templates read and write, at the project root and a level down.
    for (const p of ['/proj/.env.example', '/proj/sub/.env.example', '/proj/.env.sample', '/proj/pkg/.env.dist', '/proj/.env.template']) {
        assert.equal(resolveWith(rules, 'read', p), 'allow', p + ' template should read');
        assert.equal(resolveWith(rules, 'write', p), 'allow', p + ' template should write');
    }
    // The real secrets stay denied, so the carve-out did not widen the family.
    for (const p of ['/proj/.env', '/proj/.env.production', '/proj/.env.local', '/proj/sub/.env', '/proj/.env.production.local']) {
        assert.equal(resolveWith(rules, 'read', p), 'deny', p + ' secret should stay denied');
    }
});

test('loosensSecretRead flags a read moving a real secret off deny, but not a template', () => {
    const scope = '/proj/**/.env';
    assert.equal(loosensSecretRead({ action: 'read', pathScope: scope, effect: 'allow' }), true);
    assert.equal(loosensSecretRead({ action: 'read', pathScope: scope, effect: 'ask' }), true);
    // Tightening to deny is fine, so is the write floor, an ordinary path, or a category rule.
    assert.equal(loosensSecretRead({ action: 'read', pathScope: scope, effect: 'deny' }), false);
    assert.equal(loosensSecretRead({ action: 'write', pathScope: scope, effect: 'allow' }), false);
    assert.equal(loosensSecretRead({ action: 'read', pathScope: '/proj/src', effect: 'allow' }), false);
    assert.equal(loosensSecretRead({ action: 'read', pathScope: null, effect: 'allow' }), false);
    assert.equal(loosensSecretRead({ action: 'read', pathScope: 'C:/Users/you/proj/**/id_rsa', effect: 'ask' }), true);
    for (const g of SECRET_FILE_GLOBS) {
        assert.equal(loosensSecretRead({ action: 'read', pathScope: '/p/**/' + g, effect: 'allow' }), true, g);
    }
    // A template is not a secret, so loosening its read is a normal edit, never refused.
    for (const n of SECRET_FILE_EXCEPTIONS) {
        assert.equal(loosensSecretRead({ action: 'read', pathScope: '/p/**/' + n, effect: 'allow' }), false, n);
    }
});
