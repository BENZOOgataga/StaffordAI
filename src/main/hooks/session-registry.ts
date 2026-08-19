/**
 * Connects the live hook listener to the state machine and to the drain.
 *
 * The state machine already exists and is tested: `applyEvent`/`stateFor` in
 * `session-state.ts`. This does not author a new one. It keeps a snapshot per
 * live session, drives each snapshot through the existing `applyEvent`, resolves
 * which hire a session belongs to, writes the derived state onto that hire, and
 * exposes every live session as a `DrainableAgent` so the drain stops draining an
 * empty set.
 *
 * **Source of truth while a session runs is memory; the hire's state hits disk on
 * a transition.** The per-session snapshot (the subagent count, the last event
 * time, whether SessionStart or SessionEnd was seen) is session-scoped and lives
 * here, rebuilt on a resume rather than persisted per event. The one persisted
 * thing is the hire's `AgentState`, because the roster view reads it from the
 * database, and it is written through the repository only when the state actually
 * changes.
 *
 * **Why per-event synchronous writes are safe here.** better-sqlite3 is
 * synchronous on the main thread, so a write per event would be a concern if the
 * event rate were high. It is not: the six registered events are turn-paced, not
 * per-tool, because PreToolUse and PostToolUse are deliberately not registered
 * (see `session-state.ts`). A session emits a handful of registered events per
 * turn, and this writes only on a real state transition, not on every event, so
 * the disk cost is a few sub-millisecond writes per turn per session. No batching
 * is needed, and none is added.
 *
 * This piece wires the machine as it is. The Notification branch still defaults to
 * `waiting_for_you`, which is wrong, and correcting that default is piece 2. This
 * file does not touch it.
 */

import { applyEvent, emptySession, type HookEvent, type SessionSnapshot } from './session-state.ts';
import type { AgentState } from '../../domain/agent-state.ts';
import type { DrainableAgent, CheckpointResult } from '../agents/drain.ts';
import type { Repositories } from '../storage/repository.ts';
import type { LiveInfo } from '../roster/snapshot.ts';

/** Which hire and project a live session belongs to. */
export interface HireBinding {
    readonly hireId: string;
    readonly projectId: string;
}

/**
 * The narrow slice of persistence the registry needs. Injected, so the registry
 * is tested with a stub and backed by the repositories in the shell.
 */
export interface HireStore {
    /** The hire and project a session belongs to, or null if it maps to none. */
    findBySession(sessionId: string): HireBinding | null;
    /** Persist a hire's state. Called only on an actual transition. */
    setState(hireId: string, state: AgentState): void;
    /**
     * Records the resolved session id on the hire for a project, so a resume and
     * every later event can bind by session id. Called once, when a cold-spawned
     * session's first event binds by agent id.
     */
    bindSession(hireId: string, projectId: string, sessionId: string): void;
}

export interface IngestResult {
    readonly handled: boolean;
    readonly reason?: 'no-session-id' | 'unmapped';
    readonly sessionId?: string;
    readonly hireId?: string;
    readonly projectId?: string;
    readonly state?: AgentState;
    /** True when the hire's persisted state changed, so a write happened. */
    readonly changed?: boolean;
    /** True when this event ended the session and it was deregistered. */
    readonly ended?: boolean;
    /** True when this event bound a pending cold spawn by its agent id. */
    readonly bound?: boolean;
}

/** A spawned process that has not attached its hook yet, drainable by its real pid. */
interface PendingSpawn {
    readonly agentId: string;
    readonly pid: number;
    readonly binding: HireBinding;
}

interface LiveEntry {
    snapshot: SessionSnapshot;
    binding: HireBinding;
    /**
     * The pid of the process the shell owns for this session, or null when the
     * shell did not spawn it. A session known only from hooks has no process the
     * shell can reap; the spawn lifecycle (a later piece) sets this. The drain
     * skips a null pid, so a hook-observed session is recorded at drain without a
     * kill the shell has no right to perform.
     */
    pid: number | null;
    /** When the current state began, for the roster's elapsed time. */
    stateSince: string;
}

