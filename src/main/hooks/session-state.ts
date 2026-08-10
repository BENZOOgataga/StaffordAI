/**
 * Derives a hire's state from Claude Code hook events.
 *
 * **This file must never learn about a transport.** No sockets, no HTTP, no
 * `node:net`, nothing about how an event arrived. That separation is the whole
 * point of the split: the state rules were forced to change once because they
 * lived in the same file as an HTTP server, and a transport decision should
 * never be able to do that again. A test asserts the imports, because a
 * boundary that is only stated is a boundary until someone finds crossing it
 * convenient.
 *
 * State comes from hooks only. Never from terminal output, and never from what
 * an agent says about itself.
 */

import { AGENT_STATES, type AgentState } from '../../domain/agent-state.ts';

/**
 * The six events Stafford registers. `PreToolUse` and `PostToolUse` are
 * deliberately absent: each hook costs a process spawn, measured at 32ms on
 * Benzoo's machine before the forwarder does any work, and registering both
 * per-tool events adds roughly 180ms to every tool call in every Claude Code
 * session on the machine.
 */
export const REGISTERED_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'Notification',
    'Stop',
    'SubagentStop',
    'SessionEnd'
] as const;

export type RegisteredEvent = (typeof REGISTERED_EVENTS)[number];

export interface HookEvent {
    readonly event: string;
    readonly sessionId?: string | undefined;
    readonly agentId?: string | undefined;
    readonly cwd?: string | undefined;
    readonly message?: string | undefined;
    readonly at?: string | undefined;
}

export interface SessionSnapshot {
    readonly sessionId: string;
    readonly agentId: string | null;
    readonly state: AgentState;
    readonly cwd: string | null;
    /**
     * Apprentices this session has finished during the current task.
     *
     * Not a live count: `SubagentStop` is registered and `PreToolUse` is not,
     * so only the decrement's source event survives and a live figure is not
     * derivable. Renamed rather than kept with new semantics, so nobody reads
     * the old meaning off the new number. Reset when a task starts, because a
     * monotonic counter with no reset point quietly becomes a lifetime counter,
     * and a lifetime number on a card is trivia.
     */
    readonly subagentsCompleted: number;
    readonly lastEventAt: string | null;
    readonly sawSessionStart: boolean;
    readonly sawSessionEnd: boolean;
}

/**
 * Rate limit arrives as a notification rather than a distinct event, so this is
 * the one place the message text is read. Narrow and case-insensitive on
 * purpose: the queue must pause rather than retry, and a false positive there
 * stalls work that could have run.
 */
const RATE_LIMIT_HINTS = [/rate limit/i, /usage limit/i, /limit reached/i];

export function looksRateLimited(message: string | undefined): boolean {
    if (!message) return false;
    return RATE_LIMIT_HINTS.some((re) => re.test(message));
}

/**
 * The state an event implies, or null when it carries no state meaning.
 *
 * `PreToolUse` still maps, even though nothing registers it. A defensive
 * mapping costs nothing and someone will register it by hand eventually.
 */
export function stateFor(event: HookEvent): AgentState | null {
    switch (event.event) {
        case 'SessionStart':
            return AGENT_STATES.IDLE;
        case 'UserPromptSubmit':
        case 'PreToolUse':
            return AGENT_STATES.WORKING;
        case 'Notification':
            return looksRateLimited(event.message) ? AGENT_STATES.RATE_LIMITED : AGENT_STATES.WAITING;
        case 'Stop':
        case 'SessionEnd':
            return AGENT_STATES.IDLE;
        default:
            return null;
    }
}

export function emptySession(sessionId: string): SessionSnapshot {
    return {
        sessionId,
        agentId: null,
        state: AGENT_STATES.IDLE,
        cwd: null,
        subagentsCompleted: 0,
        lastEventAt: null,
        sawSessionStart: false,
        sawSessionEnd: false
    };
}

/**
 * Applies one event to a snapshot and returns the next one.
 *
 * Pure: no mutation, no clock, no I/O. The caller supplies `at` when the event
 * did not carry one, so this stays deterministic and testable.
 */
export function applyEvent(previous: SessionSnapshot, event: HookEvent, now: string): SessionSnapshot {
    const next = stateFor(event);

    return {
        sessionId: previous.sessionId,
        // First write wins. An agent id is bound once per spawn, and a later
        // event claiming a different one is ignored rather than believed.
        agentId: previous.agentId ?? event.agentId ?? null,
        state: next ?? previous.state,
        cwd: event.cwd ?? previous.cwd,
        subagentsCompleted:
            event.event === 'SubagentStop'
                ? previous.subagentsCompleted + 1
                : previous.subagentsCompleted,
        lastEventAt: event.at ?? now,
        sawSessionStart: previous.sawSessionStart || event.event === 'SessionStart',
        sawSessionEnd: previous.sawSessionEnd || event.event === 'SessionEnd'
    };
}

/** Zeroes the per-task counter. Called when a task starts, not when one ends. */
export function startTask(snapshot: SessionSnapshot): SessionSnapshot {
    return { ...snapshot, subagentsCompleted: 0 };
}
