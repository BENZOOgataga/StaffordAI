/**
 * Pre-trust is directory-trust, scoped to one directory, and never a permission
 * blanket. It sets exactly `hasTrustDialogAccepted` on the one project key, leaves
 * every other project and field alone, creates a minimal config when none exists,
 * and refuses to overwrite a config it cannot parse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { preTrustDirectory, TRUST_FIELD, type PreTrustDeps } from './pre-trust.ts';

function harness(initial: string | null) {
    const files = new Map<string, string>();
    if (initial !== null) files.set('/config', initial);
    let wrote = 0;
    const deps: PreTrustDeps = {
        configPath: '/config',
        readFile: (p) => {
            const v = files.get(p);
            if (v === undefined) throw new Error('ENOENT');
            return v;
        },
        writeFile: (p, data) => { files.set(p, data); wrote += 1; },
        // The real derivation is realpath + backslash-to-forward; here the key is
        // the dir verbatim, which is all these tests need to exercise the scope.
        resolveKey: (dir) => dir.replace(/\\/g, '/')
    };
    return { deps, files, writes: () => wrote };
}

test('it trusts exactly the one directory and writes only hasTrustDialogAccepted', () => {
    const { deps, files } = harness(JSON.stringify({ projects: {} }));
    preTrustDirectory(deps, 'C:/Users/me/repo');
    const config = JSON.parse(files.get('/config') as string);
    assert.deepEqual(config.projects['C:/Users/me/repo'], { [TRUST_FIELD]: true });
    // The only key touched is the one directory.
    assert.deepEqual(Object.keys(config.projects), ['C:/Users/me/repo']);
});

test('it never writes a permission-blanket field, only the trust flag', () => {
    const { deps, files } = harness(JSON.stringify({ projects: {} }));
    preTrustDirectory(deps, '/home/me/repo');
    const serialised = files.get('/config') as string;
    // None of the skip-all shapes may appear anywhere in what was written.
    for (const banned of ['dangerouslySkip', 'skipPermissions', 'permissionMode', 'bypassPermissions']) {
        assert.equal(serialised.includes(banned), false, 'must not write ' + banned);
    }
    const entry = JSON.parse(serialised).projects['/home/me/repo'];
    assert.deepEqual(Object.keys(entry), [TRUST_FIELD], 'only the trust flag is set');
});

test('it preserves every other project and every other field on the trusted one', () => {
    const { deps, files } = harness(JSON.stringify({
        someTopLevel: 'keep',
        projects: {
            '/other/repo': { hasTrustDialogAccepted: true, allowedTools: ['Read'] },
            '/home/me/repo': { allowedTools: ['Read'], mcpServers: {}, hasTrustDialogAccepted: false }
        }
    }));
    preTrustDirectory(deps, '/home/me/repo');
    const config = JSON.parse(files.get('/config') as string);
    assert.equal(config.someTopLevel, 'keep', 'top-level settings are preserved');
    assert.deepEqual(config.projects['/other/repo'], { hasTrustDialogAccepted: true, allowedTools: ['Read'] },
        'another project is untouched');
    assert.equal(config.projects['/home/me/repo'].hasTrustDialogAccepted, true, 'the flag flips to true');
    assert.deepEqual(config.projects['/home/me/repo'].allowedTools, ['Read'], 'its other fields survive');
    assert.deepEqual(config.projects['/home/me/repo'].mcpServers, {}, 'its other fields survive');
});

test('a missing config is created minimally with just the trusted directory', () => {
    const { deps, files } = harness(null);
    preTrustDirectory(deps, '/home/me/repo');
    const config = JSON.parse(files.get('/config') as string);
    assert.deepEqual(config, { projects: { '/home/me/repo': { [TRUST_FIELD]: true } } });
});

test('a malformed config is left untouched, never overwritten', () => {
    const { deps, files, writes } = harness('{ this is not json');
    let warned = '';
    preTrustDirectory({ ...deps, warn: (m) => { warned = m; } }, '/home/me/repo');
    assert.equal(files.get('/config'), '{ this is not json', 'the unparseable config is unchanged');
    assert.equal(writes(), 0, 'nothing was written');
    assert.match(warned, /not valid JSON/);
});

test('an already-trusted directory is not rewritten', () => {
    const { deps, writes } = harness(JSON.stringify({
        projects: { '/home/me/repo': { hasTrustDialogAccepted: true } }
    }));
    preTrustDirectory(deps, '/home/me/repo');
    assert.equal(writes(), 0, 'no rewrite when the flag is already set');
});
