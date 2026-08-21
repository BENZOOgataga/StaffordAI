import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRegistry } from './approval-registry.ts';

function makeRegistry() {
    let n = 0;
    const changes: number[] = [];
    const pendingCalls: Array<{ hireId: string; pending: boolean }> = [];
    const registry = new ApprovalRegistry({
        now: () => '2026-08-21T00:00:00Z',
        uuid: () => 'id-' + (++n),
        onChange: () => changes.push(1),
        onPending: (hireId, pending) => pendingCalls.push({ hireId, pending })
    });
    return { registry, changes, pendingCalls };
}

test('an ask returns a pending promise that resolves only when answered', async () => {
    const { registry } = makeRegistry();
    const p = registry.ask({ hireId: 'h1', action: 'shell', path: null, command: 'git push --force' });
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'the promise waits until answered');
    assert.equal(registry.list().length, 1);

    const id = registry.list()[0]!.id;
    registry.answer(id, true, null);
    const outcome = await p;
    assert.deepEqual(outcome, { approve: true, note: null });
    assert.equal(registry.list().length, 0);
});

test('answering one ask resolves exactly that seam, never another', async () => {
    const { registry } = makeRegistry();
    const a = registry.ask({ hireId: 'h1', action: 'write', path: '/p/a', command: null });
    const b = registry.ask({ hireId: 'h2', action: 'write', path: '/p/b', command: null });
    const [idA, idB] = registry.list().map((x) => x.id);

    registry.answer(idB!, false, 'no');
    const outB = await b;
    assert.deepEqual(outB, { approve: false, note: 'no' });
    // a is still pending, untouched
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]!.id, idA);

    registry.answer(idA!, true, null);
    assert.deepEqual(await a, { approve: true, note: null });
});

test('the colleague waits while any ask is pending and stops when the last is answered', async () => {
    const { registry, pendingCalls } = makeRegistry();
    registry.ask({ hireId: 'h1', action: 'shell', path: null, command: 'a' });
    registry.ask({ hireId: 'h1', action: 'shell', path: null, command: 'b' });
    const ids = registry.list().map((x) => x.id);

    registry.answer(ids[0]!, true, null);
    // still one pending for h1, so no clear yet
    assert.deepEqual(pendingCalls.filter((c) => !c.pending), []);
    registry.answer(ids[1]!, true, null);
    assert.deepEqual(pendingCalls.filter((c) => !c.pending), [{ hireId: 'h1', pending: false }]);
});

test('denyAll resolves every pending ask as deny, for a clean shutdown', async () => {
    const { registry } = makeRegistry();
    const a = registry.ask({ hireId: 'h1', action: 'shell', path: null, command: 'a' });
    const b = registry.ask({ hireId: 'h2', action: 'shell', path: null, command: 'b' });
    registry.denyAll('Stafford is closing.');
    assert.deepEqual(await a, { approve: false, note: 'Stafford is closing.' });
    assert.deepEqual(await b, { approve: false, note: 'Stafford is closing.' });
    assert.equal(registry.list().length, 0);
});

test('answering an unknown id is a safe no-op', () => {
    const { registry } = makeRegistry();
    assert.doesNotThrow(() => registry.answer('nope', true, null));
});
