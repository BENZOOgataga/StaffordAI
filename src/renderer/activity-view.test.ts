/**
 * The Activity feed's pure logic: scoping to one colleague's stored events, the
 * append seam that adds only new rows, the icon per event type, and the localized
 * de-emphasized timestamp. No DOM, so this runs under node:test directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { activityRows, unseenRows, activityIcon, activityRowClass, activityTime } from './activity-view.ts';
import { eventLabel } from './channel-view.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow } from '../shared/ipc.ts';

function event(id: string, senderId: string, body: string, at = '2026-08-18T12:00:00Z'): ChannelMessageRow {
    return { id, projectId: 'p1', senderId, kind: 'event', body, reference: null, at };
}
function message(id: string, senderId: string, body: string): ChannelMessageRow {
    return { id, projectId: 'p1', senderId, kind: 'message', body, reference: null, at: '2026-08-18T12:00:00Z' };
}

const NOW = Date.parse('2026-08-18T12:00:00Z');

test('activityRows keeps only this colleague\'s event rows, in order', () => {
    const rows = [
        event('e1', 'marion', 'crashed', '2026-08-18T11:00:00Z'),
        message('m1', 'marion', 'hello'),               // a message is not an activity row
        event('e2', 'theo', 'waiting_for_you'),          // another colleague
        message('m2', CHANNEL_SELF_SENDER, 'you there?'), // the person's own message
        event('e3', 'marion', 'waiting_for_you', '2026-08-18T11:30:00Z')
    ];
    const out = activityRows(rows, 'marion');
    assert.deepEqual(out.map((r) => r.id), ['e1', 'e3']);
});

test('activityRows renders no stub row: with no events for the colleague it is empty', () => {
    const rows = [message('m1', 'marion', 'hi'), event('e1', 'theo', 'crashed')];
    assert.equal(activityRows(rows, 'marion').length, 0);
});

test('unseenRows appends only rows whose id is new, preserving order', () => {
    const seen = new Set(['e1', 'e2']);
    const rows = [event('e1', 'marion', 'crashed'), event('e2', 'marion', 'rate_limited'), event('e3', 'marion', 'waiting_for_you')];
    const fresh = unseenRows(seen, rows);
    assert.deepEqual(fresh.map((r) => r.id), ['e3']);
});

test('unseenRows returns nothing when a burst carries only rows already shown', () => {
    const seen = new Set(['e1', 'e2', 'e3']);
    const rows = [event('e1', 'marion', 'crashed'), event('e2', 'marion', 'rate_limited'), event('e3', 'marion', 'waiting_for_you')];
    assert.equal(unseenRows(seen, rows).length, 0);
});

test('activityIcon maps each real state and falls back for an unknown one', () => {
    assert.equal(activityIcon('waiting_for_you'), 'waiting');
    assert.equal(activityIcon('crashed'), 'crashed');
    assert.equal(activityIcon('needs_trust'), 'needs_trust');
    assert.equal(activityIcon('rate_limited'), 'rate_limited');
    assert.equal(activityIcon('something_new'), 'event');
});

test('activityRowClass carries amber only for waiting', () => {
    assert.equal(activityRowClass('waiting_for_you'), 'act-row waiting');
    assert.equal(activityRowClass('crashed'), 'act-row');
    assert.equal(activityRowClass('rate_limited'), 'act-row');
});

test('the row line is localized from the enum, not hardcoded English', () => {
    // The feed reuses the channel's enum-to-phrase map, so the same event reads per
    // language and flexes for the longer translated text.
    assert.equal(eventLabel('waiting_for_you', 'Marion', 'en'), 'Marion is waiting for you');
    assert.equal(eventLabel('waiting_for_you', 'Marion', 'fr'), 'Marion attend ta réponse');
    assert.notEqual(eventLabel('crashed', 'Marion', 'fr'), eventLabel('crashed', 'Marion', 'en'));
});

test('activityTime is relative when recent, absolute once older, and localized', () => {
    assert.equal(activityTime('2026-08-18T11:59:30Z', NOW, 'en'), 'now');
    assert.equal(activityTime('2026-08-18T11:59:30Z', NOW, 'fr'), "à l'instant");
    assert.equal(activityTime('2026-08-18T11:45:00Z', NOW, 'en'), '15m');
    assert.equal(activityTime('2026-08-18T09:00:00Z', NOW, 'en'), '3h');
    assert.equal(activityTime('2026-08-14T09:00:00Z', NOW, 'en'), 'Aug 14');
    assert.equal(activityTime('2026-08-14T09:00:00Z', NOW, 'fr'), '14 août');
    assert.equal(activityTime('not-a-date', NOW, 'en'), '');
});
