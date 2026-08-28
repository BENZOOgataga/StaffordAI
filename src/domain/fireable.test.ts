/**
 * The fireable guard, the rule that decides whether a colleague can be removed. These pin the exact
 * matrix the fire action enforces: idle and Blocked are fireable, a non-terminal task or a pending ask
 * or an in-flight turn is refused, and the refusal names the blocker rather than a generic message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFireable } from './fireable.ts';
import { AGENT_STATES } from './agent-state.ts';
import { TASK_STATES } from './task-lifecycle.ts';

const settled = { taskStates: [], hasPendingAsk: false };

test('fireable from idle', () => {
    assert.deepEqual(checkFireable({ state: AGENT_STATES.IDLE, ...settled }), { fireable: true });
});

test('fireable from Blocked (not_reporting)', () => {
    assert.deepEqual(checkFireable({ state: AGENT_STATES.NOT_REPORTING, ...settled }), { fireable: true });
});

test('fireable from crashed: no live process, so removal loses nothing', () => {
    assert.deepEqual(checkFireable({ state: AGENT_STATES.CRASHED, ...settled }), { fireable: true });
});

test('fireable from needs_trust: no live process, and being stuck there off the roster is worse', () => {
    assert.deepEqual(checkFireable({ state: AGENT_STATES.NEEDS_TRUST, ...settled }), { fireable: true });
});

test('still refused from rate_limited: it is paused, not settled, and will resume into work', () => {
    const r = checkFireable({ state: AGENT_STATES.RATE_LIMITED, ...settled });
    assert.equal(r.fireable, false);
});

test('refused while working, named as working', () => {
    const r = checkFireable({ state: AGENT_STATES.WORKING, ...settled });
    assert.equal(r.fireable, false);
    if (!r.fireable) {
        assert.match(r.reason, /working/i);
        assert.ok(r.reasonFr.length > 0, 'the refusal is localized');
    }
});

test('refused while a task waits for review, named as a review', () => {
    const r = checkFireable({ state: AGENT_STATES.IDLE, taskStates: [TASK_STATES.NEEDS_YOU], hasPendingAsk: false });
    assert.equal(r.fireable, false);
    if (!r.fireable) assert.match(r.reason, /review/i);
});

test('refused while a task is working', () => {
    const r = checkFireable({ state: AGENT_STATES.IDLE, taskStates: [TASK_STATES.WORKING], hasPendingAsk: false });
    assert.equal(r.fireable, false);
    if (!r.fireable) assert.match(r.reason, /working on a task/i);
});

test('refused while a task is assigned', () => {
    const r = checkFireable({ state: AGENT_STATES.IDLE, taskStates: [TASK_STATES.ASSIGNED], hasPendingAsk: false });
    assert.equal(r.fireable, false);
    if (!r.fireable) assert.match(r.reason, /assigned/i);
});

test('refused while a permission ask is pending, even from idle with no task', () => {
    const r = checkFireable({ state: AGENT_STATES.IDLE, taskStates: [], hasPendingAsk: true });
    assert.equal(r.fireable, false);
    if (!r.fireable) assert.match(r.reason, /permission request waiting/i);
});

test('a terminal task does not block: idle with only done and failed tasks is fireable', () => {
    const r = checkFireable({ state: AGENT_STATES.IDLE, taskStates: [TASK_STATES.DONE, TASK_STATES.FAILED], hasPendingAsk: false });
    assert.deepEqual(r, { fireable: true });
});

test('a non-settled state such as waiting_for_you is refused rather than silently allowed', () => {
    const r = checkFireable({ state: AGENT_STATES.WAITING, ...settled });
    assert.equal(r.fireable, false);
});
