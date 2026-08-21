import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from './conversation-model.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow } from '../../shared/ipc.ts';

function msg(id: string, senderId: string, body: string, at = '2026-08-21T10:00:0' + id): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'message', body, reference: null, at };
}
function event(id: string, senderId: string, state: string, at = '2026-08-21T10:00:0' + id): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'event', body: state, reference: null, at };
}
const nameOf = (s: string): string => (s === CHANNEL_SELF_SENDER ? 'You' : s === 'h1' ? 'Alexi' : s);

test('buildThread groups consecutive messages from the same sender into one group', () => {
    const items = buildThread(
        [msg('1', CHANNEL_SELF_SENDER, 'hey'), msg('2', CHANNEL_SELF_SENDER, 'you there'), msg('3', 'h1', 'yes')],
        nameOf, CHANNEL_SELF_SENDER, 'en'
    );
    assert.equal(items.length, 2);
    assert.equal(items[0]!.kind, 'group');
    assert.equal((items[0] as { messages: readonly unknown[] }).messages.length, 2);
    assert.equal((items[1] as { messages: readonly unknown[] }).messages.length, 1);
});

test('buildThread marks your messages and the colleague\'s messages with a side', () => {
    const items = buildThread([msg('1', CHANNEL_SELF_SENDER, 'hi'), msg('2', 'h1', 'hello')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal((items[0] as { side: string }).side, 'you');
    assert.equal((items[1] as { side: string; sender: string }).side, 'them');
    assert.equal((items[1] as { sender: string }).sender, 'Alexi');
});

test('buildThread breaks the group on an event and localizes the event line', () => {
    const items = buildThread(
        [msg('1', 'h1', 'working'), event('2', 'h1', 'waiting_for_you'), msg('3', 'h1', 'back')],
        nameOf, CHANNEL_SELF_SENDER, 'en'
    );
    assert.deepEqual(items.map((i) => i.kind), ['group', 'event', 'group']);
    assert.equal((items[1] as { text: string; waiting: boolean }).text, 'Alexi is waiting for you');
    assert.equal((items[1] as { waiting: boolean }).waiting, true);
});

test('buildThread returns nothing for an empty thread', () => {
    assert.deepEqual(buildThread([], nameOf, CHANNEL_SELF_SENDER, 'en'), []);
});
