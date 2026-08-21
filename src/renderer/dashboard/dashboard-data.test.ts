import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOverview, statusForState } from './dashboard-data.ts';
import type { RosterCard } from '../../shared/ipc.ts';

function card(id: string, state: string, project: string | null = 'Stafford'): RosterCard {
    return {
        id, name: id, role: 'Lead developer', state, project, projectId: null, task: null,
        apprentices: 0, queued: 0, since: null, contextLost: false
    };
}

test('statusForState maps a colleague state to a dot status', () => {
    assert.equal(statusForState('working'), 'working');
    assert.equal(statusForState('idle'), 'idle');
    assert.equal(statusForState('waiting_for_you'), 'waiting');
    assert.equal(statusForState('rate_limited'), 'waiting');
    assert.equal(statusForState('crashed'), 'error');
    assert.equal(statusForState('needs_trust'), 'error');
    assert.equal(statusForState('not_reporting'), 'error');
    assert.equal(statusForState('anything-unknown'), 'offline');
});

test('computeOverview counts colleagues by state from real cards', () => {
    const cards = [
        card('a', 'working'),
        card('b', 'working'),
        card('c', 'idle'),
        card('d', 'waiting_for_you'),
        card('e', 'crashed')
    ];
    const overview = computeOverview(cards, 3);

    assert.equal(overview.stats.total, 5);
    assert.equal(overview.stats.projects, 3);
    assert.deepEqual(overview.stats.byState, { working: 2, idle: 1, waiting: 1, other: 1 });
    // Active is working plus waiting, the ones needing attention.
    assert.equal(overview.stats.active, 3);
    assert.equal(overview.empty, false);
    assert.equal(overview.cards.length, 5);
});

test('computeOverview reports an empty overview when there are no colleagues', () => {
    const overview = computeOverview([], 0);
    assert.equal(overview.empty, true);
    assert.equal(overview.stats.total, 0);
    assert.equal(overview.stats.active, 0);
    assert.deepEqual(overview.stats.byState, { working: 0, idle: 0, waiting: 0, other: 0 });
});
