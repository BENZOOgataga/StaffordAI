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
import { PtySession, type PtyLike } from './pty-session.ts';
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
    notReportTimer: TimerHandle | null;
    idleTimer: TimerHandle | null;
    reported: boolean;
    tornDown: boolean;
}

export class SessionLifecycle {
    readonly #deps: LifecycleDeps;
    readonly #owned = new Map<string, Owned>();
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
        // The registry tells us when a spawn's first event bound, so we stop the
        // not-reporting clock: the hook attached, the session is reporting.
        deps.registry.setOnBound((agentId) => this.#onReported(agentId));
        // Every event for a session is activity, so it resets the idle clock: a
        // session only idles down after it has genuinely gone quiet.
        deps.registry.setOnActivity((agentId) => this.#resetIdle(agentId));
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

    #spawn(hireId: string): Owned {
        const target = this.#deps.resolveTarget(hireId);
        if (!target) throw new Error('cannot spawn ' + hireId + ': the hire is on no project');

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

        const session = new PtySession({
            agentId,
            platform: this.#deps.platform,
            file: this.#deps.claudePath,
            cwd: target.cwd,
            env,
            spawn: this.#deps.spawn
        });
        session.start();
        const pid = session.pid ?? 0;

        // Pre-register before the hook can attach, so a fast event is not dropped
        // as unknown, and so a not-yet-reporting process is drainable by its pid.
        this.#deps.registry.preRegister(agentId, pid, hireId, target.projectId);

        const owned: Owned = {
            agentId, hireId, cwd: target.cwd, pid, session,
            notReportTimer: this.#arm(() => this.#onNotReporting(agentId), this.#notReportingMs),
            idleTimer: this.#arm(() => this.#onIdle(agentId), this.#idleMs),
            reported: false, tornDown: false
        };
        this.#owned.set(agentId, owned);

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

    #onReported(agentId: string): void {
        const owned = this.#owned.get(agentId);
        if (!owned) return;
        owned.reported = true;
        if (owned.notReportTimer) { this.#timers.clear(owned.notReportTimer); owned.notReportTimer = null; }
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

        // A spawn that dies before attaching its hook is classified by trust: no
        // dialog answered and never trusted is needs_trust, otherwise crashed. This
        // is the exited case, distinct from not_reporting, which stays alive.
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
    }
}
