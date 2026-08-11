/**
 * The roster alert rules, tested without a DOM or a sound. Sound once on a
 * transition into waiting, and a badge that clears only when the person looks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RosterAlerts } from './roster-alerts.ts';

function cards(...pairs: Array<[string, string]>): Array<{ id: string; state: string }> {
    return pairs.map(([id, state]) => ({ id, state }));
}

test('a card entering waiting sounds once, and staying waiting does not sound again', () => {
    const alerts = new RosterAlerts();

    assert.equal(alerts.update(cards(['h1', 'working'])).sound, false, 'working does not sound');
    assert.equal(alerts.update(cards(['h1', 'waiting_for_you'])).sound, true, 'the transition sounds');
    assert.equal(alerts.update(cards(['h1', 'waiting_for_you'])).sound, false, 'still waiting does not re-sound');
    assert.equal(alerts.update(cards(['h1', 'waiting_for_you'])).sound, false);
});

test('working and idle never sound', () => {
    const alerts = new RosterAlerts();
    assert.equal(alerts.update(cards(['h1', 'idle'], ['h2', 'working'])).sound, false);
    assert.equal(alerts.update(cards(['h1', 'working'], ['h2', 'idle'])).sound, false);
});

test('a badge appears on the transition and clears only when the person looks', () => {
    const alerts = new RosterAlerts();

    alerts.update(cards(['h1', 'waiting_for_you']));
    assert.equal(alerts.isBadged('h1'), true, 'a fresh waiting card is badged');
    assert.equal(alerts.unseenCount, 1);

    // Staying waiting does not clear it; only looking does.
    alerts.update(cards(['h1', 'waiting_for_you']));
    assert.equal(alerts.isBadged('h1'), true, 'the badge persists until seen, not on a timer');

    alerts.markSeen();
    assert.equal(alerts.isBadged('h1'), false, 'looking clears the badge');
    assert.equal(alerts.unseenCount, 0);
});

test('a card still waiting after being seen keeps its state but not the badge, and re-badges only on a new transition', () => {
    const alerts = new RosterAlerts();
    alerts.update(cards(['h1', 'waiting_for_you']));
    alerts.markSeen();
    assert.equal(alerts.isBadged('h1'), false);

    // Still waiting, already seen: no new badge.
    alerts.update(cards(['h1', 'waiting_for_you']));
    assert.equal(alerts.isBadged('h1'), false, 'a seen waiting card does not silently re-badge');

    // Leaves waiting, then returns: a genuine new transition badges again.
    alerts.update(cards(['h1', 'working']));
    const back = alerts.update(cards(['h1', 'waiting_for_you']));
    assert.equal(back.sound, true, 're-entering waiting is a fresh nudge');
    assert.equal(alerts.isBadged('h1'), true);
});

test('a card leaving waiting drops out of the badged set', () => {
    const alerts = new RosterAlerts();
    alerts.update(cards(['h1', 'waiting_for_you']));
    assert.equal(alerts.unseenCount, 1);
    alerts.update(cards(['h1', 'idle']));
    assert.equal(alerts.isBadged('h1'), false, 'no longer waiting, no longer a pending nudge');
    assert.equal(alerts.unseenCount, 0);
});

test('two cards entering waiting in one update sound once, not twice', () => {
    const alerts = new RosterAlerts();
    const result = alerts.update(cards(['h1', 'waiting_for_you'], ['h2', 'waiting_for_you']));
    assert.equal(result.sound, true);
    assert.equal(alerts.unseenCount, 2, 'both are badged');
});
