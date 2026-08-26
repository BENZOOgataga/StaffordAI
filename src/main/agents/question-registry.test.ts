import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionRegistry } from './question-registry.ts';
import type { AskQuestion } from '../../shared/ipc.ts';

const QUESTIONS: readonly AskQuestion[] = [
    { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }] }
];

function makeRegistry() {
    const pending: Array<{ hireId: string; pending: boolean }> = [];
    let changes = 0;
    let id = 0;
    const registry = new QuestionRegistry({
        now: () => '2026-01-01T00:00:00.000Z',
        uuid: () => 'q' + (++id),
        onChange: () => { changes += 1; },
        onPending: (hireId, isPending) => { pending.push({ hireId, pending: isPending }); }
    });
    return { registry, pending, changes: () => changes };
}

test('ask registers a pending question and answer resolves it with the selection', async () => {
    const { registry, pending } = makeRegistry();
    const promise = registry.ask({ hireId: 'h1', toolUseId: 't1', questions: QUESTIONS });
    assert.equal(registry.list().length, 1, 'the ask is pending');
    assert.equal(registry.list()[0]!.toolUseId, 't1', 'it carries the tool_use_id for the UI to match');
    assert.deepEqual(pending[0], { hireId: 'h1', pending: true }, 'the colleague is marked waiting');

    registry.answer('q1', { 'Which color?': ['Red'] });
    const outcome = await promise;
    assert.deepEqual(outcome.answers, { 'Which color?': ['Red'] }, 'the promise resolves with the picked answer');
    assert.equal(registry.list().length, 0, 'the pending ask is cleared');
    assert.deepEqual(pending[1], { hireId: 'h1', pending: false }, 'the waiting state is cleared');
});

test('cancel resolves a pending question as unanswered', async () => {
    const { registry } = makeRegistry();
    const promise = registry.ask({ hireId: 'h1', toolUseId: 't1', questions: QUESTIONS });
    registry.cancel('q1');
    assert.deepEqual((await promise).answers, null, 'a cancelled ask carries no answer');
});

test('an unknown id is a no-op, so a stale or double answer cannot throw', () => {
    const { registry } = makeRegistry();
    assert.doesNotThrow(() => registry.answer('missing', { q: ['x'] }));
    assert.doesNotThrow(() => registry.cancel('missing'));
});

test('the waiting state clears only when a colleague has no other pending ask left', async () => {
    const { registry, pending } = makeRegistry();
    const p1 = registry.ask({ hireId: 'h1', toolUseId: 't1', questions: QUESTIONS });
    const p2 = registry.ask({ hireId: 'h1', toolUseId: 't2', questions: QUESTIONS });
    registry.answer('q1', { 'Which color?': ['Red'] });
    await p1;
    // Only the two `pending:true` toggles so far; answering the first left the second pending.
    assert.deepEqual(pending.filter((p) => !p.pending), [], 'still waiting: the second ask keeps the state');
    registry.answer('q2', { 'Which color?': ['Red'] });
    await p2;
    assert.deepEqual(pending.filter((p) => !p.pending), [{ hireId: 'h1', pending: false }], 'now cleared');
});

test('cancelAll resolves every pending ask as unanswered, for shutdown', async () => {
    const { registry } = makeRegistry();
    const p1 = registry.ask({ hireId: 'h1', toolUseId: 't1', questions: QUESTIONS });
    const p2 = registry.ask({ hireId: 'h2', toolUseId: 't2', questions: QUESTIONS });
    registry.cancelAll();
    assert.deepEqual((await p1).answers, null);
    assert.deepEqual((await p2).answers, null);
    assert.equal(registry.list().length, 0);
});
