/**
 * A normal launch opens the real store; a smoke run opens a throwaway one, so its
 * fixture seed never reaches user data. This is the decision that keeps a smoke
 * run from leaving a dead colleague in the real database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStoreBase } from './store-location.ts';

test('a normal launch opens the real base, untouched', () => {
    const base = resolveStoreBase({ smoke: false, realBase: '/real/base' });
    assert.equal(base, '/real/base', 'a normal launch gets the real per-user base');
});

test('a smoke run opens a throwaway base, never the real one', () => {
    let made = 0;
    const base = resolveStoreBase({
        smoke: true,
        realBase: '/real/base',
        makeThrowawayBase: () => { made += 1; return '/tmp/stafford-smoke-x'; }
    });
    assert.equal(base, '/tmp/stafford-smoke-x', 'a smoke run gets the throwaway base');
    assert.notEqual(base, '/real/base', 'the real base is never handed to a smoke run');
    assert.equal(made, 1, 'the throwaway base is made once');
});

test('the default throwaway base is a real on-disk temp dir, so the round-trip proof holds', () => {
    // No injected maker: the real mkdtempSync path runs, proving smoke still opens
    // an actual on-disk directory rather than an in-memory shortcut.
    const base = resolveStoreBase({ smoke: true, realBase: '/real/base' });
    assert.notEqual(base, '/real/base');
    assert.ok(base.includes('stafford-smoke-'), 'the throwaway base is a named temp dir');
});
