/**
 * Turns a colleague state transition into a channel timeline row, when it earns
 * one.
 *
 * The cut is the design heart: a timeline line is a moment the person acts on or a
 * real team moment, not an ambient blip the card already carries. Lining every
 * transition trains the person to stop reading the timeline, which kills its whole
 * value, the same signal-versus-noise that made the roster's one amber card
 * trustworthy.
 *
 * This does not classify events or recompute state. It reads the transition the
 * registry already produced, the same one the roster reacts to, and decides
 * whether that state earns a row. A row is written only on a real change, so a
 * repeated transition into the same state does not double-insert, because the
 * registry only reports a change when the state actually changes.
 *
 * The event row carries the colleague (its sender) and the state (in the body, a
 * stable enum rather than a rendered English phrase, so the view can render it per
 * language). It has no artifact reference: state events point at nothing. Task
 * completions and diffs earn rows later, when task dispatch exists, and they fill
 * the reference.
 */

import { AGENT_STATES, type AgentState } from '../../domain/agent-state.ts';
import { CHANNEL_KINDS, type ChannelMessage } from '../../domain/models.ts';

/**
 * The states that earn a timeline row. A question and the two failures the person
 * must clear, plus rate-limited, a sustained blocked state the person plans around
 * rather than an ambient flap.
 */
const TIMELINE_STATES: readonly AgentState[] = [
    AGENT_STATES.WAITING,
    AGENT_STATES.CRASHED,
    AGENT_STATES.NEEDS_TRUST,
    AGENT_STATES.RATE_LIMITED
];

/**
 * Whether a transition into this state earns a timeline row. working and idle are
 * ambient and stay on the card; not_reporting is uncertainty the person cannot act
 * on and it flaps (attach late, drop, reattach), so it stays on the card too.
 */
export function stateEarnsChannelLine(state: AgentState): boolean {
    return TIMELINE_STATES.includes(state);
}

/** Builds the event row for a qualifying transition. */
export function channelEventFor(input: {
    id: string; projectId: string; hireId: string; state: AgentState; at: string;
}): ChannelMessage {
    return {
        id: input.id,
        projectId: input.projectId,
        senderId: input.hireId,
        kind: CHANNEL_KINDS.EVENT,
        // The stable state enum, not a rendered phrase, so the view renders it per
        // language with the colleague's name.
        body: input.state,
        reference: null,
        at: input.at
    };
}

/** The slice of the channel repository this needs. Injected, so it is tested with a stub. */
export interface ChannelSink {
    append(message: ChannelMessage): void;
}

/** A registry transition, the shape SessionRegistry.ingest already returns. */
export interface Transition {
    readonly changed?: boolean;
    readonly hireId?: string;
    readonly projectId?: string;
    readonly state?: AgentState;
}

/**
 * Records a transition as a timeline row if it earns one: a real change into a
 * qualifying state. Returns whether a row was written, so a caller can tell.
 */
export function recordTransition(sink: ChannelSink, t: Transition, at: string, id: string): boolean {
    if (!t.changed || !t.hireId || !t.projectId || !t.state) return false;
    if (!stateEarnsChannelLine(t.state)) return false;
    sink.append(channelEventFor({ id, projectId: t.projectId, hireId: t.hireId, state: t.state, at }));
    return true;
}
