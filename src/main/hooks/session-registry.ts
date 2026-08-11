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
}

export interface IngestResult {
    readonly handled: boolean;
    readonly reason?: 'no-session-id' | 'unmapped';
    readonly sessionId?: string;
    readonly hireId?: string;
    readonly state?: AgentState;
    /** True when the hire's persisted state changed, so a write happened. */
    readonly changed?: boolean;
    /** True when this event ended the session and it was deregistered. */
    readonly ended?: boolean;
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

    constructor(store: HireStore) {
        this.#store = store;
    }

    /** Live sessions currently tracked. For proofs and diagnostics. */
    get liveCount(): number {
        return this.#live.size;
    }

    has(sessionId: string): boolean {
        return this.#live.has(sessionId);
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
        const binding = existing?.binding ?? this.#store.findBySession(sessionId);
        const prev = existing?.snapshot ?? emptySession(sessionId);
        const next = applyEvent(prev, event, now);

        if (!binding) {
            // A session in no hire's sessions map. Do not attribute it to a hire
            // and do not register it: a wrong hire lighting up is worse than a
            // session the shell does not yet know. Reported as unmapped so a
            // caller can log, never guessed.
            return { handled: false, reason: 'unmapped', sessionId };
        }

        // SessionEnd ends the session. Apply its final state, then deregister so a
        // finished session is not in the drainable set and is not force-killed on a
        // later quit. Stop is not an end: a stopped session is idle and may resume.
        const ended = next.sawSessionEnd;
        if (ended) {
            this.#live.delete(sessionId);
        } else {
            this.#live.set(sessionId, { snapshot: next, binding, pid: existing?.pid ?? null });
        }

        // Persist only on a real transition. Most events do not change state, so
        // this keeps the write count to actual transitions rather than per event.
        const changed = next.state !== prev.state;
        if (changed) this.#store.setState(binding.hireId, next.state);

        return { handled: true, sessionId, hireId: binding.hireId, state: next.state, changed, ended };
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

    /** Every live session as a drainable, so the drain sees a real set at quit. */
    drainables(): DrainableAgent[] {
        const out: DrainableAgent[] = [];
        for (const entry of this.#live.values()) {
            out.push({
                agentId: entry.snapshot.agentId ?? entry.binding.hireId,
                pid: entry.pid,
                checkpoint: () => this.#checkpoint()
            });
        }
        return out;
    }

    /**
     * The git checkpoint executor is a later piece. Until it exists a live session
     * reports no commit, so the drain records it as checkpointed with nothing
     * committed rather than claiming a commit that did not happen.
     */
    async #checkpoint(): Promise<CheckpointResult> {
        return { committed: false, branch: null, commitId: null };
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
        }
    };
}