/**
 * Coerces a raw event record from the listener into a `HookEvent`. The listener
 * emits the payload with the secret already stripped; this narrows the fields the
 * state machine reads and drops anything else, so nothing untyped reaches it.
 */
export function coerceHookEvent(raw: Record<string, unknown>): HookEvent {
    const s = (key: string): string | undefined =>
        typeof raw[key] === 'string' ? (raw[key] as string) : undefined;
    return {
        event: s('event') ?? '',
        sessionId: s('sessionId'),
        agentId: s('agentId'),
        cwd: s('cwd'),
        message: s('message'),
        at: s('at')
    };
}

export class SessionRegistry {
    readonly #store: HireStore;
    readonly #live = new Map<string, LiveEntry>();
    /** Cold spawns awaiting their first hook event, keyed by agent id. */
    readonly #pending = new Map<string, PendingSpawn>();
    /** The one idempotent teardown, set by the lifecycle. Kills, deregisters, revokes. */
    #teardown: ((agentId: string) => Promise<void>) | null = null;
    /** The git checkpoint executor, injected by the shell. Null until wired. */
    #checkpointRunner: ((cwd: string, hireId: string) => Promise<CheckpointResult>) | null = null;
    /** Notified when a pending spawn binds, so the lifecycle can stop waiting on it. */
    #onBound: ((agentId: string) => void) | null = null;
    /**
     * Notified on every event for a known session, with the session's derived state,
     * so the lifecycle resets its idle clock and its message queue can wait for the
     * prompt to accept a turn (working) and be ready for the next (idle).
     */
    #onActivity: ((agentId: string, state: AgentState) => void) | null = null;

    constructor(store: HireStore) {
        this.#store = store;
    }

    /**
     * Wires the shared teardown. The drainable checkpoint calls it, so at drain a
     * live session is torn down through the same path an idle shutdown will use.
     */
    setTeardown(teardown: (agentId: string) => Promise<void>): void {
        this.#teardown = teardown;
    }

    /**
     * Wires the git checkpoint executor. Given a session's own cwd and hire, it
     * commits the tracked work to a checkpoint branch and reports the result. Injected
     * so the registry never imports git: it only holds the seam the shell fills.
     */
    setCheckpointRunner(runner: (cwd: string, hireId: string) => Promise<CheckpointResult>): void {
        this.#checkpointRunner = runner;
    }

    /** Wires the bind callback, so the lifecycle learns when a spawn reports. */
    setOnBound(onBound: (agentId: string) => void): void {
        this.#onBound = onBound;
    }

    /** Wires the activity callback, so the lifecycle resets a session's idle clock. */
    setOnActivity(onActivity: (agentId: string, state: AgentState) => void): void {
        this.#onActivity = onActivity;
    }

    /** Live sessions currently tracked. For proofs and diagnostics. */
    get liveCount(): number {
        return this.#live.size;
    }

    has(sessionId: string): boolean {
        return this.#live.has(sessionId);
    }

    /** Whether a cold spawn is registered but has not reported yet. */
    isPending(agentId: string): boolean {
        return this.#pending.has(agentId);
    }

    /**
     * Records a spawned process before its hook can attach, so an event that
     * arrives fast is not dropped as unknown, and so a not-yet-reporting process
     * is still drainable by its real pid. Keyed by the agent id the spawn set in
     * the environment, which the forwarder echoes on every event.
     */
    preRegister(agentId: string, pid: number, hireId: string, projectId: string): void {
        this.#pending.set(agentId, { agentId, pid, binding: { hireId, projectId } });
    }

