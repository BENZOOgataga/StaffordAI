import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from './conversation-model.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow } from '../../shared/ipc.ts';

function msg(id: string, senderId: string, body: string, at = '2026-08-21T10:00:0' + id): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'message', body, reference: null, at, synthetic: false };
}
function event(id: string, senderId: string, state: string, at = '2026-08-21T10:00:0' + id): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'event', body: state, reference: null, at, synthetic: false };
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

// --- slash commands and synthetic CLI responses render as system lines, not conversation ---------

function synth(id: string, body: string, at = '2026-08-21T10:00:0' + id): ChannelMessageRow {
    return { id, projectId: 'p', senderId: 'h1', kind: 'message', body, reference: null, at, synthetic: true };
}

test('a synthetic response renders as a cli response line, not a colleague reply', () => {
    const items = buildThread([synth('1', 'Current model: Opus 5')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, 'cli');
    assert.equal((items[0] as { role: string }).role, 'response');
    assert.equal((items[0] as { text: string }).text, 'Current model: Opus 5');
});

test('an empty synthetic response still shows a line rather than vanishing or an empty bubble', () => {
    const en = buildThread([synth('1', '')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(en[0]!.kind, 'cli');
    assert.equal((en[0] as { text: string }).text, 'No output');
    const fr = buildThread([synth('1', '   ')], nameOf, CHANNEL_SELF_SENDER, 'fr');
    assert.equal((fr[0] as { text: string }).text, 'Aucune sortie');
});

test('the four synthetic cases all render as cli lines carrying their text', () => {
    const rows = [
        synth('1', 'Current model: Opus 5'),              // /model, output
        synth('2', 'Error: No messages to compact'),      // /compact fresh, no-op
        synth('3', '/help isn\'t available in this environment.'), // /help declined
        synth('4', 'Unknown command: /nope')              // unknown, still synthetic
    ];
    const items = buildThread(rows, nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.deepEqual(items.map((i) => i.kind), ['cli', 'cli', 'cli', 'cli']);
    assert.equal((items[3] as { text: string }).text, 'Unknown command: /nope',
        'an unknown command reads as a cli line, not a colleague apologising');
});

test('a person\'s slash command renders as a cli command line, not a user bubble', () => {
    const items = buildThread([msg('1', CHANNEL_SELF_SENDER, '/compact')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(items[0]!.kind, 'cli');
    assert.equal((items[0] as { role: string }).role, 'command');
    assert.equal((items[0] as { text: string }).text, '/compact');
});

test('a command with arguments is still a command line', () => {
    const items = buildThread([msg('1', CHANNEL_SELF_SENDER, '/model sonnet')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(items[0]!.kind, 'cli');
    assert.equal((items[0] as { text: string }).text, '/model sonnet');
});

test('a message that starts with a slash but is a path stays an ordinary message', () => {
    const items = buildThread([msg('1', CHANNEL_SELF_SENDER, '/etc/hosts is the file')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(items[0]!.kind, 'group', 'a path is not a command, so it renders as a normal message');
});

test('a real colleague reply is not caught by the command detection', () => {
    const items = buildThread([msg('1', 'h1', 'Done, I updated the parser.')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(items[0]!.kind, 'group');
    assert.equal((items[0] as { side: string }).side, 'them');
});

test('a colleague message that happens to start with a slash is not a command line unless synthetic', () => {
    // Only the person's own messages are treated as commands on the send side; a colleague message with
    // a leading slash is ordinary unless it is tagged synthetic.
    const items = buildThread([msg('1', 'h1', '/some/path in its reply')], nameOf, CHANNEL_SELF_SENDER, 'en');
    assert.equal(items[0]!.kind, 'group');
});
