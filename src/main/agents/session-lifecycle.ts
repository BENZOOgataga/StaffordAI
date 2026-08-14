/**
 * Owns live Claude sessions: cold spawn on first message, the hook rendezvous, and
 * the one idempotent teardown the drain and a later idle shutdown share.
 *
 * The spawn itself is not invented here. `spawnSession` in the CLI harness already
 * builds the environment (`buildAgentEnv` plus `STAFFORD_SOCKET`,
 * `STAFFORD_AGENT_SECRET`, `STAFFORD_AGENT_ID`) and starts a `PtySession` in the
 * project's repo, and the per-project forwarder posts authenticated events over
 * the socket. This lifts that shape into the shell with three things the harness
 * did not need: a trigger (the first message), an owner (this, which holds the
 * process and its secret), and a teardown (which reaps the tree, deregisters, and
 * revokes the secret).
 *
 * The rendezvous is the awkward part. A cold spawn has no session id until its
 * first `SessionStart`, so the first event cannot bind by session id. The spawn
 * puts the agent id in the environment, the forwarder echoes it on every event,
 * and the registry binds the first event by that agent id and records the session
 * id on the hire. This holds the agent id and the hire id equal, so binding is
 * direct, and keeps that invariant in one place.
 *
 * The not-reporting state is the absence of evidence. A process that spawned,
 * stayed alive, and never attached its hook within the bound is neither crashed
 * (it did not exit) nor needs_trust (there is no dialog). It gets its own state so
 * the person is not sent to fix the wrong thing. The bound is
 * `DEFAULT_NOT_REPORTING_MS`, and its timer is unref'd, the same requirement the
 * node-pty Windows kill timer taught: a per-session timer that is not unref'd
 * would delay app quit.
 */

import { buildAgentEnv } from './agent-env.ts';
import { PtySession, RESET, type PtyLike } from './pty-session.ts';
import { killTree as defaultKillTree, type KillTreeReport } from './kill-tree.ts';
import { classifyExit, type TrustState } from './trust.ts';
import { AGENT_STATES, type AgentState } from '../../domain/agent-state.ts';
import type { Platform } from '../platform/types.ts';
import type { SessionRegistry } from '../hooks/session-registry.ts';
import type { AgentSecrets } from '../hooks/agent-secrets.ts';

/** How long a spawn has to attach its hook before it is shown as not reporting. */
export const DEFAULT_NOT_REPORTING_MS = 30_000;

/**
 * How long a session may be idle before it is torn down. Ten minutes, the plan's
 * number, kept as global config here rather than a ProjectPolicy field so it does
 * not intersect the open sandbox decision.
 */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** A scheduled timer. The real one is a node Timeout; a test injects its own. */
export interface TimerHandle {
    unref?: () => void;
}

/**
 * The timer seam, injected so a test drives a virtual clock and can see that a
 * handle was unref'd. The default is a real setTimeout, and every timer the
 * lifecycle arms is unref'd through the handle, so a session waiting on an idle
 * period or a hook that never comes cannot hold the app open at quit.
 */
export interface Timers {
    set(callback: () => void, ms: number): TimerHandle;
    clear(handle: TimerHandle): void;
}

