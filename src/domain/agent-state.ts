/**
 * The states a hire can be in, shared by the main process and the renderer.
 *
 * One definition, imported by both, because the alternative is two that drift.
 * Section 13 of `docs/plans/STAFFORD-PLAN.md` is where these came from.
 *
 * A const object rather than an enum: `erasableSyntaxOnly` is on, and an enum
 * emits runtime code that Node's type stripping cannot generate.
 */

export const AGENT_STATES = {
    IDLE: 'idle',
    WORKING: 'working',
    WAITING: 'waiting_for_you',
    RATE_LIMITED: 'rate_limited',
    CRASHED: 'crashed',
    /**
     * A process that exited having never produced a SessionStart, in a
     * directory Claude Code did not already trust. Measured on Windows:
     * declining a trust prompt exits with code 1 and fires no hook at all, so
     * from outside it is indistinguishable from a crash. Reporting it as a
     * crash would send Benzoo looking for something that did not happen.
     */
    NEEDS_TRUST: 'needs_trust'
} as const;

export type AgentState = (typeof AGENT_STATES)[keyof typeof AGENT_STATES];

const ALL_STATES: readonly string[] = Object.values(AGENT_STATES);

/**
 * Narrows an unknown value to an AgentState.
 *
 * Every state arriving over IPC crosses a trust boundary, so it is checked
 * rather than cast. A cast would compile and then hand the renderer a state
 * nothing knows how to render.
 */
export function isAgentState(value: unknown): value is AgentState {
    return typeof value === 'string' && ALL_STATES.includes(value);
}

/**
 * States in which the runner will not write to a session.
 *
 * Input is only ever written to a provably idle session. A message typed while
 * a prompt is up becomes the answer to that prompt, which was reproduced live
 * against a trust prompt during Task 0.
 */
export function acceptsInput(state: AgentState): boolean {
    return state === AGENT_STATES.IDLE;
}
