/**
 * The fire action's integration logic, driven with fake deps. These pin the order that keeps a fired
 * colleague from ever carrying a live process: guard and actor first, then dispose, then the archive
 * mark, and if dispose throws the mark is never written. They also pin that firing archives rather than
 * destroys: the hire row stays with its name, only firedAt is set and the resume map cleared.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fireColleague, type FireDeps } from './fire-colleague.ts';
import type { HiredAgent } from '../domain/models.ts';
import { AGENT_STATES } from '../domain/agent-state.ts';
import { TASK_STATES } from '../domain/task-lifecycle.ts';

function hire(over: Partial<HiredAgent> = {}): HiredAgent {
    return {
        id: 'placeholder-hire', name: 'Marion', type: 'developer', title: 'Developer', seniority: 1,
        ownerId: 'placeholder-owner', sessions: { 'p-1': 'sess-1' }, activeProjectId: 'p-1',
        state: AGENT_STATES.IDLE, hiredAt: '2026-08-01T00:00:00Z', activeSince: '2026-08-01T00:00:00Z',
        firedAt: null, ...over
    };
}

interface Recorded {
    disposed: string[];
    denied: Array<{ hireId: string; reason: string }>;
    updated: HiredAgent[];
    logs: string[];
}

function harness(over: {
    hire?: HiredAgent | null;
    taskStates?: readonly string[];
    hasPendingAsk?: boolean;
    disposeThrows?: boolean;
} = {}): { deps: FireDeps; rec: Recorded } {
    const rec: Recorded = { disposed: [], denied: [], updated: [], logs: [] };
    const theHire = over.hire === undefined ? hire() : over.hire;
    const deps: FireDeps = {
        getHire: () => theHire,
        updateHire: (h) => { rec.updated.push(h); },
        openTaskStates: () => over.taskStates ?? [],
        hasPendingAsk: () => over.hasPendingAsk ?? false,
        disposeRunner: (id) => {
            rec.disposed.push(id);
            if (over.disposeThrows) throw new Error('kill failed');
        },
        denyAsk: (id, reason) => { rec.denied.push({ hireId: id, reason }); },
        now: () => '2026-08-28T12:00:00Z',
        log: (m) => { rec.logs.push(m); }
    };
    return { deps, rec };
}

test('the colleague actor is refused, and nothing is torn down or marked', () => {
    const { deps, rec } = harness();
    const reply = fireColleague(deps, 'colleague', 'placeholder-hire');
    assert.equal(reply.ok, false);
    assert.match(reply.refused ?? '', /Only you/);
    assert.equal(rec.disposed.length, 0, 'no dispose on a refused actor');
    assert.equal(rec.updated.length, 0, 'no firedAt written on a refused actor');
});

test('firing from idle disposes, denies the ask, sets firedAt, and clears the resume map', () => {
    const { deps, rec } = harness();
    const reply = fireColleague(deps, 'owner', 'placeholder-hire');
    assert.equal(reply.ok, true);
    assert.deepEqual(rec.disposed, ['placeholder-hire'], 'the process is disposed');
    assert.equal(rec.denied[0]?.hireId, 'placeholder-hire', 'the ask is denied for this colleague');
    const written = rec.updated[0];
    assert.ok(written, 'the archive mark is written');
    assert.equal(written?.firedAt, '2026-08-28T12:00:00Z', 'firedAt is set');
    assert.deepEqual(written?.sessions, {}, 'the resume map is cleared so nothing can resume into it');
    assert.equal(written?.name, 'Marion', 'the row is kept with its name, so history still resolves it');
});

test('firing from Blocked is allowed', () => {
    const { deps, rec } = harness({ hire: hire({ state: AGENT_STATES.NOT_REPORTING }) });
    const reply = fireColleague(deps, 'owner', 'placeholder-hire');
    assert.equal(reply.ok, true);
    assert.equal(rec.updated[0]?.firedAt, '2026-08-28T12:00:00Z');
});

function refusedByOpenTask(taskState: string): void {
    const { deps, rec } = harness({ taskStates: [taskState] });
    const reply = fireColleague(deps, 'owner', 'placeholder-hire');
    assert.equal(reply.ok, false, 'refused while a non-terminal task is open');
    assert.equal(rec.disposed.length, 0, 'no dispose when refused by the guard');
    assert.equal(rec.updated.length, 0, 'no firedAt when refused by the guard');
}

test('firing is refused while a task is working, with no teardown', () => {
    refusedByOpenTask(TASK_STATES.WORKING);
});

test('firing is refused while a task waits for review, with no teardown', () => {
    refusedByOpenTask(TASK_STATES.NEEDS_YOU);
});

test('firing is refused while a task is assigned, with no teardown', () => {
    refusedByOpenTask(TASK_STATES.ASSIGNED);
});

test('firing is refused while a permission ask is pending', () => {
    const { deps, rec } = harness({ hasPendingAsk: true });
    const reply = fireColleague(deps, 'owner', 'placeholder-hire');
    assert.equal(reply.ok, false);
    assert.match(reply.refused ?? '', /permission request/);
    assert.equal(rec.updated.length, 0);
});

test('a dispose failure aborts the fire: no archive mark, so no fired hire with a live process', () => {
    const { deps, rec } = harness({ disposeThrows: true });
    const reply = fireColleague(deps, 'owner', 'placeholder-hire');
    assert.equal(reply.ok, false, 'the fire is refused rather than half-completing');
    assert.match(reply.refused ?? '', /Could not stop/);
    assert.equal(rec.disposed.length, 1, 'the kill was attempted');
    assert.equal(rec.updated.length, 0, 'firedAt is NOT written when the process could not be stopped');
    assert.equal(rec.denied.length, 0, 'and the ask deny does not run after an aborted teardown');
});

test('firing an already-fired colleague is an idempotent no-op success', () => {
    const { deps, rec } = harness({ hire: hire({ firedAt: '2026-08-20T00:00:00Z' }) });
    const reply = fireColleague(deps, 'owner', 'placeholder-hire');
    assert.equal(reply.ok, true);
    assert.equal(rec.disposed.length, 0, 'nothing is re-torn-down');
    assert.equal(rec.updated.length, 0, 'firedAt is not rewritten');
});

test('a missing colleague is refused, not crashed', () => {
    const { deps } = harness({ hire: null });
    const reply = fireColleague(deps, 'owner', 'ghost');
    assert.equal(reply.ok, false);
    assert.match(reply.refused ?? '', /No such colleague/);
});
