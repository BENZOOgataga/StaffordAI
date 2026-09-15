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
import { LiveTurnBuilder, toolTarget } from './live-turn.ts';
import { AGENT_STATES, type AgentState } from '../../domain/agent-state.ts';
import type { CheckpointResult, DrainableAgent } from './drain.ts';
import type { LiveBlock } from '../../shared/ipc.ts';

/** Where a colleague's turn runs, and the id to resume from. Null if unresolvable. */
export interface RunnerTarget {
    readonly cwd: string;
    readonly projectId: string;
    /** The stored Claude session id for this colleague/project, or null for a fresh turn. */
    readonly resumeSessionId: string | null;
}

/**
 * A turn that could not even start, and the reason to show the person. This is not the same as a
 * null target: null means there is nothing to surface to (the hire is gone). A refusal means the
 * colleague exists and is blocked, so it must not read Idle, and the reason must reach the app,
 * never only stderr. `reason` is first person, since it is recorded into the colleague's own thread.
 * `projectId` is that thread; null when no project is bound, where the blocked state alone carries it.
 */
export interface RunnerRefusal {
    readonly refused: true;
    readonly reason: string;
    readonly projectId: string | null;
}

export interface RunnerManagerDeps {
    readonly claudePath: string;
    /** The managed CLAUDE_CONFIG_DIR, passed to every child for #61 isolation. */
    readonly claudeConfigDir: string;
    /** The base environment the child inherits (CLAUDE_CONFIG_DIR is layered on top). */
    readonly parentEnv: NodeJS.ProcessEnv;
    /**
     * Resolves a hire to its cwd, project, and resume id. A RunnerTarget runs. A RunnerRefusal is a
     * turn that cannot start with a reason to show (containment refused it, no project or folder is
     * set); the manager surfaces it as the blocked state plus the reason. Null means there is nothing
     * to surface to at all (the hire is gone), and the state is left as is.
     */
    readonly resolveTarget: (hireId: string) => RunnerTarget | RunnerRefusal | null;
    /** Seeds the managed config for the cwd. Idempotent; called before every turn. */
    readonly seedManagedConfig: (cwd: string) => void;
    /** Persists the harvested session id for this colleague/project (the resume key). */
    readonly bindSession: (hireId: string, projectId: string, sessionId: string) => void;
    /**
     * Records Claude's reply into the #62 conversation store, keyed by hireId. `blocks` is the chat
     * turn's rich snapshot, persisted alongside the text so the turn re-renders its thinking, tools,
     * diffs, and todos on reopen; undefined for a task turn, which persists no rich events.
     */
    readonly recordReply: (hireId: string, projectId: string, text: string, blocks?: readonly LiveBlock[], synthetic?: boolean) => void;
    /**
     * Streams the colleague's turn as it arrives, for the live Conversation tab: the reply text
     * and the tool calls it makes, in order, as a block snapshot. Called with an empty snapshot the
     * moment the turn starts (so the tab can show a working indicator before any output), then many
     * times with the whole turn so far as blocks arrive, then once at the end with `done` true so the
     * tab can drop an indicator for a turn that produced nothing. Only the chat path streams; a task
     * turn never calls this. Optional: with it unset, nothing streams and behaviour is unchanged.
     */
    readonly onLive?: (hireId: string, blocks: readonly LiveBlock[], done: boolean) => void;
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
    /**
     * Reports a non-fatal error from a turn's completion path (a failed reply or tool write, a
     * live-push throw). The turn still ends and the colleague still returns to idle; this surfaces the
     * failure so it is never swallowed. When absent, the manager writes it to stderr. It exists because
     * a throw on this path used to skip the idle reset and be swallowed silently, leaving a colleague
     * stuck on Working with its reply and actions lost and no trace of why.
     */
    readonly onError?: (hireId: string, stage: string, error: unknown) => void;
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
        // Chain onto the tail so turns run one at a time, in order. A failed turn does not break the
        // chain: the catch keeps the queue flowing for the next message. #runTurn now returns the
        // colleague to idle in its own finally, so a rejection here is a genuine unexpected failure of
        // the turn itself, reported rather than swallowed silently as it used to be.
        const next = live.tail.then(async () => { await this.#runTurn(hireId, text); }).catch((error) => {
            this.#report(hireId, 'turn', error);
        });
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
        const resolved = this.#deps.resolveTarget(hireId);
        if (!resolved) {
            // The hire is gone, so there is nothing to run and nothing to surface to. Leave state as is.
            return null;
        }
        if ('refused' in resolved) {
            // A turn that could not start: containment refused the spawn, or no project or folder is
            // set. The colleague must not read Idle here, and the reason must reach the person in the
            // app, not vanish onto stderr a packaged build never shows. Surface both and stop.
            this.#blocked(hireId, resolved.projectId, resolved.reason);
            return null;
        }
        const target = resolved;
        const live = this.#liveFor(hireId);
        live.cwd = target.cwd;

