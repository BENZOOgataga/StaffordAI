import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityActions } from './feed-model.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow, type LiveBlock } from '../../shared/ipc.ts';

function msg(id: string, senderId: string, body: string, at: string): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'message', body, reference: null, at, synthetic: false };
}
function event(id: string, senderId: string, state: string, at: string): ChannelMessageRow {
    return { id, projectId: 'p', senderId, kind: 'event', body: state, reference: null, at, synthetic: false };
}
const tool = (name: string, target: string): LiveBlock => ({ kind: 'tool', id: 't', name, target, status: 'ok' });
const text = (t: string): LiveBlock => ({ kind: 'text', text: t });
const think = (): LiveBlock => ({ kind: 'thinking', text: 'because', seconds: 3 });

test('Activity flattens a turn\'s non-text blocks into actions, dropping the reply text', () => {
    const conv = [
        msg('u1', CHANNEL_SELF_SENDER, 'do X', '2026-08-21T10:00:00'),
        msg('m1', 'h1', 'done', '2026-08-21T10:00:05')
    ];
    const turnEvents = { m1: [think(), tool('Read', 'a.ts'), tool('Edit', 'a.ts'), text('done')] };
    const actions = buildActivityActions(conv, turnEvents, 'h1');
    assert.equal(actions.length, 3, 'the three non-text blocks are actions; the reply text is not');
    assert.deepEqual(actions.map((a) => a.block.kind), ['thinking', 'tool', 'tool']);
    assert.ok(actions.every((a) => a.at === '2026-08-21T10:00:05'), 'each action carries its turn time');
});

test('Activity is chronological across turns', () => {
    const conv = [
        msg('m1', 'h1', 'first', '2026-08-21T10:00:00'),
        msg('m2', 'h1', 'second', '2026-08-21T10:05:00')
    ];
    const turnEvents = { m2: [tool('Bash', 'ls')], m1: [tool('Read', 'a.ts')] };
    const actions = buildActivityActions(conv, turnEvents, 'h1');
    assert.deepEqual(actions.map((a) => (a.block as { name: string }).name), ['Read', 'Bash'], 'ordered by turn time');
});

test('Activity has no messages: neither the person\'s prompts nor the colleague\'s prose', () => {
    const conv = [
        msg('u1', CHANNEL_SELF_SENDER, 'a prompt', '2026-08-21T10:00:00'),
        msg('m1', 'h1', 'a prose reply', '2026-08-21T10:00:05')
    ];
    // The colleague's turn was pure text (no tools); nothing lands in Activity.
    const actions = buildActivityActions(conv, { m1: [text('a prose reply')] }, 'h1');
    assert.deepEqual(actions, []);
});

test('a turn with no persisted blocks (pre-feature) contributes no actions, no crash', () => {
    const conv = [msg('m1', 'h1', 'old reply', '2026-08-21T10:00:00')];
    assert.deepEqual(buildActivityActions(conv, {}, 'h1'), []);
});

test('another colleague\'s turns are not in this colleague\'s Activity', () => {
    const conv = [msg('m1', 'h2', 'reply', '2026-08-21T10:00:00')];
    assert.deepEqual(buildActivityActions(conv, { m1: [tool('Edit', 'x')] }, 'h1'), []);
});

test('a state event is not an action, so it does not appear in Activity', () => {
    const conv = [event('e1', 'h1', 'waiting_for_you', '2026-08-21T10:00:00')];
    assert.deepEqual(buildActivityActions(conv, {}, 'h1'), []);
});
