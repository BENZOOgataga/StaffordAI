import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isProofSpawn, isProofWrite, isSessionOpen, isSessionResize, isSessionWrite,
    isChannelPage, isChannelSince
} from './guards.ts';

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

test('a session write needs a hire id and a bounded string', () => {
    assert.equal(isSessionWrite({ hireId: 'h1', text: 'do the thing' }), true);
    assert.equal(isSessionWrite({ hireId: 'h1', text: '' }), true, 'empty text is a valid shape');
    assert.equal(isSessionWrite({ hireId: 'h1', text: 42 }), false, 'text must be a string');
    assert.equal(isSessionWrite({ hireId: 'h1', text: 'x'.repeat(64 * 1024 + 1) }), false, 'over the cap');
    assert.equal(isSessionWrite({ text: 'hi' }), false, 'no hire id');
    assert.equal(isSessionWrite(null), false);
});

test('a channel page read takes a null-or-cursor before and a bounded limit', () => {
    assert.equal(isChannelPage({ before: null, limit: 50 }), true, 'null before is the newest page');
    assert.equal(isChannelPage({ before: { at: 't', id: 'a' }, limit: 20 }), true, 'a cursor is scroll-back');
    assert.equal(isChannelPage({ limit: 50 }), false, 'before is required, even if null');
    assert.equal(isChannelPage({ before: { at: 't' }, limit: 50 }), false, 'a cursor needs an id');
    assert.equal(isChannelPage({ before: null, limit: 0 }), false, 'limit out of bounds');
    assert.equal(isChannelPage({ before: null, limit: 5000 }), false, 'over the cap');
    assert.equal(isChannelPage(null), false);
});

test('a channel since read takes a cursor and a bounded limit', () => {
    assert.equal(isChannelSince({ after: { at: 't', id: 'a' }, limit: 50 }), true);
    assert.equal(isChannelSince({ after: null, limit: 50 }), false, 'after is required');
    assert.equal(isChannelSince({ after: { id: 'a' }, limit: 50 }), false, 'the cursor needs a timestamp');
    assert.equal(isChannelSince({ after: { at: 't', id: 'a' }, limit: 0 }), false);
});
