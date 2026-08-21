/**
 * The roster assembler: persisted hires plus live session info become cards, with
 * state and task foregrounded and paths never present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRoster, type LiveInfo } from './snapshot.ts';
import type { HiredAgent } from '../../domain/models.ts';

function hire(over: Partial<HiredAgent> = {}): HiredAgent {
    return {
        id: 'h1', name: 'Marion', type: 'lead-developer', title: 'Lead developer', seniority: 2,
        ownerId: 'owner', sessions: {}, activeProjectId: 'p1', state: 'working',
        hiredAt: '2026-08-10T00:00:00Z', firedAt: null, ...over
    };
}

const noLive = () => null;
const noTask = () => null;
const noContext = () => false;
const projectName = (id: string) => (id === 'p1' ? 'Stafford' : null);

test('a hire becomes a card with state and role, and the project name not a path', () => {
    const snap = assembleRoster({
        hires: [hire()], projectName, live: noLive, currentTask: noTask, contextLost: noContext
    });
    assert.equal(snap.cards.length, 1);
    assert.deepEqual(snap.cards[0], {
        id: 'h1', name: 'Marion', role: 'Lead developer', state: 'working',
        // The name is what the card shows; the id is what a view acts on. Both, and still no
        // path, which is the rule this test was written to hold.
        project: 'Stafford', projectId: 'p1', task: null,
        apprentices: 0, queued: 0, since: null, contextLost: false
    });
});

test('live session info adds the apprentice count and the state start time', () => {
    const live = (id: string): LiveInfo | null =>
        id === 'h1' ? { apprentices: 3, since: '2026-08-11T09:00:00Z' } : null;
    const snap = assembleRoster({ hires: [hire()], projectName, live, currentTask: noTask, contextLost: noContext });
    assert.equal(snap.cards[0]?.apprentices, 3);
    assert.equal(snap.cards[0]?.since, '2026-08-11T09:00:00Z');
});

test('the context-lost flag flows onto the card from the resolver', () => {
    const lost = assembleRoster({
        hires: [hire()], projectName, live: noLive, currentTask: noTask, contextLost: () => true
    });
    assert.equal(lost.cards[0]?.contextLost, true, 'a fresh-after-failed-resume session carries the note');

    const kept = assembleRoster({
        hires: [hire()], projectName, live: noLive, currentTask: noTask, contextLost: () => false
    });
    assert.equal(kept.cards[0]?.contextLost, false);
});

test('a fired hire is not a card on the roster', () => {
    const snap = assembleRoster({
        hires: [hire({ firedAt: '2026-08-11T00:00:00Z' })], projectName, live: noLive, currentTask: noTask, contextLost: noContext
    });
    assert.equal(snap.cards.length, 0);
});

test('a hire on no project has a null project, not a placeholder', () => {
    const snap = assembleRoster({
        hires: [hire({ activeProjectId: null })], projectName, live: noLive, currentTask: noTask, contextLost: noContext
    });
    assert.equal(snap.cards[0]?.project, null);
});

test('the task line comes from the injected source and is null until dispatch exists', () => {
    const withTask = assembleRoster({
        hires: [hire()], projectName, live: noLive, currentTask: () => 'Refactoring the parser', contextLost: noContext
    });
    assert.equal(withTask.cards[0]?.task, 'Refactoring the parser');

    const withoutTask = assembleRoster({ hires: [hire()], projectName, live: noLive, currentTask: noTask, contextLost: noContext });
    assert.equal(withoutTask.cards[0]?.task, null);
});
