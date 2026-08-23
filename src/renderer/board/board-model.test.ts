/**
 * The board's arrangement.
 *
 * The claim worth testing hardest is the one the board exists for: every task waiting on me,
 * across every colleague, ends up visible in one place. That includes the case that is easy
 * to miss, a task the lifecycle still calls working because its turn is live but which is
 * actually stopped waiting for me to answer a permission ask.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    boardCopy, buildBoard, columnOf, COLUMN_ORDER, isWaiting, waitingCounts, cardTitle, cardNote
} from './board-model.ts';
import type { TaskRow } from '../../shared/ipc.ts';

function task(over: Partial<TaskRow> = {}): TaskRow {
    return {
        id: 't1', hireId: 'h1', projectId: 'p1', text: 'do the thing', state: 'assigned',
        createdAt: '2026-08-23T10:00:00Z', startedAt: null, completedAt: null,
        updatedAt: '2026-08-23T10:00:00Z', resultSummary: null, resultBranch: null,
        resultCommit: null, failedReason: null, declaredOutputs: [], refusedOutputs: null,
        sessionId: null, sendBacks: [], attempts: 0, ...over
    };
}

const EN = boardCopy('en');
const NAMES = new Map([['h1', 'Ada'], ['h2', 'Boris']]);

function board(rows: TaskRow[], awaiting: string[] = [], closedTruncated = false) {
    return buildBoard({ rows, names: NAMES, awaiting: new Set(awaiting), closedTruncated, copy: EN });
}

// --- the thing the board exists for -----------------------------------------

test('THE POINT: every waiting task across every colleague lands in one column', () => {
    const columns = board([
        task({ id: 'a', hireId: 'h1', state: 'needs-you' }),
        task({ id: 'b', hireId: 'h2', state: 'needs-you' }),
        task({ id: 'c', hireId: 'h1', state: 'working' }),
        task({ id: 'd', hireId: 'h2', state: 'done' })
    ]);
    const waiting = columns.find((c) => c.id === 'needs-you');
    assert.deepEqual(waiting?.cards.map((c) => c.task.id), ['a', 'b'],
        'a task waiting on me behind another colleague tab is exactly what this must not do');
    assert.deepEqual(waiting?.cards.map((c) => c.hireName), ['Ada', 'Boris']);
});

test('A TASK PAUSED ON AN ASK COUNTS AS WAITING, though the lifecycle still calls it working', () => {
    const rows = [
        task({ id: 'paused', hireId: 'h1', state: 'working' }),
        task({ id: 'busy', hireId: 'h2', state: 'working' })
    ];
    const columns = board(rows, ['h1']);
    const working = columns.find((c) => c.id === 'working');

    assert.equal(working?.cards.find((c) => c.task.id === 'paused')?.waiting, true,
        'a turn stopped mid-tool-call is waiting on my answer, and hiding that is the failure');
    assert.equal(working?.cards.find((c) => c.task.id === 'busy')?.waiting, false);
    assert.deepEqual(waitingCounts(rows, new Set(['h1'])), { review: 0, paused: 1, total: 1 });
});

test('a paused task stays in the working column, because the board does not invent states', () => {
    const columns = board([task({ state: 'working' })], ['h1']);
    assert.equal(columns.find((c) => c.id === 'working')?.cards.length, 1);
    assert.equal(columns.find((c) => c.id === 'needs-you')?.cards.length, 0,
        'moving it would be the board disagreeing with the lifecycle about where a task is');
});

test('THE HEADLINE SPLITS THE TWO KINDS, so it never disagrees with the column beneath it', () => {
    const rows = [
        task({ id: 'a', hireId: 'h1', state: 'needs-you' }),
        task({ id: 'b', hireId: 'h2', state: 'working' }),
        task({ id: 'c', hireId: 'h1', state: 'working' }),
        task({ id: 'd', hireId: 'h2', state: 'done' })
    ];
    const counts = waitingCounts(rows, new Set(['h2']));
    assert.deepEqual(counts, { review: 1, paused: 1, total: 2 });

    // The review count is exactly the needs-you column's size, which is the property that
    // stops a single total reading as a mistake above a column holding fewer cards.
    const columns = buildBoard({
        rows, names: NAMES, awaiting: new Set(['h2']), closedTruncated: false, copy: EN
    });
    assert.equal(counts.review, columns.find((c) => c.id === 'needs-you')?.cards.length);

    assert.deepEqual(waitingCounts(rows, new Set()), { review: 1, paused: 0, total: 1 });
    assert.deepEqual(waitingCounts([], new Set()), { review: 0, paused: 0, total: 0 });
});

test('the headline names both kinds when both are present, and only one when one is', () => {
    assert.equal(EN.waitingSummary(2, 1), '2 waiting for review, 1 paused for approval');
    assert.equal(EN.waitingSummary(1, 0), '1 waiting for review');
    assert.equal(EN.waitingSummary(0, 3), '3 paused for approval');
});

// --- the columns -------------------------------------------------------------

test('waiting comes first, because the board answers what needs me and not what happened', () => {
    assert.equal(COLUMN_ORDER[0], 'needs-you');
    assert.deepEqual([...COLUMN_ORDER], ['needs-you', 'working', 'assigned', 'done', 'failed']);
    assert.equal(board([]).find((c) => c.id === 'needs-you')?.primary, true);
    assert.equal(board([]).filter((c) => c.primary).length, 1, 'exactly one column leads');
});

test('every column is present even when empty, since an empty waiting column is the answer', () => {
    const columns = board([]);
    assert.deepEqual(columns.map((c) => c.id), [...COLUMN_ORDER]);
    for (const c of columns) assert.deepEqual(c.cards, []);
});

test('a column is a filter on the state, so no task is invented or lost', () => {
    const states = ['assigned', 'working', 'needs-you', 'done', 'failed'] as const;
    const rows = states.map((state, i) => task({ id: 's' + String(i), state }));
    const columns = board(rows);
    assert.equal(columns.reduce((n, c) => n + c.cards.length, 0), rows.length);
    for (const state of states) assert.ok(columnOf(task({ state })));
});

test('an unknown state lands nowhere rather than in the wrong column', () => {
    assert.equal(columnOf(task({ state: 'in-progress' })), null);
    assert.equal(board([task({ state: 'in-progress' })]).reduce((n, c) => n + c.cards.length, 0), 0);
});

test('row order is preserved within a column, since the read already returns newest first', () => {
    const columns = board([
        task({ id: 'new', state: 'needs-you' }),
        task({ id: 'old', state: 'needs-you' })
    ]);
    assert.deepEqual(columns[0]?.cards.map((c) => c.task.id), ['new', 'old']);
});

test('a truncation is admitted on the finished columns only, rather than quietly misleading', () => {
    const columns = board([], [], true);
    assert.equal(columns.find((c) => c.id === 'done')?.truncatedNote, EN.older);
    assert.equal(columns.find((c) => c.id === 'failed')?.truncatedNote, EN.older);
    assert.equal(columns.find((c) => c.id === 'needs-you')?.truncatedNote, null,
        'the unfinished columns are complete, so claiming otherwise would be a lie');
    assert.equal(board([]).find((c) => c.id === 'done')?.truncatedNote, null);
});

// --- the cards ---------------------------------------------------------------

test('a card names the colleague, and falls back to the id when the colleague is gone', () => {
    const columns = board([task({ hireId: 'h1' }), task({ id: 't2', hireId: 'gone' })]);
    const cards = columns.find((c) => c.id === 'assigned')?.cards ?? [];
    assert.deepEqual(cards.map((c) => c.hireName), ['Ada', 'gone']);
});

test('a card title is one bounded line, never the whole instruction', () => {
    assert.equal(cardTitle(task({ text: 'first line\nsecret second line' })), 'first line');
    assert.equal(cardTitle(task({ text: 'x'.repeat(200) })).length, 123);
    assert.equal(cardTitle(task({ text: '\n\nreal text' })), 'real text');
});

test('a first-attempt card has nothing extra to say, so it stays one line', () => {
    assert.equal(cardNote(task()), null);
});

test('a card that has been round again says so, which is what makes it stand out', () => {
    assert.equal(cardNote(task({ sendBacks: [{ at: 'x', note: 'a' }] })), 'sent back once');
    assert.equal(
        cardNote(task({ sendBacks: [{ at: 'x', note: 'a' }, { at: 'y', note: 'b' }] })),
        'sent back 2 times');
});

test('a failed card shows why, and a finished one shows its branch', () => {
    assert.equal(cardNote(task({ state: 'failed', failedReason: 'not possible' })), 'not possible');
    assert.equal(cardNote(task({ state: 'done', resultBranch: 'stafford/task/h1/t1' })), 'stafford/task/h1/t1');
    assert.equal(
        cardNote(task({ state: 'failed', failedReason: 'no', sendBacks: [{ at: 'x', note: 'a' }] })),
        'sent back once | no');
});

test('the French copy is complete, so the board is translatable', () => {
    const fr = boardCopy('fr');
    for (const key of ['needsYou', 'working', 'assigned', 'done', 'failed', 'title', 'nothingWaiting'] as const) {
        assert.ok(fr[key].length > 0, 'missing ' + key);
        assert.notEqual(fr[key], EN[key], key + ' is untranslated');
    }
    assert.match(fr.waitingSummary(2, 1), /2/);
    assert.notEqual(fr.waitingSummary(2, 1), EN.waitingSummary(2, 1));
});

test('isWaiting never says a finished task is waiting, however it finished', () => {
    for (const state of ['done', 'failed', 'assigned'] as const) {
        assert.equal(isWaiting(task({ state }), new Set(['h1'])), false,
            state + ' was reported as waiting on me');
    }
});
