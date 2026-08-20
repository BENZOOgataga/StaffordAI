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

import { ClaudeRunner, autoApproveTool, type CanUseTool, type SpawnFn, type WireDirection } from './claude-runner.ts';
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
    /** Writes a colleague's roster state. */
    readonly setState: (hireId: string, state: AgentState) => void;
    /** Signals the roster changed, so the renderer re-reads. */
    readonly onStateChanged: () => void;
    /** The git checkpoint, for the drain. Same executor the registry uses. */
    readonly checkpointRunner?: (cwd: string, hireId: string) => Promise<CheckpointResult>;
    /** The raw wire tap, env-gated by the caller. Both directions, verbatim. */
    readonly traceWire?: (hireId: string, line: string, direction: WireDirection) => void;
    /** The spawn seam, passed to each ClaudeRunner. Defaults to node's spawn. */
    readonly spawn?: SpawnFn;
    /** The permission seam. Defaults to auto-approve. */
    readonly canUseTool?: CanUseTool;
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
        const next = live.tail.then(() => this.#runTurn(hireId, text)).catch(() => {});
        live.tail = next;
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

    async #runTurn(hireId: string, text: string): Promise<void> {
        const target = this.#deps.resolveTarget(hireId);
        if (!target) {
            // No project/cwd resolvable, so there is nothing to run. Leave state as is.
            return;
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
            canUseTool: this.#deps.canUseTool ?? autoApproveTool,
            ...(this.#deps.spawn ? { spawn: this.#deps.spawn } : {}),
            ...(this.#deps.timeoutMs !== undefined ? { timeoutMs: this.#deps.timeoutMs } : {}),
            ...(this.#deps.traceWire
                ? { onRawLine: (l: string, d: WireDirection) => this.#deps.traceWire!(hireId, l, d) }
                : {})
        });
        live.runner = runner;

        // Working the moment the turn starts. State is derived from the runner's own
        // lifecycle now, not from hooks, which no longer fire on this path.
        this.#setState(hireId, AGENT_STATES.WORKING);

        const result = await runner.runTurn({ text, resumeSessionId: target.resumeSessionId });

        live.runner = null;

        // Persist the session id so the next turn resumes, and so it survives a restart.
        if (result.sessionId) this.#deps.bindSession(hireId, target.projectId, result.sessionId);

        // Record Claude's reply into the conversation, both sides now visible. Only a
        // clean turn with text is recorded; a timeout or a dead process records nothing.
        if ((result.status === 'completed' || result.status === 'interrupted') && result.assistantText.trim() !== '') {
            this.#deps.recordReply(hireId, target.projectId, result.assistantText);
        }

        // Idle when the turn ends, whatever the outcome, so the card accepts input
        // again rather than sticking on working after an error.
        this.#setState(hireId, AGENT_STATES.IDLE);
    }

    #setState(hireId: string, state: AgentState): void {
        this.#deps.setState(hireId, state);
        this.#deps.onStateChanged();
    }
}
