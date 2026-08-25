import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCollapsed } from './collapse.ts';

test('short output is not collapsed: nothing is hidden', () => {
    const { lines, hidden } = splitCollapsed('a\nb\nc', 15);
    assert.deepEqual(lines, ['a', 'b', 'c']);
    assert.equal(hidden, 0);
});

test('a single trailing newline does not become an extra empty line', () => {
    const { lines, hidden } = splitCollapsed('a\nb\n', 15);
    assert.deepEqual(lines, ['a', 'b']);
    assert.equal(hidden, 0);
});

test('long output hides the overflow, counted for the "show N more lines" affordance', () => {
    const text = Array.from({ length: 40 }, (_v, i) => 'line' + i).join('\n');
    const { lines, hidden } = splitCollapsed(text, 15);
    assert.equal(lines.length, 40);
    assert.equal(hidden, 25, '40 lines minus 15 visible');
});

test('exactly the visible count hides nothing', () => {
    const text = Array.from({ length: 15 }, (_v, i) => String(i)).join('\n');
    assert.equal(splitCollapsed(text, 15).hidden, 0);
});
