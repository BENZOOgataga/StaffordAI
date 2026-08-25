import test from 'node:test';
import assert from 'node:assert/strict';
import { hunkRows } from './diff-view-model.ts';
import type { TaskDiffHunk, TaskDiffLine } from '../../shared/ipc.ts';

const ctx = (n: number): TaskDiffLine[] => Array.from({ length: n }, (_v, i) => ({ kind: 'context' as const, text: 'ctx' + i }));
const hunk = (lines: TaskDiffLine[]): TaskDiffHunk => ({ header: '@@', lines });

test('a short context run is not collapsed', () => {
    const rows = hunkRows(hunk([{ kind: 'del', text: 'a' }, ...ctx(3), { kind: 'add', text: 'b' }]));
    assert.ok(rows.every((r) => r.kind === 'line'), 'three context lines stay visible');
    assert.equal(rows.length, 5);
});

test('a long run between two changes collapses its middle, keeping edge context each side', () => {
    const rows = hunkRows(hunk([{ kind: 'del', text: 'a' }, ...ctx(20), { kind: 'add', text: 'b' }]), 3, 4);
    const gap = rows.find((r) => r.kind === 'gap');
    if (gap?.kind !== 'gap') throw new Error('expected a gap row in the middle');
    assert.equal(gap.count, 14, '20 context minus 3 kept each side');
    // Three context lines survive immediately after the removal and before the addition.
    const kinds = rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['line', 'line', 'line', 'line', 'gap', 'line', 'line', 'line', 'line']);
    // The gap carries the hidden lines so expanding reveals them without a re-fetch.
    assert.equal(gap.lines.length, 14);
});

test('a long leading run (hunk start) collapses from the top, keeping the lines next to the change', () => {
    const rows = hunkRows(hunk([...ctx(10), { kind: 'add', text: 'x' }]), 3, 4);
    const gap = rows[0];
    if (gap?.kind !== 'gap') throw new Error('expected the top to collapse');
    assert.equal(gap.count, 7, '10 minus the 3 kept before the change');
});

test('a changed line is never inside a gap', () => {
    const rows = hunkRows(hunk([...ctx(8), { kind: 'del', text: 'gone' }, ...ctx(8)]), 3, 4);
    for (const r of rows) {
        if (r.kind === 'gap') assert.ok(r.lines.every((l) => l.kind === 'context'), 'gaps hold only context');
    }
    assert.ok(rows.some((r) => r.kind === 'line' && r.line.kind === 'del'), 'the removal stays a visible line');
});