    /**
     * Applies one hook event: drives the snapshot, resolves the hire, persists the
     * state on a change, and registers or deregisters the session.
     */
    ingest(event: HookEvent, now: string): IngestResult {
        const sessionId = event.sessionId;
        if (!sessionId) {
            // Not a state question, a malformed message. The listener already
            // rejects these, so this is the belt to that suspenders.
            return { handled: false, reason: 'no-session-id' };
        }

        const existing = this.#live.get(sessionId);

        // The rendezvous. A cold spawn has no session id until its first event, so
        // it is not in any hire's sessions map, and it binds by the agent id the
        // spawn set, which the forwarder echoes. A resume reconnects with a session
        // id already on the hire, so it binds by that directly. Either way the pid
        // comes from the pending spawn.
        const pending = existing ? undefined : this.#pending.get(event.agentId ?? '');
        const knownBinding = existing?.binding ?? this.#store.findBySession(sessionId);
        const binding = knownBinding ?? pending?.binding ?? null;

        if (!binding) {
            // A session in no hire's sessions map and no pending spawn. Do not
            // attribute it to a hire: a wrong hire lighting up is worse than a
            // session the shell does not know. Reported as unmapped, never guessed.
            return { handled: false, reason: 'unmapped', sessionId };
        }

        // Bound by agent id only when there was no known binding, which is the cold
        // spawn's first event. Then the session id is recorded on the hire. A resume
        // already has its id on the hire, so nothing is rebound and the id is kept.
        const bound = !knownBinding && pending !== undefined;
        if (bound) this.#store.bindSession(binding.hireId, binding.projectId, sessionId);
        // Either way, a pending spawn for this agent is now live, so clear it: it
        // must not be counted as both a pending spawn and a live session.
        if (pending) this.#pending.delete(pending.agentId);

        const prev = existing?.snapshot ?? emptySession(sessionId);
        const next = applyEvent(prev, event, now);

        // Persist only on a real transition. Most events do not change state, so
        // this keeps the write count to actual transitions rather than per event.
        const changed = next.state !== prev.state;

        // SessionEnd ends the session. Apply its final state, then deregister so a
        // finished session is not force-killed on a later quit. Stop is not an end:
        // a stopped session is idle and may resume.
        const ended = next.sawSessionEnd;
        if (ended) {
            this.#live.delete(sessionId);
        } else {
            // stateSince advances only on a transition, or is set fresh for a new
            // session, so the roster's elapsed measures time in the current state.
            const stateSince = existing && !changed ? existing.stateSince : now;
            const pid = existing?.pid ?? pending?.pid ?? null;
            this.#live.set(sessionId, { snapshot: next, binding, pid, stateSince });
        }

        if (changed) this.#store.setState(binding.hireId, next.state);
        if (bound && this.#onBound) this.#onBound(binding.hireId);
        // Any event for a known session is activity and resets the idle clock,
        // except a SessionEnd. A session that just ended is not reporting that it is
        // alive and working; it is finishing. Counting its end as activity marks the
        // session "reported", and a failed resume fires only a SessionEnd (no
        // SessionStart) before it exits, so treating that as reported would defeat
        // the stale-id fallback, which fires only on an unreported exit. The end is
        // handled by the exit path instead.
        if (this.#onActivity && !ended) this.#onActivity(binding.hireId, next.state);

        return {
            handled: true, sessionId, hireId: binding.hireId, projectId: binding.projectId,
            state: next.state, changed, ended, bound
        };
    }

    /**
     * Sets the owned process id for a live session, once the spawn lifecycle has
     * one. Until that piece exists this is unused in the shell and exercised only
     * in tests, but it is the seam the drain's force-kill will act on.
     */
    setPid(sessionId: string, pid: number | null): void {
        const entry = this.#live.get(sessionId);
        if (entry) entry.pid = pid;
    }

    /**
     * Live session info for a hire, or null when no session is up for it. Used by
     * the roster to add the apprentice count and elapsed to the persisted card.
     * Scans, which is bounded by how many sessions are live at once.
     */
    liveInfoByHire(hireId: string): LiveInfo | null {
        for (const entry of this.#live.values()) {
            if (entry.binding.hireId === hireId) {
                return { apprentices: entry.snapshot.subagentsCompleted, since: entry.stateSince };
            }
        }
        return null;
    }

    /**
     * Every session the shell owns as a drainable, so the drain sees a real set at
     * quit. Both live sessions and pending spawns are included: a process that
     * spawned but has not reported yet still has a real pid to reap, so leaving it
     * out would let a not-reporting session survive the drain.
     */
    drainables(): DrainableAgent[] {
        const out: DrainableAgent[] = [];
        for (const entry of this.#live.values()) {
            // A live session carries its cwd, the repo the colleague worked in, so its
            // checkpoint has a repo to commit.
            out.push(this.#drainable(
                entry.snapshot.agentId ?? entry.binding.hireId, entry.pid, entry.snapshot.cwd, entry.binding.hireId));
        }
        for (const pending of this.#pending.values()) {
            // A spawn that never reported has no cwd here, so it is torn down without a
            // checkpoint. It reported nothing, so there is no working tree to attribute.
            out.push(this.#drainable(pending.agentId, pending.pid, null, pending.binding.hireId));
        }
        return out;
    }

    #drainable(agentId: string, pid: number | null, cwd: string | null, hireId: string): DrainableAgent {
        return {
            agentId,
            pid,
            checkpoint: () => this.#checkpoint(agentId, cwd, hireId)
        };
    }

    /**
     * Checkpoints the session's work, then tears it down. The order is deliberate: the
     * bounded executor commits the tracked changes on a checkpoint branch first, then
     * the session is reaped through the shared teardown, so a checkpoint of any result
     * (committed, clean, error, timed-out) still lets teardown proceed and leaves zero
     * survivors. The executor always resolves and never throws, so it cannot block the
     * teardown or the bounded drain; the catch is a belt to that.
     */
    async #checkpoint(agentId: string, cwd: string | null, hireId: string): Promise<CheckpointResult> {
        let result: CheckpointResult = { committed: false, branch: null, commitId: null, reason: null };
        if (this.#checkpointRunner && cwd) {
            try {
                result = await this.#checkpointRunner(cwd, hireId);
            } catch (error) {
                result = { committed: false, branch: null, commitId: null, reason: 'error: ' + String(error) };
            }
        }
        if (this.#teardown) await this.#teardown(agentId);
        return result;
    }

    /**
     * Removes a session from the registry, by agent id, whether it was live or
     * still pending. Idempotent: a second call finds nothing and returns. Called
     * by the lifecycle's teardown so the registry and the process go together.
     */
    deregisterByAgent(agentId: string): void {
        this.#pending.delete(agentId);
        for (const [sessionId, entry] of this.#live) {
            if ((entry.snapshot.agentId ?? entry.binding.hireId) === agentId) {
                this.#live.delete(sessionId);
            }
        }
    }
}

/**
 * A `HireStore` backed by the repositories. `findBySession` scans hires, which is
 * bounded by how many the person creates by hand, so it needs no index; `setState`
 * reads the hire and writes it back with the new state.
 */
export function hireStoreOver(repos: Repositories): HireStore {
    return {
        findBySession(sessionId) {
            for (const hire of repos.hires.all()) {
                for (const [projectId, sid] of Object.entries(hire.sessions)) {
                    if (sid === sessionId) return { hireId: hire.id, projectId };
                }
            }
            return null;
        },
        setState(hireId, state) {
            const hire = repos.hires.get(hireId);
            if (!hire) return;
            repos.hires.update({ ...hire, state });
        },
        bindSession(hireId, projectId, sessionId) {
            const hire = repos.hires.get(hireId);
            if (!hire) return;
            repos.hires.update({ ...hire, sessions: { ...hire.sessions, [projectId]: sessionId } });
        }
    };
}
