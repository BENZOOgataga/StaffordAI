/**
 * The task service: the one place a task's state is ever written.
 *
 * This is phase 1 of docs/plans/TASKS.md, joining pieces that already exist. The lifecycle
 * rules are in domain/task-lifecycle.ts, the turn loop is in agents/task-runner.ts, the
 * permission seam is the gate the manager already builds per turn, and the commit is the
 * drain's checkpoint under a different ref. None of those is reimplemented here. What this
 * module adds is the order they happen in, and the guarantee that the state written at each
 * step was legal for whoever asked for it.
 *
 * **One write point.** Every state change goes through `#write`, which calls `canTransition`
 * with an actor and throws when the answer is no. There is no second path, no direct
 * `tasks.update` with a new state anywhere else in the module, and that is what makes "a
 * colleague can never close its own task" a property of the code rather than a claim about
 * it. The public methods that Benzoo's UI reaches hardcode the owner actor; the run loop
 * hardcodes the colleague actor. Neither takes the actor from a caller, so no payload from
 * anywhere can choose who it is acting as.
 *
 * **Almost nothing auto-fails.** A colleague that stops without saying it finished lands in
 * needs-you, not failed, because a task that ran out of turns might be nearly done and that
 * is my call rather than the machine's. Only a runner that could not run at all is a
 * failure, because there is no work to review in that case.
 *
 * **The result is committed even when the attempt went badly.** A colleague that errored
 * halfway may still have written files worth keeping, and the checkpoint stages tracked
 * modifications only, so committing them costs nothing and losing them cannot be undone.
 */

import {
    TASK_STATES, canTransition, refusalReason, isTerminal,
    type TaskActor, type TaskState
} from '../../domain/task-lifecycle.ts';
import { runTask, type TaskRunOutcome } from '../agents/task-runner.ts';
import { taskBranchName } from '../agents/checkpoint-executor.ts';
import type { CheckpointOutcome } from '../agents/checkpoint-executor.ts';
import type { TurnResult } from '../agents/claude-runner.ts';
import type { Task, TaskKind, TaskOrigin } from '../../domain/models.ts';

/** Thrown when a transition is refused. The message is the lifecycle's own reason. */
export class TaskTransitionError extends Error {
    readonly taskId: string;
    readonly from: TaskState;
    readonly to: TaskState;

    constructor(taskId: string, from: TaskState, to: TaskState, reason: string) {
        super(reason);
        this.name = 'TaskTransitionError';
        this.taskId = taskId;
        this.from = from;
        this.to = to;
    }
}

/** The slice of TaskRepository this service uses, so a test needs no database. */
export interface TaskStore {
    get(id: string): Task | null;
    insert(task: Task): void;
    update(task: Task): void;
}

/** Where a colleague's task runs. Null when the colleague has no resolvable project. */
export interface TaskTarget {
    readonly cwd: string;
    readonly projectId: string;
}

export interface TaskServiceDeps {
    readonly tasks: TaskStore;
    readonly now: () => string;
    readonly uuid: () => string;
    /** Resolves a colleague to the project and working directory its task runs in. */
    readonly resolveTarget: (hireId: string) => TaskTarget | null;
    /**
     * One turn, through the manager's queue and the same permission gate a message uses.
     * Null means no turn could run, which ends the attempt rather than looping on nothing.
     */
    readonly runTurn: (
        hireId: string, text: string, resumeSessionId: string | null
    ) => Promise<TurnResult | null>;
    /**
     * The tracked state of the tree before the colleague's first turn, so the result can be
     * exactly the task's own diff. Null means no baseline could be taken, which costs the
     * isolation but must not stop the task.
     */
    readonly baseline?: (cwd: string) => Promise<string | null>;
    /**
     * Commits the task's own changes to its result branch. `baselineTree` is what the result
     * is diffed against; `outputs` are validated new files to include.
     */
    readonly checkpoint: (req: {
        cwd: string; hireId: string; branch: string; message: string;
        baselineTree: string | null; outputs: readonly string[];
    }) => Promise<CheckpointOutcome>;
    /**
     * Decides which of the new files the colleague named may be staged. Injected because the
     * answer needs git (the ignore list, the index) and the rules are pure. When absent, no
     * declared output is committed, which is the safe direction.
     */
    readonly resolveOutputs?: (
        cwd: string, declared: readonly string[]
    ) => Promise<{ accepted: readonly string[]; refused: string | null }>;
    /** True while a permission ask is pending for this colleague. */
    readonly isAwaitingApproval?: (hireId: string) => boolean;
    /** Signals a task changed, so any open view re-reads. */
    readonly onChanged?: () => void;
    /** The turn bound, injected so a test does not run six real turns. */
    readonly turnLimit?: number;
}

export interface AssignRequest {
    readonly hireId: string;
    readonly text: string;
    readonly kind?: TaskKind;
}

/** What Benzoo decided at review. Send-back returns the task to working for another attempt. */
export type ReviewDecision = 'approve' | 'fail' | 'send-back';

export class TaskService {
    readonly #deps: TaskServiceDeps;

    constructor(deps: TaskServiceDeps) {
        this.#deps = deps;
    }

