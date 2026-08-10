import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STATES, isAgentState, acceptsInput, type AgentState } from './agent-state.ts';

test('every declared state narrows', () => {
    for (const state of Object.values(AGENT_STATES)) {
        assert.equal(isAgentState(state), true, state + ' should narrow');
    }
});

test('anything else does not narrow', () => {
    for (const value of ['', 'busy', 'IDLE', null, undefined, 42, {}, ['idle']]) {
        assert.equal(isAgentState(value), false, JSON.stringify(value) + ' should not narrow');
    }
});

test('only idle accepts input', () => {
    // The rule this encodes was reproduced live: a message written while a
    // prompt is up becomes the answer to that prompt.
    assert.equal(acceptsInput(AGENT_STATES.IDLE), true);

    const refused: AgentState[] = [
        AGENT_STATES.WORKING,
        AGENT_STATES.WAITING,
        AGENT_STATES.RATE_LIMITED,
        AGENT_STATES.CRASHED,
        AGENT_STATES.NEEDS_TRUST
    ];
    for (const state of refused) {
        assert.equal(acceptsInput(state), false, state + ' must not accept input');
    }
});

test('the union and the runtime list cannot drift apart', () => {
    // If a state is added to the object and forgotten elsewhere, this is the
    // cheapest place for it to show up.
    assert.equal(Object.values(AGENT_STATES).length, 6);
    assert.equal(new Set(Object.values(AGENT_STATES)).size, 6, 'states must be distinct');
});
