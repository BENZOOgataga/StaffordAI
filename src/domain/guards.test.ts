import test from 'node:test';
import assert from 'node:assert/strict';
import { isProofSpawn, isProofWrite } from './guards.ts';

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