    /**
     * Creates a task for a colleague, in `assigned`.
     *
     * Assigning does not start it. The two are separate because starting spawns a process
     * that writes to a repository, and an accidental double click on an assign form should
     * cost a row rather than a run.
     */
    assign(req: AssignRequest): Task {
        const text = req.text.trim();
        if (text === '') throw new Error('a task needs an instruction');
        const target = this.#deps.resolveTarget(req.hireId);
        if (!target) throw new Error('that colleague has no project to work in');

        const at = this.#deps.now();
        const origin: TaskOrigin = { kind: 'user' };
        const task: Task = {
            id: this.#deps.uuid(),
            agentId: req.hireId,
            projectId: target.projectId,
            text,
            kind: req.kind ?? 'feature',
            origin,
            approvals: [],
            createdAt: at,
            startedAt: null,
            completedAt: null,
            state: TASK_STATES.ASSIGNED,
            resultBranch: null,
            resultCommit: null,
            resultSummary: null,
            sessionId: null,
            failedReason: null,
            updatedAt: at,
            baselineTree: null,
            declaredOutputs: [],
            refusedOutputs: null
        };
        this.#deps.tasks.insert(task);
        this.#deps.onChanged?.();
        return task;
    }

    /**
     * Starts an assigned task, and hands back both halves of what that means.
     *
     * `task` is the row as it stands the moment the run begins, and it is what an IPC reply
     * returns: the renderer learns the task is working without being held for the minutes a
     * real task takes, which is the entire point of assigning one. `finished` resolves when
     * the attempt is over, and is what a test awaits.
     *
     * Splitting them this way rather than exposing a second entry point keeps a single write
     * path. The transition happens here, synchronously, before anything can run, so two
     * clicks on start cannot become two colleagues in one working tree: the second is refused
     * by the lifecycle because the task is already working.
     */
    start(taskId: string): { task: Task; finished: Promise<Task> } {
        const task = this.#require(taskId);
        const target = this.#deps.resolveTarget(task.agentId);
        if (!target) throw new Error('that colleague has no project to work in');

        // Owner starts. A task already working, or already terminal, is refused here rather
        // than quietly starting a second run against the same working tree.
        const running = this.#write('owner', task, TASK_STATES.WORKING, { startedAt: this.#deps.now() });
        return { task: running, finished: this.#run(running, target.cwd) };
    }

    /** The attempt itself: turns until a stopping point, then the result and the state. */
    async #run(started: Task, cwd: string): Promise<Task> {
        // The tracked state of the tree before the colleague touches anything. Everything the
        // result contains is measured against this, which is what keeps one task's work out
        // of another's branch. Taken here rather than in `start` because it needs git, and
        // persisted because a task outlives a turn and a lost baseline silently loses the
        // isolation with it.
        const baselineTree = this.#deps.baseline ? await this.#deps.baseline(cwd) : null;
        const task = baselineTree === null ? started : this.#patch(started, { baselineTree });

        const outcome = await runTask(
            {
                runTurn: async (input): Promise<TurnResult> => {
                    const result = await this.#deps.runTurn(task.agentId, input.text, input.resumeSessionId);
                    if (result) return result;
                    // No turn could run. Reported as a dead runner so the loop stops at once
                    // rather than spending the bound discovering the same thing five more times.
                    return {
                        status: 'spawn-error', sessionId: input.resumeSessionId, assistantText: '',
                        toolUses: [], isError: true, detail: 'no project to run in'
                    };
                },
                ...(this.#deps.turnLimit !== undefined ? { turnLimit: this.#deps.turnLimit } : {}),
                ...(this.#deps.isAwaitingApproval
                    ? { isAwaitingApproval: (): boolean => this.#deps.isAwaitingApproval!(task.agentId) }
                    : {})
            },
            task.text
        );

        const result = await this.#commitResult(task, cwd, outcome);
        return this.#recordOutcome(task, outcome, result);
    }

    /**
     * Benzoo's decision on a task waiting for him.
     *
     * Approve and fail are the two ways a task ends, and both are owner-only by construction:
     * this method passes the owner actor itself, and the lifecycle refuses done to a colleague
     * from every state. Send-back returns it to working without starting a run, so a second
     * attempt is still an explicit start.
     */
    review(taskId: string, decision: ReviewDecision, note: string | null = null): Task {
        const task = this.#require(taskId);
        const at = this.#deps.now();
        if (decision === 'approve') {
            return this.#write('owner', task, TASK_STATES.DONE, { completedAt: at });
        }
        if (decision === 'fail') {
            return this.#write('owner', task, TASK_STATES.FAILED, {
                completedAt: at, failedReason: note ?? 'not accepted at review'
            });
        }
        return this.#write('owner', task, TASK_STATES.WORKING, {});
    }

    /**
     * The single lifecycle write, exposed only so a test can prove the invariant against the
     * running service rather than against the pure module.
     *
     * Deliberately not reachable from IPC, and the handler map is asserted against that. The
     * three channels route to `assign`, `start` and `review`, each of which supplies the
     * actor itself, so no renderer payload and no colleague can name the actor it acts as.
     * If this ever appears in a handler, that is the bug.
     */
    applyTransitionForTest(actor: TaskActor, taskId: string, to: TaskState, patch: Partial<Task> = {}): Task {
        return this.#write(actor, this.#require(taskId), to, patch);
    }

