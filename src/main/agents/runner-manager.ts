/**
 * ClaudeRunnerManager: the delivery path that routes a colleague's messages through
 * the headless ClaudeRunner instead of typing into a pseudo-terminal.
 *
 * This is phase 3 of docs/plans/HEADLESS-STREAM-JSON.md. Phase 2 built the runner and
 * proved one turn against real Claude. This wires it behind submitMessage so colleagues
 * actually use it. The pty/hook/readiness/retry stack is NOT removed here; it goes
 * dormant because nothing calls it any more, and phase 4 deletes it.
 *
 * What it owns, per colleague (keyed by hireId):
 *  - A strict serial queue, so several messages sent fast become several ordered turns,
 *    never merged and never dropped. Turn N+1 does not start until turn N's `result`.
 *    This is the rc.1 delivery bug removed by construction: there is no TUI to race, no
 *    first-message swallow, no accept-receipt timing.
 *  - The Claude session id. Turn 1 is fresh and harvests the id; every later turn
 *    resumes it with --resume. The id persists in the same place the pty path used
 *    (the hire's sessions map), via the injected bindSession.
 *  - Roster state, derived from the runner's own lifecycle rather than from hooks:
 *    working while a turn is in flight, idle when the queue drains. Hooks no longer
 *    fire on this path, so the stream is the authoritative state signal now.
 *
 * What it records: Claude's reply text, into the #62 conversation store keyed by
 * hireId, so the Conversation shows both sides. The pty path only ever recorded the
 * person's "You:" lines; this is the two-sided thread the migration unlocks.
 *
 * #61 isolation is preserved: every turn seeds the managed config and passes
 * CLAUDE_CONFIG_DIR to the child, exactly as the pty path did.
 *
 * Teardown kills only the exact child pid the runner spawned, never by image name.
 *
 * Tested against Claude Code 2.1.237 (same as phase 2).
 */

import { ClaudeRunner, autoApproveTool, type CanUseTool, type RunnerChild, type SpawnFn, type TurnResult, type WireDirection } from './claude-runner.ts';
import { AGENT_STATES, type AgentState } from '../../domain/agent-state.ts';
import type { CheckpointResult, DrainableAgent } from './drain.ts';

/** Where a colleague's turn runs, and the id to resume from. Null if unresolvable. */
export interface RunnerTarget {
    readonly cwd: string;
    readonly projectId: string;
    /** The stored Claude session id for this colleague/project, or null for a fresh turn. */
    readonly resumeSessionId: string | null;
}

export interface RunnerManagerDeps {
    readonly claudePath: string;
    /** The managed CLAUDE_CONFIG_DIR, passed to every child for #61 isolation. */
    readonly claudeConfigDir: string;
    /** The base environment the child inherits (CLAUDE_CONFIG_DIR is layered on top). */
    readonly parentEnv: NodeJS.ProcessEnv;
    /** Resolves a hire to its cwd, project, and resume id. Null means no turn can run. */
    readonly resolveTarget: (hireId: string) => RunnerTarget | null;
    /** Seeds the managed config for the cwd. Idempotent; called before every turn. */
    readonly seedManagedConfig: (cwd: string) => void;
    /** Persists the harvested session id for this colleague/project (the resume key). */
    readonly bindSession: (hireId: string, projectId: string, sessionId: string) => void;
    /** Records Claude's reply into the #62 conversation store, keyed by hireId. */
    readonly recordReply: (hireId: string, projectId: string, text: string) => void;
    /**
     * Records one tool the colleague used this turn, for the Activity feed and the
     * Transcript view. status is 'ok' when the turn completed, 'incomplete' otherwise.
     */
    readonly recordToolUse?: (
        hireId: string, sessionId: string | null, tool: string, target: string | null, status: 'ok' | 'incomplete'
    ) => void;
    /** Writes a colleague's roster state. */
    readonly setState: (hireId: string, state: AgentState) => void;
    /** Signals the roster changed, so the renderer re-reads. */
    readonly onStateChanged: () => void;
    /** The git checkpoint, for the drain. Same executor the registry uses. */
    readonly checkpointRunner?: (cwd: string, hireId: string) => Promise<CheckpointResult>;
    /** The raw wire tap, env-gated by the caller. Both directions, verbatim. */
    readonly traceWire?: (hireId: string, line: string, direction: WireDirection) => void;
    /**
     * Reaps a finished turn's whole process tree from its own child pid down, so a tool
     * grandchild in its own process group is not left orphaned. The caller supplies a
     * killTree walk rooted at that pid; it never kills by image name. When absent, the
     * runner falls back to a single-pid kill.
     */
    readonly reapChild?: (pid: number) => void;
    /** The spawn seam, passed to each ClaudeRunner. Defaults to node's spawn. */
    readonly spawn?: SpawnFn;
    /**
     * Whether each turn's child is spawned into its own process group. Comes from
     * `platform.managedChildSpawnOptions()`. Omitted means true, the safe value, since the
     * tree reap below kills by group and a shared group would include Stafford.
     */
    readonly detached?: boolean;
    /** The permission seam. Defaults to auto-approve. */
    readonly canUseTool?: CanUseTool;
    /**
     * Builds a per-turn permission seam bound to the hire, cwd, and project, so the policy
     * can resolve the right project's rules and the colleague's overrides and resolve tool
     * paths against the turn's cwd. Takes precedence over `canUseTool` when set.
     */
    readonly makeCanUseTool?: (ctx: { hireId: string; cwd: string; projectId: string }) => CanUseTool;
    /** Per-turn timeout, passed to each ClaudeRunner. */
    readonly timeoutMs?: number;
}

