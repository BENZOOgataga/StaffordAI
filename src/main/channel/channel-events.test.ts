/**
 * The which-transitions-earn-a-line cut, and the row a qualifying transition
 * produces. A stub sink stands in for the repository so this is pure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    stateEarnsChannelLine, channelEventFor, recordTransition, type ChannelSink
} from './channel-events.ts';
import { AGENT_STATES } from '../../domain/agent-state.ts';
import type { ChannelMessage } from '../../domain/models.ts';

function sink(): { sink: ChannelSink; rows: ChannelMessage[] } {
    const rows: ChannelMessage[] = [];
    return { sink: { append: (m) => rows.push(m) }, rows };
}

const QUALIFY = [AGENT_STATES.WAITING, AGENT_STATES.CRASHED, AGENT_STATES.NEEDS_TRUST, AGENT_STATES.RATE_LIMITED];
const CARD_ONLY = [AGENT_STATES.WORKING, AGENT_STATES.IDLE, AGENT_STATES.NOT_REPORTING];

test('the qualifying states earn a timeline line', () => {
    for (const state of QUALIFY) {
        assert.equal(stateEarnsChannelLine(state), true, state + ' should earn a line');
    }
});

test('the card-only states do not earn a timeline line', () => {
    for (const state of CARD_ONLY) {
        assert.equal(stateEarnsChannelLine(state), false, state + ' should stay on the card');
    }
});

test('a transition into a qualifying state writes one event row with the hire and state', () => {
    for (const state of QUALIFY) {
        const { sink: s, rows } = sink();
        const wrote = recordTransition(
            s, { changed: true, hireId: 'h1', projectId: 'p1', state }, '2026-08-13T00:00:00Z', 'id-' + state
        );
        assert.equal(wrote, true);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0], {
            id: 'id-' + state, projectId: 'p1', senderId: 'h1', targetHireId: null, kind: 'event',
            body: state, reference: null, at: '2026-08-13T00:00:00Z', synthetic: false
        });
    }
});

test('a transition into a card-only state writes no row', () => {
    for (const state of CARD_ONLY) {
        const { sink: s, rows } = sink();
        const wrote = recordTransition(s, { changed: true, hireId: 'h1', projectId: 'p1', state }, 'at', 'id');
        assert.equal(wrote, false);
        assert.equal(rows.length, 0);
    }
});

test('a non-change writes no row, so a repeated transition does not double-insert', () => {
    const { sink: s, rows } = sink();
    // changed is false: the registry only reports a change on a real state change,
    // so a repeated waiting event does not reach here as a change and no row lands.
    const wrote = recordTransition(
        s, { changed: false, hireId: 'h1', projectId: 'p1', state: AGENT_STATES.WAITING }, 'at', 'id'
    );
    assert.equal(wrote, false);
    assert.equal(rows.length, 0);
});

test('a transition missing its hire or project writes nothing rather than a half row', () => {
    const { sink: s, rows } = sink();
    recordTransition(s, { changed: true, state: AGENT_STATES.WAITING }, 'at', 'id');
    recordTransition(s, { changed: true, hireId: 'h1', state: AGENT_STATES.WAITING }, 'at', 'id');
    assert.equal(rows.length, 0);
});

test('channelEventFor builds an event row that carries the state in its body, no reference', () => {
    const row = channelEventFor({
        id: 'e1', projectId: 'p1', hireId: 'marion', state: AGENT_STATES.WAITING, at: '2026-08-13T00:00:00Z'
    });
    assert.equal(row.kind, 'event');
    assert.equal(row.senderId, 'marion', 'the colleague is the sender');
    assert.equal(row.body, 'waiting_for_you', 'the stable state enum, for the view to render per language');
    assert.equal(row.reference, null, 'a state event points at no artifact');
});
