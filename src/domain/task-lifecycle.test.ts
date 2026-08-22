/**
 * The task lifecycle, and above all the invariant.
 *
 * The done-transition test is exhaustive rather than illustrative. "A colleague can never
 * close its own task" is the same class of claim as "only I set permissions", and a claim
 * like that is worth checking against every state rather than the one or two a reader would
 * think of, because the way it breaks later is someone adding a state and not thinking of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TASK_STATES, TASK_STATE_VALUES, canTransition, refusalReason, isTerminal, isTaskState,
    claimsComplete, stripSentinel, TASK_DONE_SENTINEL, DEFAULT_TASK_TURN_LIMIT
} from './task-lifecycle.ts';

test('THE INVARIANT: no colleague can move a task to done, from any state whatsoever', () => {
    for (const from of TASK_STATE_VALUES) {
        assert.equal(canTransition('colleague', from, TASK_STATES.DONE), false,
            'a colleague reached done from ' + from + ', which breaks the one rule this file exists for');
    }
});

test('the refusal for a colleague reaching done says why, in words worth reading', () => {
    const why = refusalReason('colleague', TASK_STATES.WORKING, TASK_STATES.DONE);
    assert.match(why ?? '', /never close its own task/);
});

test('a colleague may only act on a task it is actively working', () => {
    for (const from of TASK_STATE_VALUES) {
        for (const to of TASK_STATE_VALUES) {
            if (from === TASK_STATES.WORKING) continue;
            assert.equal(canTransition('colleague', from, to), false,
                'a colleague moved a task from ' + from + ' to ' + to + ', but it only works WORKING tasks');
        }
    }
});

test('a colleague finishing an attempt, or failing, is what it CAN do', () => {
    assert.equal(canTransition('colleague', TASK_STATES.WORKING, TASK_STATES.NEEDS_YOU), true);
    assert.equal(canTransition('colleague', TASK_STATES.WORKING, TASK_STATES.FAILED), true);
});

test('a colleague cannot move a task out of needs-you, since that would make waiting a lie', () => {
    assert.equal(canTransition('colleague', TASK_STATES.NEEDS_YOU, TASK_STATES.WORKING), false);
    assert.equal(canTransition('colleague', TASK_STATES.NEEDS_YOU, TASK_STATES.DONE), false);
});

test('I assign, start, review and close', () => {
    assert.equal(canTransition('owner', TASK_STATES.ASSIGNED, TASK_STATES.WORKING), true);
    assert.equal(canTransition('owner', TASK_STATES.NEEDS_YOU, TASK_STATES.DONE), true);
    assert.equal(canTransition('owner', TASK_STATES.NEEDS_YOU, TASK_STATES.FAILED), true);
    // Send-back's prompt shaping is phase 2; the transition is already legal so the state
    // machine does not move when it lands.
    assert.equal(canTransition('owner', TASK_STATES.NEEDS_YOU, TASK_STATES.WORKING), true);
});

test('I can pull a running task back for review, or abandon it', () => {
    assert.equal(canTransition('owner', TASK_STATES.WORKING, TASK_STATES.NEEDS_YOU), true);
    assert.equal(canTransition('owner', TASK_STATES.WORKING, TASK_STATES.FAILED), true);
});

test('nothing leaves a terminal state, so an approved task cannot be quietly reopened', () => {
    for (const actor of ['owner', 'colleague'] as const) {
        for (const from of [TASK_STATES.DONE, TASK_STATES.FAILED]) {
            for (const to of TASK_STATE_VALUES) {
                assert.equal(canTransition(actor, from, to), false,
                    actor + ' moved a task out of ' + from);
            }
        }
    }
    assert.equal(isTerminal(TASK_STATES.DONE), true);
    assert.equal(isTerminal(TASK_STATES.FAILED), true);
    assert.equal(isTerminal(TASK_STATES.WORKING), false);
});

test('a transition to the same state is not a transition', () => {
    for (const state of TASK_STATE_VALUES) {
        assert.equal(canTransition('owner', state, state), false);
    }
});

test('only the five known states are states', () => {
    for (const state of TASK_STATE_VALUES) assert.equal(isTaskState(state), true);
    assert.equal(isTaskState('in-progress'), false);
    assert.equal(isTaskState(''), false);
    assert.equal(isTaskState(null), false);
});

// --- the completion sentinel ------------------------------------------------

test('completion is claimed explicitly, not inferred', () => {
    assert.equal(claimsComplete('all done ' + TASK_DONE_SENTINEL), true);
    assert.equal(claimsComplete('I have finished the task.'), false,
        'saying it is finished is not the sentinel; inferring from prose is how work closes silently');
    assert.equal(claimsComplete(''), false);
});

test('the sentinel is distinctive enough not to be written by accident', () => {
    assert.match(TASK_DONE_SENTINEL, /^<<[A-Z-]+>>$/);
    assert.equal(claimsComplete('the task is complete'), false);
    assert.equal(claimsComplete('STAFFORD TASK COMPLETE'), false);
});

test('the summary I read has the sentinel stripped out', () => {
    assert.equal(stripSentinel('Wrote the file.\n' + TASK_DONE_SENTINEL), 'Wrote the file.');
    assert.equal(stripSentinel(TASK_DONE_SENTINEL), '');
    assert.equal(stripSentinel('no sentinel here'), 'no sentinel here');
});

test('the turn bound is low, because an unbounded unattended task is the unsupervisable shape', () => {
    assert.ok(DEFAULT_TASK_TURN_LIMIT >= 2, 'one turn is not a task');
    assert.ok(DEFAULT_TASK_TURN_LIMIT <= 10,
        'the cost of too low is a review I did not need; the cost of too high is grinding unwatched');
});
