/**
 * The pure timeline rendering: an event localizes from its state enum, a reference
 * shows when present, and a waiting event carries the weight the roster gives
 * waiting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { eventLabel, referenceLabel, channelRowClass, Timeline } from './channel-view.ts';
import type { ChannelMessageRow } from '../shared/ipc.ts';

function row(id: string, at: string): ChannelMessageRow {
    return { id, projectId: 'p1', senderId: 'h1', kind: 'message', body: 'hi', reference: null, at };
}

test('an event localizes from the enum: the same state renders differently in two languages', () => {
    const en = eventLabel('waiting_for_you', 'Marion', 'en');
    const fr = eventLabel('waiting_for_you', 'Marion', 'fr');
    assert.equal(en, 'Marion is waiting for you');
    assert.notEqual(en, fr, 'the same enum produces different text per language');
    assert.ok(fr.startsWith('Marion '), 'the colleague name is prefixed in both');
});

test('eventLabel maps the enum to text, it does not read a phrase from the row', () => {
    // Given only the enum and a name, it produces the phrase. There is no English
    // string on the row for it to echo.
    assert.equal(eventLabel('crashed', 'Theo', 'en'), 'Theo crashed');
    assert.equal(eventLabel('rate_limited', 'Nadia', 'en'), 'Nadia is rate limited');
});

test('an unknown state falls back rather than rendering nothing', () => {
    assert.equal(eventLabel('some_new_state', 'Marion', 'en'), 'Marion some_new_state');
});

test('a reference renders its label; no reference renders nothing', () => {
    assert.equal(referenceLabel({ kind: 'task', value: 't1' }), 'task t1');
    assert.equal(referenceLabel({ kind: 'commit', value: 'abc123' }), 'commit abc123');
    assert.equal(referenceLabel({ kind: 'file', value: 'src/main/index.ts' }), 'file src/main/index.ts');
    assert.equal(referenceLabel(null), null);
});

test('a waiting event carries the weight the roster gives waiting; a message and other events do not', () => {
    assert.equal(channelRowClass('event', 'waiting_for_you'), 'row event waiting');
    assert.equal(channelRowClass('event', 'crashed'), 'row event');
    assert.equal(channelRowClass('message', 'hello'), 'row message');
});

test('the timeline appends the tail without dropping or re-fetching what it holds', () => {
    const t = new Timeline();
    t.setInitial([row('a', '2026-08-13T00:00:00Z'), row('b', '2026-08-13T00:00:01Z')]);
    assert.deepEqual(t.newestCursor(), { at: '2026-08-13T00:00:01Z', id: 'b' }, 'the tail cursor is the newest row');

    const added = t.appendTail([row('c', '2026-08-13T00:00:02Z')]);
    assert.deepEqual(t.rows.map((r) => r.id), ['a', 'b', 'c'], 'the new row is appended, the held rows untouched');
    assert.deepEqual(added.map((r) => r.id), ['c']);
});

test('appending a row already held does not duplicate it', () => {
    const t = new Timeline();
    t.setInitial([row('a', '2026-08-13T00:00:00Z')]);
    const added = t.appendTail([row('a', '2026-08-13T00:00:00Z')]);
    assert.deepEqual(t.rows.map((r) => r.id), ['a'], 'no duplicate');
    assert.equal(added.length, 0);
});

test('scroll-back prepends older rows and the tail cursor is unchanged', () => {
    const t = new Timeline();
    t.setInitial([row('b', '2026-08-13T00:00:01Z'), row('c', '2026-08-13T00:00:02Z')]);
    assert.deepEqual(t.oldestCursor(), { at: '2026-08-13T00:00:01Z', id: 'b' }, 'the scroll-back cursor is the oldest row');

    t.prependOlder([row('a', '2026-08-13T00:00:00Z')]);
    assert.deepEqual(t.rows.map((r) => r.id), ['a', 'b', 'c'], 'older rows go to the front');
    assert.deepEqual(t.newestCursor(), { at: '2026-08-13T00:00:02Z', id: 'c' }, 'the tail is untouched');
});
