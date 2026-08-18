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

import {
    mergeFeed, unseenFeed, stateRowToFeed, activityRowToFeed, toolPhrase, toolStatusLabel,
    feedIcon, feedRowClass, type FeedRow
} from './activity-view.ts';
import type { ActivityRow } from '../shared/ipc.ts';

function stateRow(id: string, at: string, state: string, senderId = 'marion'): ChannelMessageRow {
    return { id, projectId: 'p1', senderId, kind: 'event', body: state, reference: null, at };
}
function toolRow(id: string, at: string, tool: string, target: string | null, status: 'ok' | 'error' | 'incomplete' | null, live = false): ActivityRow {
    return { id, hireId: 'marion', tool, target, status, at, live };
}

test('mergeFeed orders state and tool rows by time into one stream, deduped by id', () => {
    const merged = mergeFeed([
        activityRowToFeed(toolRow('b', '2026-08-18T12:01:00Z', 'Bash', 'ls', 'ok')),
        stateRowToFeed(stateRow('a', '2026-08-18T12:00:00Z', 'crashed')),
        activityRowToFeed(toolRow('c', '2026-08-18T12:02:00Z', 'Edit', 'f.ts', 'ok')),
        activityRowToFeed(toolRow('b', '2026-08-18T12:01:00Z', 'Bash', 'ls', 'ok')) // duplicate id
    ]);
    assert.deepEqual(merged.map((r) => r.id), ['a', 'b', 'c'], 'time order, duplicate dropped');
    assert.deepEqual(merged.map((r) => r.kind), ['state', 'tool', 'tool'], 'both kinds coexist, distinguishable');
});

test('live-only rows appear open, absent on reopen; accomplishments persist', () => {
    // Open: the state row, a persisted edit, and a live read all merged.
    const openFeed = mergeFeed([
        stateRowToFeed(stateRow('s1', '2026-08-18T12:00:00Z', 'crashed')),
        activityRowToFeed(toolRow('e1', '2026-08-18T12:01:00Z', 'Edit', 'f.ts', 'ok', false)),
        activityRowToFeed(toolRow('r1', '2026-08-18T12:02:00Z', 'Read', 'f.ts', 'ok', true))
    ]);
    assert.ok(openFeed.some((r) => r.id === 'r1'), 'the live read shows while open');
    // Reopen: only the persisted history (byHire, all live false) plus state; no read.
    const reopenFeed = mergeFeed([
        stateRowToFeed(stateRow('s1', '2026-08-18T12:00:00Z', 'crashed')),
        activityRowToFeed(toolRow('e1', '2026-08-18T12:01:00Z', 'Edit', 'f.ts', 'ok', false))
    ]);
    assert.ok(!reopenFeed.some((r) => r.id === 'r1'), 'the live read is gone on reopen');
    assert.ok(reopenFeed.some((r) => r.id === 'e1'), 'the accomplishment stays');
});

test('degrade: with no tool rows the feed still renders the state rows', () => {
    const stateOnly = mergeFeed([stateRowToFeed(stateRow('s1', '2026-08-18T12:00:00Z', 'waiting_for_you'))]);
    assert.deepEqual(stateOnly.map((r) => r.kind), ['state']);
    assert.equal(stateOnly.length, 1, 'not blank when the tailer yields nothing');
});

test('unseenFeed appends only rows whose id is new', () => {
    const rows: FeedRow[] = [
        stateRowToFeed(stateRow('s1', 'T1', 'crashed')),
        activityRowToFeed(toolRow('e1', 'T2', 'Edit', 'f.ts', 'ok'))
    ];
    assert.deepEqual(unseenFeed(new Set(['s1']), rows).map((r) => r.id), ['e1']);
});

test('toolPhrase reads as a localized verb plus target, unknown tool names itself', () => {
    assert.equal(toolPhrase('Edit', 'f.ts', 'en'), 'edited f.ts');
    assert.equal(toolPhrase('Bash', 'git status', 'en'), 'ran git status');
    assert.equal(toolPhrase('Read', 'a.ts', 'en'), 'read a.ts');
    assert.equal(toolPhrase('Edit', 'f.ts', 'fr'), 'a modifié f.ts');
    assert.notEqual(toolPhrase('Bash', 'ls', 'fr'), toolPhrase('Bash', 'ls', 'en'));
    assert.equal(toolPhrase('SomeMcpTool', 'x', 'en'), 'used SomeMcpTool x', 'a new tool still renders');
});

test('toolStatusLabel is quiet for ok, a word for failure or interruption, localized', () => {
    assert.equal(toolStatusLabel('ok', 'en'), null, 'ok shows no tag');
    assert.equal(toolStatusLabel(null, 'en'), null);
    assert.equal(toolStatusLabel('error', 'en'), 'failed');
    assert.equal(toolStatusLabel('incomplete', 'en'), 'interrupted');
    assert.equal(toolStatusLabel('error', 'fr'), 'échec');
    assert.equal(toolStatusLabel('incomplete', 'fr'), 'interrompu');
});

test('an error tool row is marked without taking the waiting amber accent', () => {
    const errorClass = feedRowClass(activityRowToFeed(toolRow('e', 'T1', 'Bash', 'npm test', 'error')));
    assert.ok(errorClass.includes('act-error'), 'error is marked');
    assert.ok(!errorClass.includes('waiting'), 'error does not take the amber waiting accent');
    // The amber accent belongs to the waiting state alone.
    assert.equal(feedRowClass(stateRowToFeed(stateRow('w', 'T1', 'waiting_for_you'))), 'act-row waiting');
    assert.equal(feedRowClass(activityRowToFeed(toolRow('e2', 'T1', 'Edit', 'f.ts', 'incomplete'))), 'act-row act-tool act-incomplete');
});

test('feedIcon picks a tool icon per category and a state icon per state', () => {
    assert.equal(feedIcon(activityRowToFeed(toolRow('a', 'T', 'Edit', 'f', 'ok'))), 'edit');
    assert.equal(feedIcon(activityRowToFeed(toolRow('a', 'T', 'Bash', 'ls', 'ok'))), 'command');
    assert.equal(feedIcon(activityRowToFeed(toolRow('a', 'T', 'Read', 'f', 'ok'))), 'read');
    assert.equal(feedIcon(activityRowToFeed(toolRow('a', 'T', 'Task', 'x', 'ok'))), 'task');
    assert.equal(feedIcon(activityRowToFeed(toolRow('a', 'T', 'Weird', null, 'ok'))), 'tool');
    assert.equal(feedIcon(stateRowToFeed(stateRow('a', 'T', 'crashed'))), 'crashed');
});
