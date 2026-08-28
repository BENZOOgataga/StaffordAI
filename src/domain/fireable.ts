/**
 * Whether a colleague may be fired right now, and if not, the reason to show the person.
 *
 * The rule is that a colleague is fireable only from a settled state, idle or Blocked, with no
 * non-terminal task and no pending ask. Everything else is refused with a concrete message that names
 * what to resolve first, never a generic cannot-remove. Firing from under an in-flight turn, an
 * unreviewed task, or a paused ask would lose work or a record, so the guard refuses those.
 *
 * Kept pure and in the domain so it is tested without the main process, and so the one authoritative
 * check in the fire action reads from the same logic the UI uses to disable the button. The block on a
 * pending review is deliberate: under archive the review survives a fire, so this is clarity rather
 * than data safety, but a fired colleague holding an open review reads as broken.
 */

import { AGENT_STATES } from './agent-state.ts';
import { TASK_STATES } from './task-lifecycle.ts';

export type Fireable =
    | { readonly fireable: true }
    | { readonly fireable: false; readonly reason: string; readonly reasonFr: string };

export interface FireableInput {
    /** The colleague's roster state. */
    readonly state: string;
    /** The states of this colleague's own tasks. Only non-terminal ones block; terminal ones do not. */
    readonly taskStates: readonly string[];
    /** True when the colleague has a permission ask waiting on the person. */
    readonly hasPendingAsk: boolean;
}

function refuse(reason: string, reasonFr: string): Fireable {
    return { fireable: false, reason, reasonFr };
}

export function checkFireable(input: FireableInput): Fireable {
    // A pending ask is the most immediate blocker, and its own kind of unresolved thing, so it is named
    // before the task and state checks.
    if (input.hasPendingAsk) {
        return refuse(
            'This colleague has a permission request waiting. Answer or deny it first.',
            "Ce collègue a une demande d'autorisation en attente. Répondez-y ou refusez-la d'abord."
        );
    }

    // Non-terminal tasks, named per state. The review is named as a review, since that is the block the
    // person most needs to understand and the one whose record would look lost.
    if (input.taskStates.includes(TASK_STATES.NEEDS_YOU)) {
        return refuse(
            'This colleague has a task waiting for your review. Resolve it first.',
            'Ce collègue a une tâche en attente de votre revue. Traitez-la d\'abord.'
        );
    }
    if (input.taskStates.includes(TASK_STATES.WORKING)) {
        return refuse(
            'This colleague is working on a task. Wait or interrupt it first.',
            'Ce collègue travaille sur une tâche. Attendez ou interrompez-la d\'abord.'
        );
    }
    if (input.taskStates.includes(TASK_STATES.ASSIGNED)) {
        return refuse(
            'This colleague has a task assigned. Resolve it first.',
            'Ce collègue a une tâche assignée. Traitez-la d\'abord.'
        );
    }

    // A chat turn in flight, with no task involved.
    if (input.state === AGENT_STATES.WORKING) {
        return refuse(
            'This colleague is working. Wait or interrupt it first.',
            'Ce collègue travaille. Attendez ou interrompez-le d\'abord.'
        );
    }

    // Fireable from a settled state, which is one with no live process and no unresolved work: idle,
    // Blocked (not_reporting), crashed, or needs_trust. None of these has a running process, so nothing
    // is lost by removing it, and a colleague stuck in crashed or needs_trust with no way off the roster
    // is worse than allowing the removal. The states left refused are the ones with a live turn or a
    // thing waiting on the person: working, waiting_for_you, rate_limited, and any others.
    if (
        input.state === AGENT_STATES.IDLE ||
        input.state === AGENT_STATES.NOT_REPORTING ||
        input.state === AGENT_STATES.CRASHED ||
        input.state === AGENT_STATES.NEEDS_TRUST
    ) {
        return { fireable: true };
    }

    return refuse(
        'This colleague is not idle right now. Wait until it settles, then remove it.',
        "Ce collègue n'est pas inactif pour le moment. Attendez qu'il se stabilise, puis retirez-le."
    );
}
