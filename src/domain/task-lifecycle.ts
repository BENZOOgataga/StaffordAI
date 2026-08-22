/**
 * The task lifecycle, and the one rule that matters: only I close a task.
 *
 * Pure, like the permission resolver, and for the same reason. Whether a transition is legal
 * has nothing to do with the database, the runner or the filesystem, and keeping it here means
 * the invariant can be tested exhaustively rather than argued about.
 *
 * **The invariant.** A colleague can never move a task to done. It reports what it did and
 * stops; I decide whether that was acceptable. This mirrors the permission invariant exactly:
 * there, only I say what a colleague may do, and here, only I say whether what it did was
 * good enough. Both are enforced by where the write happens rather than by convention, and
 * both are stated as an actor on the transition rather than left implicit in which code path
 * happens to call which function.
 *
 * `canTransition` takes the actor for that reason. A function that only took the two states
 * would be a rule about shapes; taking the actor makes it a rule about who, which is the
 * actual invariant.
 */

export const TASK_STATES = {
    ASSIGNED: 'assigned',
    WORKING: 'working',
    NEEDS_YOU: 'needs-you',
    DONE: 'done',
    FAILED: 'failed'
} as const;

export type TaskState = (typeof TASK_STATES)[keyof typeof TASK_STATES];

export const TASK_STATE_VALUES: readonly TaskState[] = [
    TASK_STATES.ASSIGNED, TASK_STATES.WORKING, TASK_STATES.NEEDS_YOU, TASK_STATES.DONE, TASK_STATES.FAILED
];

/**
 * Who is asking for the transition.
 *
 * `owner` is me, acting through Stafford's own UI over IPC. `colleague` is the runner, moving
 * a task as it works it. There is no third actor, and adding one should be a deliberate act
 * rather than a new string appearing somewhere.
 */
export type TaskActor = 'owner' | 'colleague';

/** True when the state is terminal: nothing moves out of done or failed. */
export function isTerminal(state: TaskState): boolean {
    return state === TASK_STATES.DONE || state === TASK_STATES.FAILED;
}

/**
 * Whether `actor` may move a task from `from` to `to`.
 *
 * The table, in words. I assign and start. The colleague moves working to needs-you when it
 * finishes an attempt, hits an ask, or runs out of turns, and may fail a task it genuinely
 * cannot proceed with. I move needs-you to done or to failed. Nothing leaves a terminal state,
 * so an approved task cannot be quietly reopened.
 *
 * The two entries worth reading twice are the ones that say no: a colleague may not reach done
 * from any state, and a colleague may not move a task out of needs-you, because needs-you means
 * waiting on me and a colleague resuming itself would make that a lie.
 */
export function canTransition(actor: TaskActor, from: TaskState, to: TaskState): boolean {
    if (from === to) return false;
    if (isTerminal(from)) return false;

    // The invariant, first and unconditional, so it cannot be lost in the table below.
    if (actor === 'colleague' && to === TASK_STATES.DONE) return false;

    if (actor === 'colleague') {
        // A colleague only ever acts on a task it is actively working.
        if (from !== TASK_STATES.WORKING) return false;
        return to === TASK_STATES.NEEDS_YOU || to === TASK_STATES.FAILED;
    }

    // owner
    switch (from) {
        case TASK_STATES.ASSIGNED:
            return to === TASK_STATES.WORKING || to === TASK_STATES.FAILED;
        case TASK_STATES.WORKING:
            // I can pull a running task back for review, or abandon it.
            return to === TASK_STATES.NEEDS_YOU || to === TASK_STATES.FAILED;
        case TASK_STATES.NEEDS_YOU:
            // Approve, abandon, or send it back to work. Send-back's continuation prompt is
            // phase 2; the transition is legal here so the state machine does not have to
            // change when it lands.
            return to === TASK_STATES.DONE || to === TASK_STATES.FAILED || to === TASK_STATES.WORKING;
        default:
            return false;
    }
}

/** Why a transition was refused, for a message worth reading. Null when it is allowed. */
export function refusalReason(actor: TaskActor, from: TaskState, to: TaskState): string | null {
    if (canTransition(actor, from, to)) return null;
    if (actor === 'colleague' && to === TASK_STATES.DONE) {
        return 'a colleague can never close its own task; it reports what it did and I decide';
    }
    if (isTerminal(from)) return 'this task is already ' + from + ', which is terminal';
    if (from === to) return 'the task is already ' + from;
    return actor + ' cannot move a task from ' + from + ' to ' + to;
}

/** True iff the value is a known state, so a stray string cannot become a lifecycle. */
export function isTaskState(value: unknown): value is TaskState {
    return typeof value === 'string' && (TASK_STATE_VALUES as readonly string[]).includes(value);
}

/**
 * The sentinel a colleague ends its final message with to say the task is complete.
 *
 * Explicit rather than inferred. A turn that made no tool calls is not a finished task, since
 * a colleague can spend a whole turn thinking, and treating that as done would close work that
 * had not happened. So completion is something the colleague states.
 *
 * It fails in the safe direction. A colleague that forgets the sentinel burns a turn and, at
 * the bound, lands in needs-you for me to look at, which costs a review I did not need. The
 * opposite mistake, inferring completion that did not happen, closes a task silently and is
 * not recoverable by noticing.
 *
 * Distinctive on purpose: a colleague discussing the idea of finishing should not accidentally
 * emit it, so it is not a word anyone would write by accident.
 */
export const TASK_DONE_SENTINEL = '<<STAFFORD-TASK-COMPLETE>>';

/** True when a colleague's message claims the task is complete. */
export function claimsComplete(text: string): boolean {
    return text.includes(TASK_DONE_SENTINEL);
}

/** The reply with the sentinel removed, so the summary I read is not littered with it. */
export function stripSentinel(text: string): string {
    return text.split(TASK_DONE_SENTINEL).join('').trim();
}

/**
 * How many turns one task may take before it stops and asks for me.
 *
 * Bounded because the whole point is that I walk away, and an unattended thing with no bound
 * is the one shape I cannot supervise. Low rather than generous: the cost of too low is a
 * review I did not need, and the cost of too high is a colleague grinding unwatched. Hitting
 * the bound is not a failure, it lands in needs-you and I judge it.
 */
export const DEFAULT_TASK_TURN_LIMIT = 6;