    #require(taskId: string): Task {
        const task = this.#deps.tasks.get(taskId);
        if (!task) throw new Error('no task ' + taskId);
        return task;
    }

    /**
     * Writes a state change, or refuses it.
     *
     * Nothing else in this module writes `state`. The check is before the persist and not
     * after, so a refused transition leaves the row exactly as it was.
     */
    #write(actor: TaskActor, task: Task, to: TaskState, patch: Partial<Task>): Task {
        if (!canTransition(actor, task.state, to)) {
            throw new TaskTransitionError(
                task.id, task.state, to,
                refusalReason(actor, task.state, to) ?? 'that transition is not allowed'
            );
        }
        const next: Task = { ...task, ...patch, state: to, updatedAt: this.#deps.now() };
        this.#deps.tasks.update(next);
        this.#deps.onChanged?.();
        return next;
    }

    /**
     * Writes fields that are not the lifecycle.
     *
     * Separate from `#write` on purpose, and it must never set `state`. The invariant is that
     * a state change is always checked against an actor, and the way that guarantee erodes is
     * a convenience updater that quietly grows a state field. Keeping them apart makes the
     * one place a state is written easy to point at.
     */
    #patch(task: Task, fields: Omit<Partial<Task>, 'state'>): Task {
        const next: Task = { ...task, ...fields, state: task.state, updatedAt: this.#deps.now() };
        this.#deps.tasks.update(next);
        this.#deps.onChanged?.();
        return next;
    }

    /**
     * Commits the task's own changes to its own branch.
     *
     * Diffed against the baseline taken before the first turn, so the branch holds what this
     * task did and not whatever was already dirty. Run for every stopping reason, including a
     * failure, because files already written to disk are not made safer by refusing to record
     * them. A result that finds nothing to save reports clean, which is honest and not an
     * error.
     */
    async #commitResult(
        task: Task, cwd: string, outcome: TaskRunOutcome
    ): Promise<{ saved: CheckpointOutcome | null; refused: string | null }> {
        const branch = taskBranchName(task.agentId, task.id);

        // What the colleague named, put through the rules. A name is a claim; this is where
        // it is decided. Without a resolver nothing new is committed, which is the safe way
        // to be missing a dependency.
        let accepted: readonly string[] = [];
        let refused: string | null = null;
        if (outcome.outputs.length > 0 && this.#deps.resolveOutputs) {
            try {
                const decided = await this.#deps.resolveOutputs(cwd, outcome.outputs);
                accepted = decided.accepted;
                refused = decided.refused;
            } catch {
                refused = 'the declared files could not be checked, so none were committed';
            }
        } else if (outcome.outputs.length > 0) {
            refused = 'new files cannot be committed in this build, so none were';
        }

        try {
            const saved = await this.#deps.checkpoint({
                cwd, hireId: task.agentId, branch,
                message: 'Stafford task ' + task.id + ' by ' + task.agentId + ': ' + firstLine(task.text),
                baselineTree: task.baselineTree,
                outputs: accepted
            });
            return { saved, refused };
        } catch {
            // The contract is that it does not throw, but a task must still land somewhere I
            // can see if it ever does. Losing the branch is better than losing the task.
            return { saved: null, refused };
        }
    }

    /** Turns a stop reason into the state the colleague is allowed to move the task to. */
    #recordOutcome(
        task: Task, outcome: TaskRunOutcome,
        result: { saved: CheckpointOutcome | null; refused: string | null }
    ): Task {
        const saved = result.saved;
        const patch: Partial<Task> = {
            sessionId: outcome.sessionId,
            resultSummary: outcome.summary === '' ? null : outcome.summary,
            resultBranch: saved?.committed ? saved.branch : null,
            resultCommit: saved?.committed ? saved.commitId : null,
            declaredOutputs: [...outcome.outputs],
            refusedOutputs: result.refused
        };

        if (outcome.reason === 'runner-error') {
            return this.#write('colleague', task, TASK_STATES.FAILED, {
                ...patch, completedAt: this.#deps.now(),
                failedReason: outcome.detail ?? 'the runner could not run'
            });
        }

        // completed, turn-limit and awaiting-approval all land in the same place, because all
        // three mean the same thing to me: the colleague has stopped and I have to look. The
        // difference between them is what I read at review, not where the task goes.
        return this.#write('colleague', task, TASK_STATES.NEEDS_YOU, {
            ...patch, failedReason: null
        });
    }
}

/** True when a task is finished either way, for a caller deciding whether to show it. */
export function isTaskClosed(task: Task): boolean {
    return isTerminal(task.state);
}

/** The instruction's first line, bounded, for a commit subject. Never the whole prompt. */
function firstLine(text: string): string {
    const line = (text.split('\n')[0] ?? '').trim();
    return line.length > 60 ? line.slice(0, 60) + '...' : line;
}
