/**
 * Coalesces a transcript's use and result halves into one action per tool call, and
 * decides which actions are worth keeping.
 *
 * The transcript gives two events per tool call: a `use` (the agent called a tool)
 * and later a `result` (it answered). The feed wants one row, "edited f.ts (ok)",
 * not two halves to re-join in the view, so this pairs them by toolUseId and emits a
 * single action carrying the outcome. Because the store is append-only, the pairing
 * has to happen before the write, not as an update afterward: a use is held until its
 * result arrives, and only then is one row produced.
 *
 * An action whose result never comes, because the session ended first, is not left
 * as a dangling half. `flush` resolves every still-pending use for an agent into a
 * terminal row with an `incomplete` status, so an interrupted action reads as
 * exactly that rather than vanishing or waiting forever.
 *
 * The cut is deliberately narrow, from the tool distribution a real session shows.
 * The persisted set is the accomplishment: file changes and commands and subagent
 * dispatch, the "what did this colleague do" a person reads on reopen. Pure reads and
 * searches (Read, Glob, Grep, and the rest) are the agent orienting itself, they
 * fired far more often than the edits in the measurement, and they would bury the
 * accomplishment in noise, so they are live-only and never stored. `shouldPersist`
 * is the one place that cut is written, so Benzoo can widen or veto it in one spot.
 */

import type { ActivityStatus } from '../../domain/models.ts';
import type { TaggedActivityEvent } from './transcript-manager.ts';

/** One coalesced action: a tool call and its outcome, ready to store or render. */
export interface CoalescedAction {
    readonly agentId: string;
    readonly sessionId: string | null;
    readonly toolUseId: string | null;
    readonly tool: string;
    readonly target: string | null;
    readonly status: ActivityStatus;
    /** When the use happened, so the stored order is the order of action, not of result. */
    readonly at: string;
}

/**
 * The tools whose actions are stored. Writes and commands and subagent dispatch: the
 * things a colleague did that changed or ran something. Bash and its Windows alias
 * PowerShell are both here. Everything else, the reads and searches, is live-only.
 * Unknown tools are not stored by default, so a new read-like tool does not quietly
 * fill the history; widen the set here to store one.
 */
export const PERSISTED_TOOLS: ReadonlySet<string> = new Set([
    'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Task'
]);

export function shouldPersist(tool: string): boolean {
    return PERSISTED_TOOLS.has(tool);
}

interface PendingUse {
    readonly agentId: string;
    readonly sessionId: string | null;
    readonly tool: string;
    readonly target: string | null;
    readonly at: string;
}

export class ActivityCoalescer {
    readonly #pending = new Map<string, PendingUse>();

    /** Uses awaiting a result. For proofs and diagnostics. */
    get pendingCount(): number {
        return this.#pending.size;
    }

    /**
     * Folds a batch of tagged events into completed actions. A use is recorded and
     * held; a result pairs with its use and produces one action; a result with no
     * held use (an orphan, or one already emitted) produces nothing. Order is
     * preserved, so actions come out in the order their results arrived.
     */
    ingest(events: readonly TaggedActivityEvent[]): CoalescedAction[] {
        const out: CoalescedAction[] = [];
        for (const e of events) {
            if (e.phase === 'use') {
                if (e.toolUseId) {
                    this.#pending.set(e.toolUseId, {
                        agentId: e.agentId, sessionId: e.sessionId, tool: e.tool ?? '(unknown)', target: e.target, at: e.at
                    });
                }
            } else {
                if (!e.toolUseId) continue;
                const use = this.#pending.get(e.toolUseId);
                if (!use) continue; // an orphan result, or one already paired
                this.#pending.delete(e.toolUseId);
                out.push({
                    agentId: use.agentId, sessionId: use.sessionId, toolUseId: e.toolUseId,
                    tool: use.tool, target: use.target, status: e.status ?? 'ok', at: use.at
                });
            }
        }
        return out;
    }

    /**
     * Resolves every still-pending use for an agent into a terminal `incomplete`
     * action and drops them, for a session that ended before its results arrived.
     * Called on SessionEnd so an interrupted action is stored as interrupted, not
     * left dangling.
     */
    flush(agentId: string): CoalescedAction[] {
        const out: CoalescedAction[] = [];
        for (const [id, use] of this.#pending) {
            if (use.agentId !== agentId) continue;
            this.#pending.delete(id);
            out.push({
                agentId: use.agentId, sessionId: use.sessionId, toolUseId: id,
                tool: use.tool, target: use.target, status: 'incomplete', at: use.at
            });
        }
        return out;
    }
}
