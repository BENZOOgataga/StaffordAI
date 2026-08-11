/**
 * The pure card view: each state gets its own class and its own plain-language
 * label, so not_reporting is legible rather than looking idle, and idle and
 * waiting are unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cardClassName, stateLabel, elapsedLabel } from './roster-view.ts';
import type { RosterCard } from '../shared/ipc.ts';

const NOW = Date.parse('2026-08-11T12:00:00Z');

function card(state: string, since: string | null = null): RosterCard {
    return { id: 'h1', name: 'Marion', role: 'Lead developer', state, project: null, task: null,
        apprentices: 0, queued: 0, since };
}

test('not_reporting carries its own class, distinct from idle and waiting', () => {
    assert.equal(cardClassName('not_reporting', false), 'card not_reporting');
    assert.notEqual(cardClassName('not_reporting', false), cardClassName('idle', false));
    assert.notEqual(cardClassName('not_reporting', false), cardClassName('waiting_for_you', false));
});

test('not_reporting reads as cannot-reach, not resting and not a summons', () => {
    assert.equal(stateLabel(card('not_reporting'), NOW), 'Not reporting');
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
