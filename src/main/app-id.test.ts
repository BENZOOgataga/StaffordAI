/**
 * resolveAppId: the default holds unless a safe override is set, and anything that
 * could escape a directory or craft a pipe path is rejected back to the default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppId, DEFAULT_APP_ID } from './app-id.ts';

test('no override resolves to the default, not overridden', () => {
    const r = resolveAppId({});
    assert.equal(r.appId, DEFAULT_APP_ID);
    assert.equal(r.overridden, false);
});

test('a valid override is applied and flagged overridden', () => {
    const r = resolveAppId({ STAFFORD_APP_ID: 'StaffordVerify' });
    assert.equal(r.appId, 'StaffordVerify');
    assert.equal(r.overridden, true);
});

test('surrounding whitespace is trimmed', () => {
    assert.equal(resolveAppId({ STAFFORD_APP_ID: '  StaffordShot  ' }).appId, 'StaffordShot');
});

test('the safe token set covers dot, dash, underscore, and digits', () => {
    for (const id of ['Stafford-2', 'stafford_verify', 'run.7', 'ABC123']) {
        assert.equal(resolveAppId({ STAFFORD_APP_ID: id }).appId, id, id + ' is a safe token');
    }
});

test('an unsafe value falls back to the default rather than redirecting the store or pipe', () => {
    // A path separator, a pipe-breaking or namespace character, an empty string, and
    // an over-long value all fall back, so a malformed override cannot escape the
    // data dir or forge a pipe path.
    const unsafe = [
        '', '   ',
        'a/b', 'a\\b', '..', '../evil',
        '\\\\.\\pipe\\Stafford',
        'has space', 'name:colon', 'star*', 'quote"',
        'x'.repeat(65)
    ];
    for (const id of unsafe) {
        const r = resolveAppId({ STAFFORD_APP_ID: id });
        assert.equal(r.appId, DEFAULT_APP_ID, JSON.stringify(id) + ' rejected to default');
        assert.equal(r.overridden, false);
    }
});
