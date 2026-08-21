import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from '../detail/conversation-model.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow } from '../../shared/ipc.ts';

// The Channel reuses the conversation thread, so its cross-colleague behaviour is the
// grouping behaviour under many senders: attribution per group, no cross-sender merge.

function msg(id: string, senderId: string, body: string, at = '2026-08-21T10:00:0' + id): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'message', body, reference: null, at };
}
const cards = [{ id: 'a', name: 'Alexi' }, { id: 'm', name: 'Marion' }];
const nameOf = (s: string): string =>
    s === CHANNEL_SELF_SENDER ? 'You' : (cards.find((c) => c.id === s)?.name ?? s);

test('the channel attributes each colleague and never merges two colleagues into one group', () => {
    const items = buildThread(
        [msg('1', 'a', 'auth is fixed'), msg('2', 'm', 'deploy is green'), msg('3', CHANNEL_SELF_SENDER, 'thanks both')],
        nameOf, CHANNEL_SELF_SENDER, 'en'
    );
    assert.equal(items.length, 3);
    assert.equal((items[0] as { sender: string; side: string }).sender, 'Alexi');
    assert.equal((items[0] as { side: string }).side, 'them');
    assert.equal((items[1] as { sender: string }).sender, 'Marion');
    assert.equal((items[1] as { side: string }).side, 'them');
    assert.equal((items[2] as { side: string }).side, 'you');
});

test('the channel still groups one colleague\'s consecutive messages together', () => {
    const items = buildThread([msg('1', 'a', 'reading'), msg('2', 'a', 'found it')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(items.length, 1);
    assert.equal((items[0] as { messages: readonly unknown[] }).messages.length, 2);
    assert.equal((items[0] as { sender: string }).sender, 'Alexi');
});
