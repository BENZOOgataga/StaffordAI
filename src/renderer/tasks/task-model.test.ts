/**
 * The task surface's shaping.
 *
 * The cases worth pinning are the ones where two different situations would otherwise render
 * identically: a task that committed nothing against one that has not run, and a task paused
 * on an approval against one simply working. Both pairs mean opposite things to me and would
 * read the same without a decision made here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    taskCopy, groupOf, buildTaskGroups, stateText, isClosed, isReviewable, isStartable,
    resultLine, shortCommit, refusalLines, deliveredOutputs, attemptLine
} from './task-model.ts';
import type { TaskRow } from '../../shared/ipc.ts';

function task(over: Partial<TaskRow> = {}): TaskRow {
    return {
        id: 't1', hireId: 'h1', projectId: 'p1', text: 'do the thing', state: 'assigned',
        createdAt: '2026-08-22T10:00:00Z', startedAt: null, completedAt: null,
        updatedAt: '2026-08-22T10:00:00Z', resultSummary: null, resultBranch: null,
        resultCommit: null, failedReason: null, declaredOutputs: [], refusedOutputs: null,
        sessionId: null, sendBacks: [], attempts: 0, ...over
    };
}

const EN = taskCopy('en');

test('waiting for me comes first, because the list is about what I have to do', () => {
    const groups = buildTaskGroups([
        task({ id: 'a', state: 'done' }),
        task({ id: 'b', state: 'working' }),
        task({ id: 'c', state: 'needs-you' })
    ], EN);
    assert.deepEqual(groups.map((g) => g.id), ['needs-you', 'active', 'closed']);
});

test('an empty group is absent, not an empty heading', () => {
    const groups = buildTaskGroups([task({ state: 'working' })], EN);
    assert.deepEqual(groups.map((g) => g.id), ['active']);
    assert.deepEqual(buildTaskGroups([], EN), []);
});

test('every state lands in exactly one group', () => {
    const seen = new Map<string, string>();
    for (const state of ['assigned', 'working', 'needs-you', 'done', 'failed'] as const) {
        seen.set(state, groupOf(task({ state })));
    }
    assert.deepEqual([...seen.entries()], [
        ['assigned', 'active'], ['working', 'active'], ['needs-you', 'needs-you'],
        ['done', 'closed'], ['failed', 'closed']
    ]);
});

test('order within a group is preserved, since the read already returns newest first', () => {
    const groups = buildTaskGroups([
        task({ id: 'new', state: 'needs-you' }),
        task({ id: 'old', state: 'needs-you' })
    ], EN);
    assert.deepEqual(groups[0]?.tasks.map((t) => t.id), ['new', 'old']);
});

// --- the two pairs that would otherwise read the same ------------------------

test('a task PAUSED ON AN APPROVAL reads differently from one simply working', () => {
    const working = task({ state: 'working' });
    assert.equal(stateText(working, EN, false), EN.working);
    assert.equal(stateText(working, EN, true), EN.waitingApproval,
        'a paused task needs me now; a working one does not, and they must not look alike');
});

test('being paused is presentation, not a state: the task is still working underneath', () => {
    const working = task({ state: 'working' });
    assert.equal(groupOf(working), 'active', 'a pause must not move a task in the lifecycle');
    assert.equal(isReviewable(working), false, 'and must not put review controls on it');
});

test('a task that COMMITTED NOTHING reads differently from one that has not run', () => {
    assert.equal(resultLine(task({ state: 'assigned' }), null), 'Not started');
    assert.equal(resultLine(task({ state: 'needs-you' }), null), 'No file changes',
        'it ran and changed nothing, which is not the same as never having run');
    assert.equal(resultLine(task({ state: 'working' }), null), 'Running');
});

test('a result with files reads as a count and a shape', () => {
    const t = task({ state: 'needs-you', resultBranch: 'stafford/task/h1/t1' });
    assert.equal(resultLine(t, [{ path: 'a.ts', added: 3, removed: 1, hunks: [], binary: false }]), '1 file, +3 / -1');
    assert.equal(
        resultLine(t, [{ path: 'a.ts', added: 3, removed: 1, hunks: [], binary: false }, { path: 'b.ts', added: 2, removed: 0, hunks: [], binary: false }]),
        '2 files, +5 / -1');
});

test('before the diff lands the branch name stands in, rather than a wrong count', () => {
    const t = task({ state: 'needs-you', resultBranch: 'stafford/task/h1/t1' });
    assert.equal(resultLine(t, null), 'stafford/task/h1/t1');
});

// --- the controls -----------------------------------------------------------

test('only a needs-you task is reviewable, so approve is never offered on anything else', () => {
    for (const state of ['assigned', 'working', 'done', 'failed'] as const) {
        assert.equal(isReviewable(task({ state })), false,
            'review controls appeared on a ' + state + ' task');
    }
    assert.equal(isReviewable(task({ state: 'needs-you' })), true);
});

test('only an assigned task can be started, so a running one cannot be started twice', () => {
    assert.equal(isStartable(task({ state: 'assigned' })), true);
    for (const state of ['working', 'needs-you', 'done', 'failed'] as const) {
        assert.equal(isStartable(task({ state })), false);
    }
});

test('a closed task is closed either way', () => {
    assert.equal(isClosed(task({ state: 'done' })), true);
    assert.equal(isClosed(task({ state: 'failed' })), true);
    assert.equal(isClosed(task({ state: 'needs-you' })), false);
});

// --- declared and refused outputs -------------------------------------------

test('a refusal splits into one readable line per file', () => {
    assert.deepEqual(
        refusalLines('.env (matches a secret pattern); ../out (leaves the repository)'),
        ['.env (matches a secret pattern)', '../out (leaves the repository)']);
    assert.deepEqual(refusalLines(null), []);
    assert.deepEqual(refusalLines('   '), []);
});

test('what was delivered is what was declared minus what was refused', () => {
    const t = task({
        declaredOutputs: ['ok.txt', '.env'],
        refusedOutputs: '.env (matches a secret pattern)'
    });
    assert.deepEqual(deliveredOutputs(t), ['ok.txt']);
});

test('with nothing refused, everything declared was delivered', () => {
    assert.deepEqual(deliveredOutputs(task({ declaredOutputs: ['a.ts', 'b.ts'] })), ['a.ts', 'b.ts']);
});

test('a commit shows short, because the full one is on the branch', () => {
    assert.equal(shortCommit('4cb6973512ab'), '4cb69735');
    assert.equal(shortCommit(null), null);
});

test('the French copy is present and differs, so the panel is translatable', () => {
    const fr = taskCopy('fr');
    assert.notEqual(fr.needsYou, EN.needsYou);
    for (const key of Object.keys(EN) as (keyof typeof EN)[]) {
        assert.ok(fr[key].length > 0, 'the French copy is missing ' + key);
    }
});

// --- send-back ---------------------------------------------------------------

test('a first attempt says nothing about attempts, since every task would say the same', () => {
    assert.equal(attemptLine(task({ attempts: 0 })), null);
    assert.equal(attemptLine(task({ attempts: 1 })), null);
});

test('a task that has been round again says so, and says how many times I sent it back', () => {
    assert.equal(attemptLine(task({ attempts: 2, sendBacks: [{ at: 'x', note: 'a' }] })),
        'Attempt 2, sent back once');
    assert.equal(
        attemptLine(task({ attempts: 3, sendBacks: [{ at: 'x', note: 'a' }, { at: 'y', note: 'b' }] })),
        'Attempt 3, sent back 2 times');
});

test('a second attempt with no send-back is still reported, since something ran it again', () => {
    assert.equal(attemptLine(task({ attempts: 2, sendBacks: [] })), 'Attempt 2');
});

test('a sent-back task is still reviewable when it lands, so the loop can repeat', () => {
    const t = task({ state: 'needs-you', attempts: 3, sendBacks: [{ at: 'x', note: 'a' }] });
    assert.equal(isReviewable(t), true);
    assert.equal(groupOf(t), 'needs-you');
});

test('a task working on a send-back is in progress, not waiting for me', () => {
    const t = task({ state: 'working', attempts: 1, sendBacks: [{ at: 'x', note: 'a' }] });
    assert.equal(groupOf(t), 'active');
    assert.equal(isReviewable(t), false, 'it is running my correction; there is nothing to decide yet');
});

test('the French copy covers the three controls, so the review is translatable', () => {
    const fr = taskCopy('fr');
    for (const key of ['approve', 'fail', 'sendBack', 'notePlaceholder', 'sendBackHistory'] as const) {
        assert.ok(fr[key].length > 0, 'the French copy is missing ' + key);
        assert.notEqual(fr[key], EN[key], key + ' is untranslated');
    }
});
