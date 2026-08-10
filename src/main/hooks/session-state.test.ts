import test from 'node:test';
import assert from 'node:assert/strict';
import {
    stateFor, looksRateLimited, applyEvent, emptySession, startTask, REGISTERED_EVENTS
} from './session-state.ts';
import { AGENT_STATES } from '../../domain/agent-state.ts';

const NOW = '2026-08-07T12:00:00.000Z';

// ---------------------------------------------------------------------------
// The boundary the split exists to create.
// ---------------------------------------------------------------------------

test('state derivation imports no transport', async () => {
    // The rules were forced to change once because they lived in the same file
    // as an HTTP server. A test rather than a note, because a boundary that is
    // only stated holds until someone finds crossing it convenient.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');

    // Transitive, not direct. A direct check passes while the one file it
    // allows quietly imports node:net, which defeats the boundary entirely.
    // agent-state.ts is a leaf today and nothing asserts it stays one.
    const TRANSPORT = /^node:(net|http|https|http2|dgram|tls)$/;

    const visited = new Set<string>();
    const reached: string[] = [];

    function inspect(file: string, via: string[]): void {
        if (visited.has(file)) return;
        visited.add(file);
        reached.push(nodePath.basename(file));

        // Comments are stripped first. The rule is about what the file does,
        // not what it says, and the first version of this test failed on the
        // word "sockets" inside the comment explaining that there are none.
        const source = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');

        const specifiers = [
            ...[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
            ...[...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
            ...[...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
        ].filter((s): s is string => typeof s === 'string');

        for (const specifier of specifiers) {
            const chain = [...via, nodePath.basename(file)];
            assert.doesNotMatch(
                specifier, TRANSPORT,
                'a transport reached state derivation through ' + chain.join(' -> ') +
                ' -> ' + specifier + '. State derivation must not know how an event arrived.'
            );
            if (specifier.startsWith('.')) {
                inspect(nodePath.resolve(nodePath.dirname(file), specifier), chain);
            }
        }
    }

    const entry = fileURLToPath(new URL('./session-state.ts', import.meta.url));
    inspect(entry, []);

    // The walk has to actually walk, or it proves nothing.
    assert.ok(reached.length >= 2, 'the import walk did not follow anything: ' + reached.join(', '));
    assert.deepEqual(reached, ['session-state.ts', 'agent-state.ts']);
});

// ---------------------------------------------------------------------------
// Ported, and checked against the current rules rather than the original ones.
// ---------------------------------------------------------------------------

test('stateFor maps events to states', () => {
    assert.equal(stateFor({ event: 'SessionStart' }), AGENT_STATES.IDLE);
    assert.equal(stateFor({ event: 'UserPromptSubmit' }), AGENT_STATES.WORKING);
    assert.equal(stateFor({ event: 'Stop' }), AGENT_STATES.IDLE);
    assert.equal(stateFor({ event: 'SessionEnd' }), AGENT_STATES.IDLE);
    assert.equal(stateFor({ event: 'Notification', message: 'needs your input' }), AGENT_STATES.WAITING);
    assert.equal(stateFor({ event: 'SubagentStop' }), null, 'carries no state meaning');
    assert.equal(stateFor({ event: 'PostToolUse' }), null);
});

test('working comes from UserPromptSubmit, not from a per-tool event', () => {
    // The rule changed after the original tests were written. PreToolUse and
    // PostToolUse are not registered, so a session that only ever saw per-tool
    // events would never be seen working at all.
    assert.equal(REGISTERED_EVENTS.includes('UserPromptSubmit' as never), true);
    assert.equal(REGISTERED_EVENTS.includes('PreToolUse' as never), false);
    assert.equal(REGISTERED_EVENTS.includes('PostToolUse' as never), false);

    let session = emptySession('s1');
    session = applyEvent(session, { event: 'SessionStart' }, NOW);
    assert.equal(session.state, AGENT_STATES.IDLE);

    session = applyEvent(session, { event: 'UserPromptSubmit' }, NOW);
    assert.equal(session.state, AGENT_STATES.WORKING, 'working must be reachable without any per-tool event');

    session = applyEvent(session, { event: 'Stop' }, NOW);
    assert.equal(session.state, AGENT_STATES.IDLE);
});

test('the defensive PreToolUse mapping survives, unregistered', () => {
    // Costs nothing, and someone will register it by hand eventually.
    assert.equal(stateFor({ event: 'PreToolUse' }), AGENT_STATES.WORKING);
});

test('rate limit notifications are not treated as waiting for input', () => {
    assert.equal(looksRateLimited('You have hit the rate limit'), true);
    assert.equal(looksRateLimited('usage limit reached for today'), true);
    assert.equal(looksRateLimited('Claude needs your permission'), false);
    assert.equal(looksRateLimited(undefined), false);

    assert.equal(
        stateFor({ event: 'Notification', message: 'usage limit reached' }),
        AGENT_STATES.RATE_LIMITED,
        'the queue must pause rather than retry'
    );
});

// ---------------------------------------------------------------------------
// The two fields whose meaning changed
// ---------------------------------------------------------------------------

test('there is no activity field on the snapshot', () => {
    // Removed rather than left unpopulated: its only sources were the two
    // per-tool events, and the live output tail answers the same question
    // better and continuously.
    const session = applyEvent(emptySession('s1'), { event: 'UserPromptSubmit' }, NOW);
    assert.equal('activity' in session, false, 'a field nothing populates is worse than no field');
});

test('subagentsCompleted counts up from SubagentStop and never down', () => {
    let session = emptySession('s1');
    assert.equal(session.subagentsCompleted, 0);

    session = applyEvent(session, { event: 'SubagentStop' }, NOW);
    session = applyEvent(session, { event: 'SubagentStop' }, NOW);
    assert.equal(session.subagentsCompleted, 2);

    // Nothing decrements it. A live count is not derivable without PreToolUse,
    // and pretending otherwise gives a number that only ever goes negative.
    session = applyEvent(session, { event: 'Stop' }, NOW);
    assert.equal(session.subagentsCompleted, 2);
});

test('subagentsCompleted resets when a task starts', () => {
    let session = emptySession('s1');
    session = applyEvent(session, { event: 'SubagentStop' }, NOW);
    session = applyEvent(session, { event: 'SubagentStop' }, NOW);
    assert.equal(session.subagentsCompleted, 2);

    // Per task, not per session and not lifetime. Without the reset it becomes
    // a lifetime counter by default, and a lifetime number on a card is trivia.
    assert.equal(startTask(session).subagentsCompleted, 0);
    assert.equal(startTask(session).state, session.state, 'a reset changes nothing else');
});

// ---------------------------------------------------------------------------
// Binding and bookkeeping
// ---------------------------------------------------------------------------

test('the agent id binds once and a later claim is ignored', () => {
    let session = applyEvent(emptySession('s1'), { event: 'SessionStart', agentId: 'marion' }, NOW);
    assert.equal(session.agentId, 'marion');

    session = applyEvent(session, { event: 'UserPromptSubmit', agentId: 'theo' }, NOW);
    assert.equal(session.agentId, 'marion', 'a rebind within a spawn is refused, not believed');
});

test('SessionStart and SessionEnd are remembered, for the exit classification', () => {
    let session = emptySession('s1');
    assert.deepEqual([session.sawSessionStart, session.sawSessionEnd], [false, false]);

    session = applyEvent(session, { event: 'SessionStart' }, NOW);
    assert.deepEqual([session.sawSessionStart, session.sawSessionEnd], [true, false]);

    session = applyEvent(session, { event: 'SessionEnd' }, NOW);
    assert.deepEqual([session.sawSessionStart, session.sawSessionEnd], [true, true]);
});

test('applying an event does not mutate the previous snapshot', () => {
    const before = emptySession('s1');
    const after = applyEvent(before, { event: 'UserPromptSubmit', cwd: 'C:/repo' }, NOW);

    assert.equal(before.state, AGENT_STATES.IDLE);
    assert.equal(before.cwd, null);
    assert.equal(after.state, AGENT_STATES.WORKING);
    assert.equal(after.cwd, 'C:/repo');
});

test('an event carrying no state meaning leaves the state alone', () => {
    let session = applyEvent(emptySession('s1'), { event: 'UserPromptSubmit' }, NOW);
    session = applyEvent(session, { event: 'SubagentStop' }, NOW);
    assert.equal(session.state, AGENT_STATES.WORKING, 'an apprentice finishing does not mean the parent stopped');
});

test('the timestamp comes from the event when it has one, and the caller otherwise', () => {
    const carried = applyEvent(emptySession('s1'), { event: 'Stop', at: '2020-01-01T00:00:00.000Z' }, NOW);
    assert.equal(carried.lastEventAt, '2020-01-01T00:00:00.000Z');

    const supplied = applyEvent(emptySession('s1'), { event: 'Stop' }, NOW);
    assert.equal(supplied.lastEventAt, NOW, 'no clock is read in here, so it stays deterministic');
});
