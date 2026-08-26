import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTurn, type TurnItem } from './group-turn.ts';
import type { LiveBlock } from '../../shared/ipc.ts';

const text = (t: string): LiveBlock => ({ kind: 'text', text: t });
const tool = (name: string): LiveBlock => ({ kind: 'tool', id: name, name, target: null, status: 'ok' });
const think = (t: string, s: number | null): LiveBlock => ({ kind: 'thinking', text: t, seconds: s });

/** The kinds of the produced items, with a reasoning item flattened to its inner kinds. */
const shape = (items: TurnItem[]): string[] =>
    items.map((it) => it.kind === 'reasoning' ? 'reasoning[' + it.blocks.map((b) => b.kind).join(',') + ']' : it.block.kind);

test('a turn with no thinking is flat: every block stays top-level', () => {
    const items = groupTurn([tool('Read'), tool('Edit'), text('done')]);
    assert.deepEqual(shape(items), ['tool', 'tool', 'text']);
});

test('the reasoning span wraps the thinking and the in-reasoning actions; the final text is the answer', () => {
    // The real captured shape: thinking, actions, thinking again, then the reply.
    const items = groupTurn([think('', 2), tool('Skill'), tool('Glob'), tool('Read'), think('', 3), text('a recommendation')]);
    assert.deepEqual(shape(items), ['reasoning[thinking,tool,tool,tool,thinking]', 'text'],
        'actions nest in reasoning, the final text is the top-level answer');
    const reasoning = items[0] as Extract<TurnItem, { kind: 'reasoning' }>;
    assert.equal(reasoning.seconds, 5, 'the reasoning duration is the sum of the thinking times');
});

test('redacted thinking still forms a reasoning block because it wraps the actions', () => {
    const items = groupTurn([think('', 8), tool('Read'), tool('Edit'), text('done')]);
    assert.deepEqual(shape(items), ['reasoning[thinking,tool,tool]', 'text'],
        'even with empty reasoning text, the block has the actions as content');
});

test('an empty redacted thinking with no actions makes no reasoning wrapper', () => {
    // Only a thinking that produced no text and no measurable time, then the answer: nothing to wrap.
    const items = groupTurn([think('', null), text('answer')]);
    assert.deepEqual(shape(items), ['text'], 'no empty reasoning container, the answer stands alone');
});

test('an action before the first thinking stays top-level, not pulled into reasoning', () => {
    const items = groupTurn([tool('Read'), think('', 2), tool('Edit'), text('done')]);
    assert.deepEqual(shape(items), ['tool', 'reasoning[thinking,tool]', 'text'],
        'the pre-reasoning read is top-level; the edit during reasoning nests');
});

test('an action after the final answer stays top-level', () => {
    const items = groupTurn([think('', 2), tool('Read'), text('done'), tool('Bash')]);
    assert.deepEqual(shape(items), ['reasoning[thinking,tool]', 'text', 'tool'],
        'the post-answer shell is top-level, outside the reasoning span');
});

test('a turn that thought and acted but gave no final text wraps it all in reasoning', () => {
    const items = groupTurn([think('', 4), tool('Read'), tool('Edit')]);
    assert.deepEqual(shape(items), ['reasoning[thinking,tool,tool]'], 'no answer, everything is reasoning');
});

test('an AskUserQuestion stays a top-level visible step, never hidden in collapsed reasoning', () => {
    const ask: LiveBlock = { kind: 'tool', id: 'a', name: 'AskUserQuestion', target: null, status: 'ok', question: 'Plan or build?' };
    const items = groupTurn([think('', 3), tool('Read'), ask, text('waiting')]);
    // The read nests in reasoning; the ask is pulled out to the top level; the text is the answer.
    assert.deepEqual(shape(items), ['reasoning[thinking,tool]', 'tool', 'text']);
    assert.equal((items[1] as Extract<TurnItem, { kind: 'block' }>).block.kind, 'tool', 'the ask is a top-level block');
});

test('an ask at the very end of a thinking turn is still top-level, not swallowed by reasoning', () => {
    const ask: LiveBlock = { kind: 'tool', id: 'a', name: 'AskUserQuestion', target: null, status: 'ok', question: 'Which?' };
    const items = groupTurn([think('', 2), ask]);
    assert.deepEqual(shape(items), ['tool'], 'no reasoning wrapper hides the ask; the empty thinking is dropped');
});

test('a still-streaming thinking leaves the reasoning duration null', () => {
    const items = groupTurn([think('', null), tool('Read')]);
    const reasoning = items[0] as Extract<TurnItem, { kind: 'reasoning' }>;
    assert.equal(reasoning.kind, 'reasoning');
    assert.equal(reasoning.seconds, null, 'still reasoning, so the label reads "Reasoning..." not a time');
});
