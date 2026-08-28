/**
 * The pure card view: each state gets its own class and its own plain-language
 * label, so not_reporting is legible rather than looking idle, and idle and
 * waiting are unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cardClassName, stateLabel, elapsedLabel, groupCardsByState, groupLabel } from './roster-view.ts';
import type { RosterCard } from '../shared/ipc.ts';

const NOW = Date.parse('2026-08-11T12:00:00Z');

function card(state: string, since: string | null = null): RosterCard {
    return { id: 'h1', name: 'Marion', role: 'Lead developer', state, project: null, projectId: null, task: null,
        apprentices: 0, queued: 0, since, contextLost: false };
}

function named(id: string, state: string): RosterCard {
    return { id, name: id, role: 'Developer', state, project: null, projectId: null, task: null,
        apprentices: 0, queued: 0, since: null, contextLost: false };
}

test('cards group by state, waiting first, then blocked, working, idle', () => {
    const groups = groupCardsByState([
        named('a', 'idle'), named('b', 'waiting_for_you'), named('c', 'working'),
        named('d', 'not_reporting'), named('e', 'idle')
    ]);
    // not_reporting is Blocked now, an attention state, so it sits after waiting and before the active
    // and quiet states rather than last.
    assert.deepEqual(groups.map((g) => g.state), ['waiting_for_you', 'not_reporting', 'working', 'idle'],
        'the order is waiting, blocked, working, idle');
    assert.deepEqual(groups.map((g) => g.cards.length), [1, 1, 1, 2], 'each group carries its own cards');
});

test('an empty group shows no header: only states with colleagues appear', () => {
    const groups = groupCardsByState([named('a', 'working'), named('b', 'working')]);
    assert.deepEqual(groups.map((g) => g.state), ['working'], 'idle, waiting, not_reporting are omitted, not shown empty');
    assert.equal(groups[0]?.cards.length, 2, 'the one group counts its two colleagues');
});

test('the attention states sit just after waiting, not below idle', () => {
    const groups = groupCardsByState([
        named('a', 'idle'), named('b', 'crashed'), named('c', 'needs_trust'), named('d', 'working')
    ]);
    assert.deepEqual(groups.map((g) => g.state), ['needs_trust', 'crashed', 'working', 'idle'],
        'a crashed or needs-trust colleague is surfaced near the top, not buried under idle');
});

test('a colleague moving state moves group on the next grouping, no full re-render needed', () => {
    const before = groupCardsByState([named('m', 'working'), named('t', 'idle')]);
    assert.equal(before.find((g) => g.state === 'working')?.cards[0]?.id, 'm');
    // The roster re-reads on the transition signal, so the same card in a new state
    // regroups: m is now waiting.
    const after = groupCardsByState([named('m', 'waiting_for_you'), named('t', 'idle')]);
    assert.equal(after[0]?.state, 'waiting_for_you');
    assert.equal(after[0]?.cards[0]?.id, 'm', 'the moved colleague is in the waiting group now');
    assert.equal(after.find((g) => g.state === 'working'), undefined, 'the working group is gone, it is empty');
});

test('an unknown state keeps its cards visible rather than dropping them', () => {
    const groups = groupCardsByState([named('a', 'some_new_state'), named('b', 'working')]);
    assert.ok(groups.some((g) => g.state === 'some_new_state'), 'a new state still shows its colleague');
});

test('group labels are localized and flex for a longer translation', () => {
    assert.equal(groupLabel('waiting_for_you', 'en'), 'Waiting for you');
    assert.notEqual(groupLabel('waiting_for_you', 'fr'), groupLabel('waiting_for_you', 'en'));
    assert.ok(groupLabel('not_reporting', 'fr').length > 0);
    assert.equal(groupLabel('unknown_state', 'en'), 'unknown_state', 'an unknown state falls back to its id');
});

test('not_reporting carries its own class, distinct from idle and waiting', () => {
    assert.equal(cardClassName('not_reporting', false), 'card not_reporting');
    assert.notEqual(cardClassName('not_reporting', false), cardClassName('idle', false));
    assert.notEqual(cardClassName('not_reporting', false), cardClassName('waiting_for_you', false));
});

test('not_reporting reads as Blocked, a turn that could not start, not resting and not a summons', () => {
    assert.equal(stateLabel(card('not_reporting'), NOW), 'Blocked');
    // Distinct from the idle label and the waiting label, in words too.
    assert.notEqual(stateLabel(card('not_reporting'), NOW), stateLabel(card('idle'), NOW));
    assert.notEqual(stateLabel(card('not_reporting'), NOW), stateLabel(card('waiting_for_you'), NOW));
});

test('idle and waiting labels are unchanged', () => {
    assert.equal(stateLabel(card('idle'), NOW), 'Idle');
    assert.equal(stateLabel(card('waiting_for_you'), NOW), 'Waiting for you');
    assert.equal(stateLabel(card('working'), NOW), 'Working');
});

test('the badge class is separate from the state class', () => {
    assert.equal(cardClassName('waiting_for_you', true), 'card waiting_for_you badged');
    assert.equal(cardClassName('not_reporting', true), 'card not_reporting badged');
});

test('elapsed reads from the injected clock, so a long idle shows its minutes', () => {
    const since = '2026-08-11T11:48:00Z'; // 12 minutes before NOW
    assert.equal(elapsedLabel('Idle', since, NOW), 'Idle for 12m');
    assert.equal(elapsedLabel('Idle', null, NOW), 'Idle', 'no start time, no suffix');
});