/** What one colleague's queue is currently doing, for drain and interrupt. */
interface Live {
    /** The cwd of the colleague's last resolved turn, so the drain can checkpoint it. */
    cwd: string;
    /** The runner in flight, if a turn is running now. Null between turns. */
    runner: ClaudeRunner | null;
    /** The tail of the serial queue: the promise the next turn chains onto. */
    tail: Promise<void>;
}

/**
 * One manager for the whole app. It holds a queue per colleague and never blocks the
 * caller: submit returns the promise for that turn, but the app does not await it on
 * the IPC path. Turns for the same colleague are strictly ordered; turns for different
 * colleagues run independently, so two colleagues never cross-talk.
 */
export class ClaudeRunnerManager {
    readonly #deps: RunnerManagerDeps;
    readonly #live = new Map<string, Live>();

    constructor(deps: RunnerManagerDeps) {
        this.#deps = deps;
    }

    /**
     * Queues one message as a turn for this colleague. Returns when that turn ends.
     * Ordering is strict per colleague: this turn is chained after any already queued.
     */
    submit(hireId: string, text: string): Promise<void> {
        const live = this.#liveFor(hireId);
        // Chain onto the tail so turns run one at a time, in order. A failed turn does
        // not break the chain: the catch keeps the queue flowing for the next message.
        const next = live.tail.then(async () => { await this.#runTurn(hireId, text); }).catch(() => {});
        live.tail = next;
        return next;
    }

    /**
     * One turn of a task, on the same per-colleague queue as a chat message.
     *
     * The queue is the point of routing tasks through here rather than spawning a second
     * runner. A task and a message to the same colleague would otherwise be two Claude
     * children writing the same working tree at once, and the last writer would win a race
     * nobody asked for. Sharing the queue means a message sent mid-task waits for the turn
     * in flight, which is the behaviour a person expects from one colleague.
     *
     * It resumes the session the caller names rather than the colleague's chat session, and
     * does not bind what it harvests into the hire's sessions map, so a task's transcript
     * and a conversation stay separate threads. The task row owns its own session id.
     *
     * Returns null when the colleague has no resolvable project, which is the same "no turn
     * can run" the message path treats as a no-op.
     */
    submitTaskTurn(hireId: string, text: string, resumeSessionId: string | null): Promise<TurnResult | null> {
        const live = this.#liveFor(hireId);
        const next = live.tail.then(() => this.#runTurn(hireId, text, { resumeSessionId, bindSession: false }));
        // The queue must keep flowing even if this turn throws, exactly as submit does, but
        // the caller still needs the failure rather than a silent null.
        live.tail = next.then(() => {}, () => {});
        return next;
    }

    /** Interrupts the colleague's in-flight turn, if any. A no-op between turns. */
    interrupt(hireId: string): void {
        this.#live.get(hireId)?.runner?.interrupt();
    }

    /**
     * Disposes the colleague's in-flight child by its exact pid, if a turn is running.
     * Used by the drain's force-kill. Between turns there is no process, so it is a
     * no-op. Never kills by image name.
     */
    dispose(hireId: string): void {
        const live = this.#live.get(hireId);
        if (live?.runner) {
            live.runner.dispose();
            live.runner = null;
        }
    }

    /**
     * The colleagues the drain should consider: every one this manager has served in
     * this run and whose cwd is known. Each carries its in-flight pid (or null between
     * turns) so the drain can reap a running turn, and a checkpoint that commits the
     * colleague's tracked work. The child is disposed before the checkpoint so the tree
     * is settled when it is committed, then the drain's force-kill reaps any remainder.
     */
    drainables(): DrainableAgent[] {
        const out: DrainableAgent[] = [];
        for (const [hireId, live] of this.#live) {
            const cwd = live.cwd;
            out.push({
                agentId: hireId,
                pid: live.runner?.pid ?? null,
                checkpoint: async (): Promise<CheckpointResult> => {
                    // Stop the in-flight writer first, then checkpoint a stable tree.
                    this.dispose(hireId);
                    if (!this.#deps.checkpointRunner) {
                        return { committed: false, branch: null, commitId: null, reason: null };
                    }
                    return this.#deps.checkpointRunner(cwd, hireId);
                }
            });
        }
        return out;
    }

    #liveFor(hireId: string): Live {
        let live = this.#live.get(hireId);
        if (!live) {
            live = { cwd: '', runner: null, tail: Promise.resolve() };
            this.#live.set(hireId, live);
        }
        return live;
    }

    /**
     * The one turn body, shared by the message path and the task path.
     *
     * `over` lets a task resume its own session instead of the colleague's chat session and
     * keep what it harvests out of the hire's sessions map. Everything else is deliberately
     * identical for both callers: the same isolation, the same permission seam, the same
     * reaper, the same roster state. A task must not be able to run under looser conditions
     * than a message, and the surest way to guarantee that is one code path.
     */
    async #runTurn(
        hireId: string, text: string,
        over?: { resumeSessionId: string | null; bindSession: boolean }
    ): Promise<TurnResult | null> {
        const target = this.#deps.resolveTarget(hireId);
        if (!target) {
            // No project/cwd resolvable, so there is nothing to run. Leave state as is.
            return null;
        }
        const live = this.#liveFor(hireId);
        live.cwd = target.cwd;

        // #61 isolation: seed the managed dir and hand the child CLAUDE_CONFIG_DIR, the
        // same config the pty path read. Idempotent per turn.
        this.#deps.seedManagedConfig(target.cwd);
        const env: NodeJS.ProcessEnv = { ...this.#deps.parentEnv, CLAUDE_CONFIG_DIR: this.#deps.claudeConfigDir };

        const runner = new ClaudeRunner({
            claudePath: this.#deps.claudePath,
            cwd: target.cwd,
            env,
            // A per-turn policy seam bound to this hire and project when one is provided,
            // else the manager-level seam, else auto-approve. This is where a tool call is
            // governed by the permission policy for this colleague on this project.
            canUseTool: this.#deps.makeCanUseTool
                ? this.#deps.makeCanUseTool({ hireId, cwd: target.cwd, projectId: target.projectId })
                : (this.#deps.canUseTool ?? autoApproveTool),
            ...(this.#deps.spawn ? { spawn: this.#deps.spawn } : {}),
            ...(this.#deps.detached !== undefined ? { detached: this.#deps.detached } : {}),
            ...(this.#deps.timeoutMs !== undefined ? { timeoutMs: this.#deps.timeoutMs } : {}),
            // Reap the whole tree when a turn's child is disposed, so no tool grandchild
            // is orphaned. Falls back to the runner's single-pid kill if no reaper is set.
            ...(this.#deps.reapChild
                ? { killChild: (child: RunnerChild) => {
                    if (child.pid) this.#deps.reapChild!(child.pid); else child.kill();
                } }
                : {}),
            ...(this.#deps.traceWire
                ? { onRawLine: (l: string, d: WireDirection) => this.#deps.traceWire!(hireId, l, d) }
                : {})
        });
        live.runner = runner;

        // Working the moment the turn starts. State is derived from the runner's own
        // lifecycle now, not from hooks, which no longer fire on this path.
        this.#setState(hireId, AGENT_STATES.WORKING);

        const resumeSessionId = over ? over.resumeSessionId : target.resumeSessionId;
        const result = await runner.runTurn({ text, resumeSessionId });

        live.runner = null;

        // Persist the session id so the next turn resumes, and so it survives a restart. A
        // task turn skips this: its session belongs to the task row, not to the chat thread.
        if (result.sessionId && (over?.bindSession ?? true)) {
            this.#deps.bindSession(hireId, target.projectId, result.sessionId);
        }

        // Record Claude's reply into the conversation, both sides now visible. Only a
        // clean turn with text is recorded; a timeout or a dead process records nothing.
        if ((result.status === 'completed' || result.status === 'interrupted') && result.assistantText.trim() !== '') {
            this.#deps.recordReply(hireId, target.projectId, result.assistantText);
        }

        // Record the tools the colleague used this turn, for the Activity feed and the
        // Transcript view. The runner sees the tool_use blocks but not each tool's own
        // result, so status is the turn's: ok on a clean turn, incomplete otherwise.
        if (this.#deps.recordToolUse && result.toolUses.length > 0) {
            const status = result.status === 'completed' ? 'ok' : 'incomplete';
            for (const use of result.toolUses) {
                this.#deps.recordToolUse(hireId, result.sessionId, use.name, toolTarget(use.name, use.input), status);
            }
        }

        // Idle when the turn ends, whatever the outcome, so the card accepts input
        // again rather than sticking on working after an error.
        this.#setState(hireId, AGENT_STATES.IDLE);

        return result;
    }

    #setState(hireId: string, state: AgentState): void {
        this.#deps.setState(hireId, state);
        this.#deps.onStateChanged();
    }
}

/**
 * A short, human-readable target for a tool use, from its input: the file path for a
 * file tool, the command for a shell tool, the pattern for a search, else null. Bounded
 * so a huge input never becomes a huge row. Never returns raw structured input.
 */
function toolTarget(_tool: string, input: unknown): string | null {
    if (typeof input !== 'object' || input === null) return null;
    const i = input as Record<string, unknown>;
    const first = (...keys: string[]): string | null => {
        for (const k of keys) if (typeof i[k] === 'string' && (i[k] as string).length > 0) return i[k] as string;
        return null;
    };
    const value = first('file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'prompt', 'description');
    if (value === null) return null;
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? oneLine.slice(0, 120) + '...' : oneLine;
}
