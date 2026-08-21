import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityFeed, buildTranscript } from './feed-model.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow, type ActivityRow } from '../../shared/ipc.ts';

function msg(id: string, senderId: string, body: string, at: string): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'message', body, reference: null, at };
}
function event(id: string, senderId: string, state: string, at: string): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'event', body: state, reference: null, at };
}
function act(id: string, hireId: string, tool: string, at: string): ActivityRow {
    return { id, hireId, tool, target: 'f.ts', status: 'ok', at, live: false };
}

test('buildActivityFeed merges the colleague state events and its tool actions in time order', () => {
    const conv = [
        msg('m1', CHANNEL_SELF_SENDER, 'hi', '2026-08-21T10:00:00'),
        event('e1', 'h1', 'waiting_for_you', '2026-08-21T10:00:02')
    ];
    const activity = [act('a1', 'h1', 'Edit', '2026-08-21T10:00:01')];
    const feed = buildActivityFeed(conv, activity, 'h1');
    // The person's own message is not activity; the state event and the tool are, ordered by time.
    assert.deepEqual(feed.map((r) => r.id), ['a1', 'e1']);
    assert.equal(feed[0]!.kind, 'tool');
    assert.equal(feed[1]!.kind, 'state');
});

test('buildActivityFeed ignores another colleague\'s events', () => {
    const conv = [event('e1', 'h2', 'crashed', '2026-08-21T10:00:00')];
    assert.deepEqual(buildActivityFeed(conv, [], 'h1'), []);
});

test('buildTranscript interleaves the colleague\'s own text with its tool calls, in order', () => {
    const conv = [
        msg('m1', CHANNEL_SELF_SENDER, 'do X', '2026-08-21T10:00:00'),
        msg('m2', 'h1', 'on it', '2026-08-21T10:00:01'),
        event('e1', 'h1', 'waiting_for_you', '2026-08-21T10:00:03')
    ];
    const activity = [act('a1', 'h1', 'Bash', '2026-08-21T10:00:02')];
    const items = buildTranscript(conv, activity, 'h1');
    // Only the colleague's text (m2) and its tool (a1); the person's message and the event are excluded.
    assert.deepEqual(items.map((i) => i.id), ['m2', 'a1']);
    assert.equal(items[0]!.kind, 'text');
    assert.equal(items[1]!.kind, 'tool');
});

test('buildTranscript is empty when the colleague has said and done nothing', () => {
    const conv = [msg('m1', CHANNEL_SELF_SENDER, 'hello', '2026-08-21T10:00:00')];
    assert.deepEqual(buildTranscript(conv, [], 'h1'), []);
});