        // Only a chat message streams its turn to the Conversation tab. A task turn shares this
        // body but must not stream into the conversation, so streaming is gated on the chat path
        // (no `over`) and on the caller wiring `onLive`. The builder folds the stream into ordered
        // blocks, and each push is the whole turn so far, robust to a dropped push.
        const emitLive = over === undefined ? this.#deps.onLive : undefined;
        const liveBuilder = emitLive ? new LiveTurnBuilder() : null;

        // #61 isolation: seed the managed dir and hand the child CLAUDE_CONFIG_DIR, the
        // same config the pty path read. Idempotent per turn. A seed that could not lock the session
        // credential deletes it and throws: that is a start failure, not a crash, so it surfaces as the
        // blocked state with its reason rather than propagating out silently and leaving the card Idle.
        try {
            this.#deps.seedManagedConfig(target.cwd);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.#blocked(hireId, target.projectId,
                'I could not start: my workspace could not be prepared safely, so the turn was stopped (' + detail + ').');
            return null;
        }
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
                : {}),
            ...(emitLive && liveBuilder
                ? { onEvent: (event) => {
                    // The builder folds text and tool events into ordered blocks; a thinking block
                    // and every unhandled event are ignored, never fatal, per the stream's defensive
                    // posture. A push carries the whole turn so far, so the renderer always has a
                    // correct snapshot even if a push is dropped. Guarded: this runs inside the runner's
                    // stdout handler, so a throw here (in apply, snapshot, or the push) would break the
                    // stream and the turn would never see its result. Reported and swallowed instead, so
                    // a bad push costs one frame, never the whole turn.
                    try {
                        if (liveBuilder.apply(event)) emitLive(hireId, liveBuilder.snapshot(), false);
                    } catch (error) {
                        this.#report(hireId, 'live-push', error);
                    }
                } }
                : {})
        });
        live.runner = runner;

        // Working the moment the turn starts. State is derived from the runner's own
        // lifecycle now, not from hooks, which no longer fire on this path.
        this.#setState(hireId, AGENT_STATES.WORKING);
        // An opening empty snapshot, so the tab shows a working indicator in the gap before the first
        // token or tool event. The builder's snapshots replace it as soon as output arrives. Guarded:
        // this fires after WORKING is set but before the turn runs, so an unguarded throw here would
        // strand the colleague on Working with no turn in flight, the very failure this file prevents.
        if (emitLive) this.#safely(hireId, 'live-open', () => emitLive(hireId, [], false));

        const resumeSessionId = over ? over.resumeSessionId : target.resumeSessionId;
        const result = await runner.runTurn({ text, resumeSessionId });

        live.runner = null;

        // Everything from here to the idle reset must be exception-safe. Each write is isolated and
        // the idle reset is in a finally, so a single failing write (a transient store error, a bad
        // snapshot) can never skip the others or leave the colleague stuck on Working with a swallowed
        // error, the regression this structure exists to prevent. The turn is over; recording its
        // result is best-effort, but returning the card to a usable state is not.
        try {
            // Close the live stream for this turn. `done` lets the tab drop a working indicator for a
            // turn that produced no output at all; a turn that did produce output is replaced by its
            // persisted message instead, so this never blanks real content.
            if (emitLive) this.#safely(hireId, 'live-close', () => emitLive(hireId, [], true));

            // Persist the session id so the next turn resumes, and so it survives a restart. A
            // task turn skips this: its session belongs to the task row, not to the chat thread.
            const sessionId = result.sessionId;
            if (sessionId && (over?.bindSession ?? true)) {
                this.#safely(hireId, 'bind-session', () => this.#deps.bindSession(hireId, target.projectId, sessionId));
            }

            // Record Claude's reply into the conversation, both sides now visible. A chat turn carries
            // its rich block snapshot, so the turn re-renders its thinking, tool calls, diffs, and todos
            // when the colleague is reopened. A task turn has no live builder, so it passes no blocks and
            // persists no rich events, unchanged.
            //
            // The turn is recorded when it produced anything a reopen must not lose: final text, or rich
            // blocks from a turn whose final text was empty. A turn that did real work (edits, commands)
            // but ended with no closing text used to be dropped here, since the gate was on text alone,
            // so it vanished from the Conversation on reopen while its actions lived only in the Activity
            // store the Conversation never reads. The empty body is fine: the panel renders the blocks in
            // place of the text bubble, so an empty-text turn re-renders its actions rather than a blank.
            // A timeout or a dead process (any status but completed/interrupted) still records nothing.
            if (result.status === 'completed' || result.status === 'interrupted') {
                let blocks: readonly LiveBlock[] | undefined;
                this.#safely(hireId, 'snapshot', () => { blocks = liveBuilder ? liveBuilder.snapshot() : undefined; });
                const hasText = result.assistantText.trim() !== '';
                const hasBlocks = blocks !== undefined && blocks.length > 0;
                // A synthetic response is recorded even when it is empty. A slash command like /clear or
                // a silent /compact returns no text and no blocks, and the old gate dropped it entirely,
                // so the person sent a command and the surface said nothing. Recording it, tagged
                // synthetic, is what lets the Conversation show that the command ran and what it returned,
                // rather than the silence that reads exactly like the invisible-refusal bug.
                if (hasText || hasBlocks || result.synthetic) {
                    this.#safely(hireId, 'record-reply', () =>
                        this.#deps.recordReply(hireId, target.projectId, result.assistantText, blocks, result.synthetic));
                }
            }

            // Record the tools the colleague used this turn, for the Activity feed. The runner sees the
            // tool_use blocks but not each tool's own result, so status is the turn's: ok on a clean
            // turn, incomplete otherwise. Each row is isolated, so one failing insert loses only its row.
            if (this.#deps.recordToolUse && result.toolUses.length > 0) {
                const status = result.status === 'completed' ? 'ok' : 'incomplete';
                for (const use of result.toolUses) {
                    this.#safely(hireId, 'record-tool', () =>
                        this.#deps.recordToolUse!(hireId, result.sessionId, use.name, toolTarget(use.input), status));
                }
            }
        } finally {
            // Idle when the turn ends, whatever happened above, so the card accepts input again rather
            // than sticking on Working after an error. This is the guarantee the old straight-line code
            // only intended: here it is enforced by the finally, not merely by reaching the last line.
            // The state write itself is isolated: if setState or its roster signal throws, that must not
            // escape the finally and re-strand the colleague, so it is reported rather than propagated.
            // A turn whose child never launched is blocked, not idle: that case is set below, so the
            // idle reset is skipped for it to avoid a flicker between the two states.
            if (result.status !== 'spawn-error') {
                this.#safely(hireId, 'set-idle', () => this.#setState(hireId, AGENT_STATES.IDLE));
            }
        }

        // A turn whose child never launched (a missing binary, an unusable cwd) is a start failure, not
        // a colleague that simply had nothing to say. Surface it as Blocked with the runner's own reason,
        // so a spawn that never ran is visible in the app and never mistaken for a clean idle.
        if (result.status === 'spawn-error') {
            this.#blocked(hireId, target.projectId,
                'I could not start: ' + (result.detail ?? 'the session process failed to launch') + '.');
        }

        return result;
    }

    /**
     * Surfaces a turn that could not start. The colleague reads Blocked (not_reporting), never Idle,
     * and the specific reason is recorded into its own conversation thread, so a packaged user who never
     * sees stderr can read why. When no project is bound there is no thread to record into, so the
     * blocked state alone carries it. Every write is isolated: surfacing a block must never itself throw.
     */
    #blocked(hireId: string, projectId: string | null, reason: string): void {
        this.#safely(hireId, 'blocked-state', () => this.#setState(hireId, AGENT_STATES.NOT_REPORTING));
        if (projectId) {
            this.#safely(hireId, 'blocked-reason', () => this.#deps.recordReply(hireId, projectId, reason));
        }
    }

    /** Surfaces a completion-path failure. Reporting must never itself throw, so it is guarded. */
    #report(hireId: string, stage: string, error: unknown): void {
        if (this.#deps.onError) {
            try { this.#deps.onError(hireId, stage, error); } catch { /* reporting must never break a turn */ }
            return;
        }
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write('[runner-manager] ' + stage + ' failed for ' + hireId + ': ' + detail + '\n');
    }

    /**
     * Runs one completion-path side effect in isolation: a throw is reported, never propagated. So one
     * failing write cannot skip the other writes or the idle reset, and a bad turn can no longer leave
     * the colleague stuck on Working with a silently swallowed error.
     */
    #safely(hireId: string, stage: string, fn: () => void): void {
        try { fn(); } catch (error) { this.#report(hireId, stage, error); }
    }

    #setState(hireId: string, state: AgentState): void {
        this.#deps.setState(hireId, state);
        this.#deps.onStateChanged();
    }
}
