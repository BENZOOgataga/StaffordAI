/**
 * Runs one task to a stopping point, so I can assign it and walk away.
 *
 * This is phase 1 of docs/plans/TASKS.md. It is deliberately thin: it owns the turn loop, the
 * sentinel and the stopping decision, and it owns nothing else. The colleague is driven
 * through the same runner a normal message uses, under the same permission gate, and the
 * result is committed by the same checkpoint mechanism the drain uses. There is no second
 * runner, no second permission notion and no task-specific escape from either.
 *
 * **A task never gets wider permissions than a normal session.** That is worth stating because
 * the opposite is the tempting shortcut: an unattended task stalls on an ask, so it would be
 * easy to loosen the policy to keep it moving, and that would quietly make the least
 * supervised path the least governed one. The gate handed in here is the one the manager
 * builds for that colleague on that project, unchanged.
 *
 * **It never moves a task to done.** It reports what happened and the caller writes the state
 * through the lifecycle rules, where a colleague reaching done is refused outright. This
 * module cannot close a task even by mistake, because it does not decide states at all.
 */

import {
    TASK_DONE_SENTINEL, TASK_OUTPUTS_MARKER, DEFAULT_TASK_TURN_LIMIT,
    claimsComplete, stripSentinel, declaredOutputs
} from '../../domain/task-lifecycle.ts';
import type { TurnResult } from './claude-runner.ts';

/** Why a task run stopped. None of these is "done": only I close a task. */
export type TaskStopReason =
    /** The colleague emitted the sentinel. Its attempt is finished and awaits my review. */
    | 'completed'
    /** A turn ended paused on a permission ask, so the task is waiting on me. */
    | 'awaiting-approval'
    /** The turn bound was spent without a sentinel. Not a failure, a review. */
    | 'turn-limit'
    /** The runner could not run: a dead process, a spawn error, a timeout. */
    | 'runner-error';

export interface TaskRunOutcome {
    readonly reason: TaskStopReason;
    /** How many turns were spent, for the review and for tuning the bound. */
    readonly turns: number;
    /** The colleague's closing message, sentinel stripped. Empty when there was none. */
    readonly summary: string;
    /** The Claude session, so the task's transcript is findable. Null if none started. */
    readonly sessionId: string | null;
    /** A short note for a non-completed stop, shown at review. Never message text. */
    readonly detail: string | null;
    /**
     * New files the colleague named as its deliverable, as it wrote them. Claims, not
     * decisions: every one is validated before anything is staged.
     */
    readonly outputs: readonly string[];
}

/** One turn, as this module needs it. The manager supplies the real runner behind this. */
export type RunTaskTurn = (input: { text: string; resumeSessionId: string | null }) => Promise<TurnResult>;

export interface TaskRunDeps {
    readonly runTurn: RunTaskTurn;
    /** The bound. Injected so a test does not run six real turns. */
    readonly turnLimit?: number;
    /** True while a permission ask is pending for this colleague, checked between turns. */
    readonly isAwaitingApproval?: () => boolean;
}

/**
 * The instruction that starts a task.
 *
 * It tells the colleague three things it cannot infer: that this is a task rather than a
 * chat, that its work will be reviewed by a person before it counts as finished, and exactly
 * how to say it is done. The last one matters most, since completion is claimed rather than
 * detected, and a colleague that does not know the marker cannot emit it.
 *
 * It does not tell the colleague about the turn bound. Knowing it would invite racing the
 * clock, and the bound exists to protect me, not to be optimised against.
 */
export function taskOpeningPrompt(instruction: string): string {
    return [
        'You have been assigned a task in Stafford. Work it to completion on your own.',
        '',
        'The task:',
        instruction,
        '',
        'When, and only when, you consider the task genuinely finished, end your final message',
        'with this exact marker on its own line:',
        TASK_DONE_SENTINEL,
        '',
        'If you create any NEW files that are part of the deliverable, name them in your final',
        'message on a line of this exact form, paths relative to the repository root:',
        TASK_OUTPUTS_MARKER + ' path/one.ts, path/two.md>>',
        'Only new files need naming. Changes to files that already exist are saved without it,',
        'and a file you do not name is left out of the result, so name what matters.',
        '',
        'Your work will be reviewed by a person before the task is closed, so finish with a short',
        'plain account of what you actually did and anything you could not do. Do not claim the',
        'task is complete if it is not; say what is blocking instead and stop.',
        'If a tool call is refused by policy, do not try to work around the refusal. Say what you',
        'needed and why, and stop.'
    ].join('\n');
}

/** The nudge for a turn that ended without the sentinel and without finishing. */
export function taskContinuationPrompt(): string {
    return [
        'Continue the task. If it is now genuinely finished, end your final message with this',
        'exact marker on its own line:',
        TASK_DONE_SENTINEL,
        '',
        'If you are blocked, say what is blocking you and stop rather than guessing.'
    ].join('\n');
}

/**
 * Drives a task until it finishes, is blocked on an ask, spends its turns, or errors.
 *
 * The loop is the whole design decision. One turn is too small, since Claude Code's `result`
 * ends a turn and not a job, and real instructions take several rounds. Unbounded is worse: an
 * unattended thing that keeps going is exactly what I cannot supervise. So it is bounded, and
 * spending the bound lands in review rather than counting as a failure, because a task that
 * ran out of turns might be nearly done and that is my call to make.
 */
export async function runTask(deps: TaskRunDeps, instruction: string): Promise<TaskRunOutcome> {
    const limit = deps.turnLimit ?? DEFAULT_TASK_TURN_LIMIT;
    let sessionId: string | null = null;
    let summary = '';
    let turns = 0;
    // Accumulated across turns, since a colleague may create a file early and only say so
    // at the end, or name files as it goes. De-duplicated by the parser.
    let outputs: string[] = [];

    for (let i = 0; i < limit; i += 1) {
        const text = i === 0 ? taskOpeningPrompt(instruction) : taskContinuationPrompt();
        const result = await deps.runTurn({ text, resumeSessionId: sessionId });
        turns += 1;
        if (result.sessionId) sessionId = result.sessionId;

        const reply = result.assistantText ?? '';
        if (reply.trim() !== '') summary = stripSentinel(reply);
        const named = declaredOutputs(reply);
        if (named.length > 0) outputs = [...new Set([...outputs, ...named])];

        // A dead process or a timeout is not something to retry blindly: the next turn would
        // hit the same wall, and burning the bound to discover that helps nobody.
        if (result.status === 'spawn-error' || result.status === 'exited' || result.status === 'timeout') {
            return {
                reason: 'runner-error', turns, summary, sessionId,
                detail: result.detail ?? result.status, outputs
            };
        }

        // An ask paused this colleague. The turn has ended; the task is waiting on me, and
        // continuing would either hang on the same ask or work around it.
        if (deps.isAwaitingApproval?.()) {
            return {
                reason: 'awaiting-approval', turns, summary, sessionId,
                detail: 'a tool call needs your approval', outputs
            };
        }

        if (claimsComplete(reply)) {
            return { reason: 'completed', turns, summary, sessionId, detail: null, outputs };
        }
    }

    return {
        reason: 'turn-limit', turns, summary, sessionId,
        detail: 'stopped after ' + String(limit) + ' turns without saying it was finished',
        outputs
    };
}
