import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isInvokeChannel, isEventChannel, INVOKE_CHANNELS, EVENT_CHANNELS } from './ipc.ts';

test('the channel allowlist is an exact set, not a prefix pattern', () => {
    assert.equal(isInvokeChannel('health'), true);
    assert.equal(isInvokeChannel('proof:spawn'), true);

    // A name that merely starts like an allowed one is refused. The list is
    // exhaustive, not a prefix.
    assert.equal(isInvokeChannel('health:secret'), false);
    assert.equal(isInvokeChannel('proof:'), false);
    assert.equal(isInvokeChannel(''), false);
    assert.equal(isInvokeChannel(42), false);
});

test('invoke and event channels are disjoint', () => {
    for (const name of INVOKE_CHANNELS) {
        assert.equal(isEventChannel(name), false, name + ' is an invoke channel, not an event one');
    }
    for (const name of EVENT_CHANNELS) {
        assert.equal(isInvokeChannel(name), false, name + ' is an event channel, not an invoke one');
    }
});

test('@electron/remote is not a dependency, in package.json or the lockfile', () => {
    // Existence assertion: @electron/remote reintroduces the very coupling the
    // security model removes, so it must be absent, not merely unused.
    const root = new URL('../../', import.meta.url);
    const pkg = readFileSync(new URL('package.json', root), 'utf8');
    const lock = readFileSync(new URL('package-lock.json', root), 'utf8');
    assert.doesNotMatch(pkg, /@electron\/remote/, 'package.json must not list @electron/remote');
    assert.doesNotMatch(lock, /@electron\/remote/, 'the lockfile must not resolve @electron/remote');
});