const realTimers: Timers = {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Where a hire's session runs. Resolved from the hire's active project. */
export interface SpawnTarget {
    readonly projectId: string;
    readonly cwd: string;
    /** The stored session id to resume, or null for a cold spawn. */
    readonly resumeSessionId?: string | null;
}

export interface LifecycleDeps {
    readonly platform: Platform;
    readonly socketPath: string;
    readonly secrets: AgentSecrets;
    readonly registry: SessionRegistry;
    readonly claudePath: string;
    readonly nodeDir: string;
    readonly parentEnv: Readonly<Record<string, string | undefined>>;
    /** Injected so a test spawns a fixture rather than a real Claude binary. */
    readonly spawn: (file: string, args: readonly string[], options: {
        name: string; cols: number; rows: number; cwd: string;
        env: Record<string, string | undefined>; useConpty: boolean;
    }) => PtyLike;
    /** Where a hire's session runs, or null if the hire is on no project. */
    readonly resolveTarget: (hireId: string) => SpawnTarget | null;
    /** Persist a hire's state, for the states that come from the process not a hook. */
    readonly setState: (hireId: string, state: AgentState) => void;
    /** Claude Code's trust for a directory, for classifying an exit before any hook. */
    readonly trustFor: (cwd: string) => TrustState;
    /**
     * Pre-trusts the project directory before the spawn, so Claude Code does not
     * stop at the startup trust prompt the sanitised message box cannot answer.
     * Scoped to the one cwd, directory-trust only, never a permission blanket.
     * Optional so a test can spawn without touching any config.
     */
    readonly preTrust?: (cwd: string) => void;
    /**
     * Registers Stafford's state-reporting hooks in the project before the spawn,
     * so Claude Code runs the forwarder and the roster and channel are not blind.
     * Scoped to the one project. Optional so a test can spawn without touching a
     * settings file.
     */
    readonly registerHooks?: (cwd: string) => void;
    /**
     * Clears a hire's stored session id for its active project, called when a
     * resume of that id failed. So a stale id that Claude Code cannot find is not
     * re-attempted on the next open; the fresh session records its own id anyway.
     */
    readonly clearStoredSession?: (hireId: string) => void;
    /** Notified when a state changes here, so the roster can be told. */
    readonly onStateChanged?: (hireId: string) => void;
    readonly notReportingMs?: number;
    readonly idleMs?: number;
    /** Injected so a test drives a virtual clock and sees the unref. Defaults to real. */
    readonly timers?: Timers;
    /** Injected so a unit test does not reap a real process tree. Defaults to the real one. */
    readonly killTree?: (platform: Platform, pid: number) => Promise<KillTreeReport>;
}

interface Owned {
    readonly agentId: string;
    readonly hireId: string;
    readonly cwd: string;
    readonly pid: number;
    readonly session: PtySession;
    /** True when this spawn was a resume, so an early exit is a stale-id failure. */
    readonly resuming: boolean;
    notReportTimer: TimerHandle | null;
    idleTimer: TimerHandle | null;
    reported: boolean;
    tornDown: boolean;
}

/** A terminal subscriber, attached to the current session or waiting for the next spawn. */
interface Sub {
    readonly listener: (data: string) => void;
    off: (() => void) | null;
}

export class SessionLifecycle {
    readonly #deps: LifecycleDeps;
    readonly #owned = new Map<string, Owned>();
    /** Terminal subscribers per hire, so a card opened before a session survives the spawn. */
    readonly #subscribers = new Map<string, Set<Sub>>();
    /** Hires whose current session started fresh after a failed resume, for the note. */
    readonly #contextLost = new Set<string>();
    /**
     * The last terminal size the open card reported per hire, so a session spawned
     * while a card is open starts at the pane's size rather than the default. The
     * fallback respawn is the case this exists for: the card is already open and
     * fitted, but a resize event does not refire for the fresh session, so without
     * this the fresh session runs at the default width and the pane renders garbled.
     */
    readonly #lastSize = new Map<string, { cols: number; rows: number }>();
    /**
     * The last message submitted to a hire, held so it can be re-delivered to the
     * fresh session if a resume of a stale id fails and falls back. Without this the
     * message that triggered the resume is written to the session that then dies, so
     * the fresh colleague sits idle and never answers. Cleared once a session reports
     * it is working, so a later unrelated fallback cannot replay an old message.
     */
    readonly #pendingMessage = new Map<string, string>();
    readonly #notReportingMs: number;
    readonly #idleMs: number;
    readonly #timers: Timers;

    constructor(deps: LifecycleDeps) {
        this.#deps = deps;
        this.#notReportingMs = deps.notReportingMs ?? DEFAULT_NOT_REPORTING_MS;
        this.#idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
        this.#timers = deps.timers ?? realTimers;
        // The drainable checkpoint and the drain's force-kill both come back here,
        // so a session is torn down through one path however the drain reaches it.
        deps.registry.setTeardown((agentId) => this.teardown(agentId));
        // Every event for a session means the hook attached and the session is
        // reporting, whether it bound as a cold spawn by agent id or as a resume by
        // a known session id. So activity is what marks a session reported and
        // resets its idle clock.
        deps.registry.setOnActivity((agentId) => this.#onActivity(agentId));
    }

    /** Whether this hire's current session started fresh after a failed resume. */
    contextLost(hireId: string): boolean {
        return this.#contextLost.has(hireId);
    }

    /** Arms an unref'd timer, so it never itself keeps the app open at quit. */
    #arm(callback: () => void, ms: number): TimerHandle {
        const handle = this.#timers.set(callback, ms);
        handle.unref?.();
        return handle;
    }

    /** How many sessions the shell currently owns. For proofs. */
    get count(): number {
        return this.#owned.size;
    }

    has(agentId: string): boolean {
        return this.#owned.has(agentId);
    }

    /**
     * Subscribes to a session's terminal output for the detail view. Reuses
     * PtySession.subscribe, which replays the capped buffer as one chunk then
     * streams live in the same frame, so the terminal is never blank on open and
     * never misses a byte. Returns an unsubscribe; a hire with no live session
     * returns a no-op, so opening a card before a message shows an empty terminal
     * rather than an error. The buffer belongs to the current PtySession, so a
     * resume, being a fresh process, starts with an empty buffer, consistent with
     * the context-lost note.
     */
    subscribe(hireId: string, listener: (data: string) => void): () => void {
        const sub: Sub = { listener, off: null };
        let set = this.#subscribers.get(hireId);
        if (!set) { set = new Set(); this.#subscribers.set(hireId, set); }
        set.add(sub);

        // Attach to the live session now if there is one; otherwise stay pending
        // and the next spawn attaches it, so opening a card and then typing the
        // first message streams that session's output into the terminal.
        const owned = this.#owned.get(hireId);
        if (owned) sub.off = owned.session.subscribe(listener);

        return () => {
            sub.off?.();
            sub.off = null;
            set.delete(sub);
            if (set.size === 0) this.#subscribers.delete(hireId);
        };
    }

    /** Attaches the hire's pending subscribers to a freshly spawned session. */
    #attachSubscribers(hireId: string, session: PtySession): void {
        const set = this.#subscribers.get(hireId);
        if (!set) return;
        for (const sub of set) { if (!sub.off) sub.off = session.subscribe(sub.listener); }
    }

    /** Detaches the hire's subscribers on teardown; they re-attach on the next spawn. */
    #detachSubscribers(hireId: string): void {
        const set = this.#subscribers.get(hireId);
        if (!set) return;
        for (const sub of set) { sub.off?.(); sub.off = null; }
    }

    /**
     * Propagates a pane resize to the live pty, and records the size so the next
     * spawn for this hire starts at it. Recording even with no live session is the
     * point: the card is often open, and fitted, before its first session exists,
     * and the fallback respawn has no resize event of its own.
     */
    resize(hireId: string, cols: number, rows: number): void {
        this.#lastSize.set(hireId, { cols, rows });
        this.#owned.get(hireId)?.session.resize(cols, rows);
    }

    /**
     * The first message to a colleague. If no session is up, this is the cold
     * spawn; otherwise it writes to the running one. Returns the pid, or throws if
     * the hire is on no project so there is nowhere to spawn.
     */
    sendMessage(hireId: string, text: string): number {
        const existing = this.#owned.get(hireId);
        const session = existing ? existing.session : this.#spawn(hireId).session;
        session.write(text);
        // A message is activity, so it resets the idle clock too.
        this.#resetIdle(hireId);
        return (existing ?? this.#owned.get(hireId))?.pid ?? 0;
    }

    /**
     * Submits a person's message to a colleague. Cold-spawns or resumes if no
     * session is up, then submits through PtySession.submit, which sends the text
     * and the Enter as two writes so a multi-line message is content rather than
     * being taken as a paste that swallows the newline. The text is expected to be
     * sanitised by the caller, which is the IPC boundary, before it reaches here.
     * Returns nothing to write to when the hire is on no project.
     */
    async submitMessage(hireId: string, text: string): Promise<void> {
        const existing = this.#owned.get(hireId);
        const session = existing ? existing.session : this.#spawn(hireId).session;
        // Held until the session reports it is working, so a resume that fails and
        // falls back can re-deliver this message to the fresh session rather than
        // lose it to the dead one.
        this.#pendingMessage.set(hireId, text);
        this.#resetIdle(hireId);
        await session.submit(text);
    }

    #spawn(hireId: string, options: { cold?: boolean } = {}): Owned {
        const target = this.#deps.resolveTarget(hireId);
        if (!target) throw new Error('cannot spawn ' + hireId + ': the hire is on no project');

        // Pre-trust the project directory before Claude Code reads its config, so
        // the spawn does not stop at the startup trust prompt. Scoped to this one
        // cwd, the directory the user chose at create time.
        this.#deps.preTrust?.(target.cwd);

        // Register the state-reporting hooks in the project before the spawn, so
        // Claude Code runs the forwarder and the roster is not silently blind.
        this.#deps.registerHooks?.(target.cwd);

        // A stored session id resumes; nothing, or a forced-cold fallback, spawns
        // fresh. Resume reuses everything else about the cold spawn below: the env,
        // the secret handoff, the hook rendezvous, the pid registration, and the
        // drainable. The only difference is the --resume argument and that an early
        // exit means a stale id rather than a crash.
        const resumeSessionId = options.cold ? null : (target.resumeSessionId ?? null);
        const args = resumeSessionId ? ['--resume', resumeSessionId] : [];

        // The agent id the spawn sets and the forwarder echoes. Held equal to the
        // hire id so the first event binds directly, which is the invariant the
        // rendezvous depends on.
        const agentId = hireId;
        const secret = this.#deps.secrets.issue(agentId);

        const built = buildAgentEnv({
            agentId,
            platform: this.#deps.platform,
            parentEnv: this.#deps.parentEnv,
            nodeDir: this.#deps.nodeDir,
            // Path-shaped values only. The socket path is absolute.
            extra: { STAFFORD_SOCKET: this.#deps.socketPath }
        });
        // The secret is not a path, so it is set directly rather than through extra,
        // which is what agent-env's contract requires.
        const env = { ...built.env, STAFFORD_AGENT_SECRET: secret };

        // Spawn at the open card's last-known size, so a session started while the
        // detail is open (a first message, or the fallback respawn) renders at the
        // pane width from its first frame rather than the default and garbled.
        const size = this.#lastSize.get(hireId);
        const session = new PtySession({
            agentId,
            platform: this.#deps.platform,
            file: this.#deps.claudePath,
            args,
            cwd: target.cwd,
            env,
            spawn: this.#deps.spawn,
            ...(size ? { cols: size.cols, rows: size.rows } : {})
        });
        session.start();
        const pid = session.pid ?? 0;

        // Pre-register before the hook can attach, so a fast event is not dropped
        // as unknown, and so a not-yet-reporting process is drainable by its pid.
        this.#deps.registry.preRegister(agentId, pid, hireId, target.projectId);

        const owned: Owned = {
            agentId, hireId, cwd: target.cwd, pid, session, resuming: resumeSessionId !== null,
            notReportTimer: this.#arm(() => this.#onNotReporting(agentId), this.#notReportingMs),
            idleTimer: this.#arm(() => this.#onIdle(agentId), this.#idleMs),
            reported: false, tornDown: false
        };
        this.#owned.set(agentId, owned);
        // A card opened before this spawn is waiting for output; attach it now so
        // its terminal streams from this session.
        this.#attachSubscribers(hireId, session);

        session.once('exit', (info: { exitCode: number | null }) => this.#onExit(agentId, info));
        return owned;
    }

    /** Re-arms the idle clock on any activity, so a working session never idles down. */
    #resetIdle(agentId: string): void {
        const owned = this.#owned.get(agentId);
        if (!owned || owned.tornDown) return;
        if (owned.idleTimer) this.#timers.clear(owned.idleTimer);
        owned.idleTimer = this.#arm(() => this.#onIdle(agentId), this.#idleMs);
    }

    /**
     * The idle timeout fired: the session has been quiet for the full idle period,
     * so tear it down through the shared path to free the process. An idle shutdown
     * writes no drain_report row: that table is the quit-time drain's report, and a
     * routine idle teardown of a session with nothing to commit is not part of any
     * quit. A resume brings the colleague back when the person returns.
     */
    #onIdle(agentId: string): void {
        void this.teardown(agentId);
    }

    /**
     * Disarms every session's timers, called at the start of quit so neither an
     * idle timeout nor a not-reporting timeout can fire mid-drain and race the
     * drain's own teardown. The timers are unref'd anyway, so this is about
     * ordering, not about letting the app quit.
     */
    disarmTimers(): void {
        for (const owned of this.#owned.values()) {
            if (owned.notReportTimer) { this.#timers.clear(owned.notReportTimer); owned.notReportTimer = null; }
            if (owned.idleTimer) { this.#timers.clear(owned.idleTimer); owned.idleTimer = null; }
        }
    }

    /**
     * An event arrived for the session: it attached its hook and is reporting, so
     * the not-reporting clock stops, and it is activity, so the idle clock resets.
     * This is the health signal for both a cold spawn and a resume: a resume that
     * is genuinely healthy reaches here, so it is never mistaken for a stale id.
     */
    #onActivity(agentId: string): void {
        const owned = this.#owned.get(agentId);
        if (!owned || owned.tornDown) return;
        if (!owned.reported) {
            owned.reported = true;
            if (owned.notReportTimer) { this.#timers.clear(owned.notReportTimer); owned.notReportTimer = null; }
            // The session is working, so its message was delivered: drop the pending
            // copy, or a much-later fallback could replay it.
            this.#pendingMessage.delete(agentId);
        }
        this.#resetIdle(agentId);
    }

    #onNotReporting(agentId: string): void {
        const owned = this.#owned.get(agentId);
        if (!owned || owned.reported || owned.tornDown) return;
        // Alive, drainable, but silent. A distinct state, not crashed or
        // needs_trust, because the process did not exit and there is no dialog.
        this.#deps.setState(owned.hireId, AGENT_STATES.NOT_REPORTING);
        this.#deps.onStateChanged?.(owned.hireId);
    }

    #onExit(agentId: string, _info: { exitCode: number | null }): void {
        const owned = this.#owned.get(agentId);
        if (!owned || owned.tornDown) return;

        // The three cases are told apart by exit versus alive and by resuming
        // versus cold. A resume that exited before ever reporting is the stale-id
        // failure: a healthy resume reports (owned.reported) before it exits, and a
        // slow-but-alive resume never reaches here because it has not exited. So an
        // unreported exit on a resuming session, and only that, is the failed
        // resume, and it falls back to a fresh spawn. The not_reporting case is a
        // process that stays alive, so it fires the timer, not this exit path.
        if (!owned.reported && owned.resuming) {
            void this.#fallbackToFresh(agentId);
            return;
        }

        // A cold spawn that dies before attaching its hook is classified by trust:
        // no dialog answered and never trusted is needs_trust, otherwise crashed.
        if (!owned.reported) {
            const report = classifyExit({
                trustAtSpawn: this.#deps.trustFor(owned.cwd),
                sawSessionStart: false,
                sawSessionEnd: false
            });
            if (report === 'crashed' || report === 'needs_trust') {
                this.#deps.setState(owned.hireId, report as AgentState);
                this.#deps.onStateChanged?.(owned.hireId);
            }
        }

        void this.teardown(agentId);
    }

    /**
     * A resume failed on a stale id. Tear the exited session down, mark the hire
     * context-lost for the note, and cold-spawn fresh so the colleague ends up
     * working, just freshly. The fresh spawn's first hook writes a new session id
     * over the stale one through the rendezvous, so the hire stops pointing at a
     * session that no longer exists. Not an error state, an honest note: the person
     * is told this is a clean start rather than a continuation.
     */
    async #fallbackToFresh(agentId: string): Promise<void> {
        await this.teardown(agentId);
        // Clear the dead resume's frame from any open terminal at once, so the
        // person is not left staring at "No conversation found" for the seconds it
        // takes the fresh session to spawn and paint over it.
        this.#resetSubscribers(agentId);
        // Drop the stale session id so it is not resumed again on the next open. The
        // fresh session's first event records its own id, but clearing it here stops
        // a re-resume in the window before that, and if the fresh session never binds.
        this.#deps.clearStoredSession?.(agentId);
        this.#contextLost.add(agentId);
        try {
            const fresh = this.#spawn(agentId, { cold: true });
            // Re-deliver the message that triggered the failed resume, so the fresh
            // colleague acts on it rather than sitting idle. It was written to the
            // dead resume session and lost otherwise.
            const pending = this.#pendingMessage.get(agentId);
            if (pending) void fresh.session.submit(pending);
        } catch {
            // No project to spawn into, or the hire is gone. The teardown already
            // cleared the failed session; there is nothing to leave stuck.
            this.#contextLost.delete(agentId);
        }
        this.#deps.onStateChanged?.(agentId);
    }

    /**
     * Sends a terminal reset to any open subscribers, clearing a dead frame such as
     * a failed resume's "No conversation found" before a fresh session repaints. The
     * subscribers stay pending across the fallback teardown, so this reaches the open
     * card even though its session was just torn down.
     */
    #resetSubscribers(hireId: string): void {
        const set = this.#subscribers.get(hireId);
        if (!set) return;
        for (const sub of set) sub.listener(RESET);
    }

    /**
     * The one idempotent teardown. Reaps the whole tree through `killTree`,
     * deregisters from the registry, and revokes the per-agent secret. Safe to call
     * twice: a second call finds the session already gone and only makes sure the
     * registry and the secret are clear, which are themselves idempotent.
     */
    async teardown(agentId: string): Promise<void> {
        const owned = this.#owned.get(agentId);
        if (!owned || owned.tornDown) {
            this.#deps.registry.deregisterByAgent(agentId);
            this.#deps.secrets.revoke(agentId);
            return;
        }
        owned.tornDown = true;
        // The context-lost note belongs to the session that was live; a torn-down
        // session no longer carries it. The fallback re-sets it after this returns,
        // for the fresh session it spawns.
        this.#contextLost.delete(agentId);
        if (owned.notReportTimer) { this.#timers.clear(owned.notReportTimer); owned.notReportTimer = null; }
        if (owned.idleTimer) { this.#timers.clear(owned.idleTimer); owned.idleTimer = null; }

        try {
            const kill = this.#deps.killTree ?? defaultKillTree;
            await kill(this.#deps.platform, owned.pid);
        } catch {
            // A kill that fails still leaves the record cleared; the OS reclaims the
            // process on exit. The drain must always reach quit.
        }
        // node-pty's own disposal, for its sockets. A no-op if the tree reap
        // already took the shell down.
        try { owned.session.kill(); } catch { /* already gone */ }

        this.#deps.registry.deregisterByAgent(agentId);
        this.#deps.secrets.revoke(agentId);
        this.#owned.delete(agentId);
        // The session is gone, so its subscribers detach; they re-attach if the
        // colleague is resumed, so an open card comes back to life on the next spawn.
        this.#detachSubscribers(agentId);
    }
}
