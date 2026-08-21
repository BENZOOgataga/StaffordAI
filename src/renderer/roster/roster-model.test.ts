import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterGroups } from './roster-model.ts';
import type { RosterCard } from '../../shared/ipc.ts';

function card(id: string, state: string, over: Partial<RosterCard> = {}): RosterCard {
    return {
        id, name: id, role: 'PM assistant', state, project: 'Stafford', projectId: null, task: null,
        apprentices: 0, queued: 0, since: null, contextLost: false, ...over
    };
}

const NOW = 1_700_000_000_000;

test('buildRosterGroups orders groups waiting first, then attention, active, quiet', () => {
    const cards = [
        card('a', 'idle'),
        card('b', 'waiting_for_you'),
        card('c', 'not_reporting'),
        card('d', 'working'),
        card('e', 'crashed')
    ];
    const groups = buildRosterGroups(cards, 'en', NOW, new Set(), null);
    assert.deepEqual(groups.map((g) => g.state), ['waiting_for_you', 'crashed', 'working', 'idle', 'not_reporting']);
});

test('buildRosterGroups drops empty groups and counts the rest', () => {
    const groups = buildRosterGroups([card('a', 'working'), card('b', 'working')], 'en', NOW, new Set(), null);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.state, 'working');
    assert.equal(groups[0]!.count, 2);
    assert.equal(groups[0]!.rows.length, 2);
});

test('buildRosterGroups maps each row to a dot status and a plain state line with the project', () => {
    const groups = buildRosterGroups([card('a', 'working')], 'en', NOW, new Set(), null);
    const row = groups[0]!.rows[0]!;
    assert.equal(row.status, 'working');
    assert.equal(row.stateText, 'Working on Stafford');
});

test('buildRosterGroups omits the project suffix when a colleague has no project', () => {
    const groups = buildRosterGroups([card('a', 'idle', { project: null })], 'en', NOW, new Set(), null);
    assert.equal(groups[0]!.rows[0]!.stateText, 'Idle');
});

test('buildRosterGroups carries the unseen badge and the selection through to the row', () => {
    const groups = buildRosterGroups(
        [card('a', 'waiting_for_you'), card('b', 'waiting_for_you')],
        'en', NOW, new Set(['a']), 'b'
    );
    const [a, b] = groups[0]!.rows;
    assert.equal(a!.badged, true);
    assert.equal(a!.selected, false);
    assert.equal(b!.badged, false);
    assert.equal(b!.selected, true);
});

test('buildRosterGroups localizes the group label', () => {
    const en = buildRosterGroups([card('a', 'waiting_for_you')], 'en', NOW, new Set(), null);
    const fr = buildRosterGroups([card('a', 'waiting_for_you')], 'fr', NOW, new Set(), null);
    assert.equal(en[0]!.label, 'Waiting for you');
    assert.equal(fr[0]!.label, 'En attente de vous');
});

test('buildRosterGroups returns nothing for an empty roster', () => {
    assert.deepEqual(buildRosterGroups([], 'en', NOW, new Set(), null), []);
});
