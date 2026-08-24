import test from 'node:test';
import assert from 'node:assert/strict';
import { drawName, NamePoolExhausted, NAME_POOL } from './name-pool.ts';

test('the pool loads from data/first-names.json and is non-trivial', () => {
    assert.ok(NAME_POOL.length > 100, 'the pool has the documented ~187 names');
    assert.ok(NAME_POOL.every((n) => typeof n === 'string' && n.length > 0), 'every entry is a real name');
    assert.equal(new Set(NAME_POOL).size, NAME_POOL.length, 'the pool has no duplicates');
});

test('draws a name that is not already used', () => {
    const used = new Set(['Aaron', 'Alexi']);
    // pick 0 over the available list, so the result is the first pooled name not in `used`.
    const name = drawName(['Aaron', 'Alexi', 'Marion', 'Nadia'], used, () => 0);
    assert.equal(name, 'Marion');
    assert.ok(!used.has(name));
});

test('never returns a used name even as the pool fills up', () => {
    const pool = ['A', 'B', 'C'];
    const used = new Set<string>();
    for (let i = 0; i < 3; i++) {
        const name = drawName(pool, used, () => 0);
        assert.ok(!used.has(name), 'each draw is a fresh name');
        used.add(name);
    }
    assert.deepEqual([...used].sort(), ['A', 'B', 'C']);
});

test('throws NamePoolExhausted when every name is used', () => {
    const pool = ['A', 'B'];
    const used = new Set(['A', 'B']);
    assert.throws(() => drawName(pool, used, () => 0), NamePoolExhausted);
});

test('an out-of-range picker falls back to an available name, never undefined', () => {
    const name = drawName(['A', 'B'], new Set(), () => 999);
    assert.equal(name, 'A');
});
