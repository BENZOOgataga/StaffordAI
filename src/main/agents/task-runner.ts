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

/**
 * A send-back: continue an existing session with my note as the next instruction.
 *
 * The session and the note travel together as one option rather than two, because a note
 * without a session is a restart and a session without a note is just another turn. Neither
 * of those is a send-back, and letting a caller set one without the other would make both
 * expressible by accident.
 */
export interface TaskContinuation {
    /** The task's prior Claude session, to resume. Null forces the restart path below. */
    readonly sessionId: string | null;
    /** My feedback, which becomes the first turn's instruction. */
    readonly note: string;
    /** The colleague's last closing account, used only if the session cannot be resumed. */
    readonly priorSummary: string;
}

export interface TaskRunDeps {
    readonly runTurn: RunTaskTurn;
    /** Set for a send-back: resume the task's session and open with my note. */
    readonly continuation?: TaskContinuation;
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

/**
 * The instruction that restarts a task I sent back.
 *
 * The whole value of a send-back is that the colleague builds on what it already did with my
 * correction, rather than doing the job again from nothing. So this is written as the next
 * thing said in a conversation that is already under way: it does not restate the task, does
 * not re-explain the marker convention beyond the reminder, and says plainly that the earlier
 * work stands unless the note contradicts it.
 *
 * It carries no summary of the prior work, because when this prompt is used the session is
 * being resumed and the colleague can already see everything it did. The fallback below is
 * the one that has to reconstruct that.
 */
export function taskSendBackPrompt(note: string): string {
    return [
        'I have reviewed your work on this task and I am sending it back for changes.',
        '',
        'What I want different:',
        note,
        '',
        'Keep what you already did unless the above contradicts it, and change what I asked for.',
        'This is a continuation, not a fresh start.',
        '',
        'When the task is genuinely finished, end your final message with this exact marker on',
        'its own line:',
        TASK_DONE_SENTINEL,
        '',
        'If you cannot do what I asked, say why and stop rather than guessing.'
    ].join('\n');
}

/**
 * The same, for when the prior session could not be resumed.
 *
 * A lost session is the one case where the colleague genuinely cannot see its earlier work,
 * so the prompt has to hand it back what there is: the original task, its own closing account
 * of what it did, and my note. That is weaker than resuming, and it says so, because a
 * colleague told to continue from work it cannot see would otherwise assume the files are as
 * it left them and be wrong about what it already changed.
 *
 * The files themselves are still on disk, which is why this is recoverable at all: it is told
 * to look rather than to trust the summary.
 */
export function taskSendBackRestartPrompt(instruction: string, priorSummary: string, note: string): string {
    return [
        'You worked on this task before, but that session could not be resumed, so you cannot',
        'see your earlier messages. Your earlier changes are still in the working tree.',
        '',
        'The task was:',
        instruction,
        '',
        priorSummary.trim() === ''
            ? 'You left no account of what you did, so check the working tree before changing anything.'
            : 'What you reported doing last time:\n' + priorSummary,
        '',
        'I have reviewed it and I want this different:',
        note,
        '',
        'Read the current state of the files before you change them, rather than assuming what',
        'is there. When the task is genuinely finished, end your final message with this exact',
        'marker on its own line:',
        TASK_DONE_SENTINEL
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
    // A send-back resumes the task's own session, so the colleague opens the turn already
    // able to see everything it did. A first attempt starts from null, as before.
    let sessionId: string | null = deps.continuation?.sessionId ?? null;
    // Set once the resume has been abandoned, so the fallback is tried exactly one time and a
    // repeatedly unresumable session cannot spend the bound rediscovering that.
    let restarted = false;
    // Whether the next turn is still the opening one. Tracked apart from the loop index
    // because a send-back that loses its session retries the opening turn, which spends a
    // turn from the bound without advancing the conversation.
    let opening = true;
    let summary = '';
    let turns = 0;
    // Accumulated across turns, since a colleague may create a file early and only say so
    // at the end, or name files as it goes. De-duplicated by the parser.
    let outputs: string[] = [];

    for (let i = 0; i < limit; i += 1) {
        const text = turnText(deps, instruction, opening, restarted);
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
            // The one exception: a send-back whose first turn died while resuming a session.
            // A session that cannot be resumed is a recoverable situation and not a dead task,
            // because the colleague's earlier changes are still on disk. So drop the resume
            // and try once more from a fresh session, telling it what it cannot see. Only
            // once, and only on the first turn, so this cannot become a retry loop.
            if (deps.continuation && !restarted && opening && sessionId !== null) {
                restarted = true;
                sessionId = null;
                // `opening` stays true: the conversation has not advanced, so the next turn is
                // still the one that has to carry my note.
                continue;
            }
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

        opening = false;
    }

    return {
        reason: 'turn-limit', turns, summary, sessionId,
        detail: 'stopped after ' + String(limit) + ' turns without saying it was finished',
        outputs
    };
}

/**
 * The text for one turn: the opening, a send-back, a send-back that lost its session, or the
 * plain nudge. Split out because the four cases read as a table and inlining them made the
 * loop about prompt selection rather than about when to stop.
 */
function turnText(deps: TaskRunDeps, instruction: string, opening: boolean, restarted: boolean): string {
    if (!opening) return taskContinuationPrompt();
    const c = deps.continuation;
    if (!c) return taskOpeningPrompt(instruction);
    return restarted
        ? taskSendBackRestartPrompt(instruction, c.priorSummary, c.note)
        : taskSendBackPrompt(c.note);
}
