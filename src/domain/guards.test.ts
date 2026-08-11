import test from 'node:test';
import assert from 'node:assert/strict';
import { isProofSpawn, isProofWrite, isSessionOpen, isSessionResize } from './guards.ts';

test('a proof spawn needs bounded integer cols and rows', () => {
    assert.equal(isProofSpawn({ cols: 80, rows: 24 }), true);
    assert.equal(isProofSpawn({ cols: 1, rows: 1 }), true);

    assert.equal(isProofSpawn({ cols: 0, rows: 24 }), false, 'zero is out of bounds');
    assert.equal(isProofSpawn({ cols: 80, rows: 5000 }), false, 'over the ceiling');
    assert.equal(isProofSpawn({ cols: 80.5, rows: 24 }), false, 'not an integer');
    assert.equal(isProofSpawn({ cols: '80', rows: 24 }), false, 'not a number');
    assert.equal(isProofSpawn(null), false);
    assert.equal(isProofSpawn({}), false);
});

test('a proof write needs a bounded string', () => {
    assert.equal(isProofWrite({ data: 'ls\r' }), true);
    assert.equal(isProofWrite({ data: '' }), true);

    assert.equal(isProofWrite({ data: 42 }), false, 'not a string');
    assert.equal(isProofWrite({ data: 'x'.repeat(64 * 1024 + 1) }), false, 'over the cap');
    assert.equal(isProofWrite(null), false);
    assert.equal(isProofWrite({}), false);
});

test('opening a session needs a bounded, non-empty hire id and never a path', () => {
    assert.equal(isSessionOpen({ hireId: 'h1' }), true);
    assert.equal(isSessionOpen({ hireId: '' }), false, 'empty is refused');
    assert.equal(isSessionOpen({ hireId: 'x'.repeat(257) }), false, 'over the cap');
    assert.equal(isSessionOpen({ hireId: 42 }), false, 'not a string');
    assert.equal(isSessionOpen({}), false);
    assert.equal(isSessionOpen(null), false);
});

test('a session resize needs a hire id and a bounded terminal size', () => {
    assert.equal(isSessionResize({ hireId: 'h1', cols: 80, rows: 24 }), true);
    assert.equal(isSessionResize({ hireId: 'h1', cols: 0, rows: 24 }), false, 'zero cols out of bounds');
    assert.equal(isSessionResize({ hireId: 'h1', cols: 80, rows: 5000 }), false, 'over the ceiling');
    assert.equal(isSessionResize({ hireId: '', cols: 80, rows: 24 }), false, 'empty hire id');
    assert.equal(isSessionResize({ cols: 80, rows: 24 }), false, 'no hire id');
    assert.equal(isSessionResize(null), false);
});
