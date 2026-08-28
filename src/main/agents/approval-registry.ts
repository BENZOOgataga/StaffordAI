/**
 * The pending-approval registry (docs/plans/PERMISSION-SYSTEM.md, phase 2). When the
 * policy resolves to ask, the permission gate calls ask() and awaits the promise it
 * returns; the turn is paused at that tool call until the person answers. Each pending ask
 * is keyed by its own id, so answering one resolves exactly that seam and never another,
 * even when several colleagues are waiting or one colleague hits several asks in sequence.
 *
 * On shutdown, denyAll resolves every pending ask as deny, so a turn never resumes an
 * action the person did not approve and the quit and drain are never blocked on a promise
 * that would otherwise wait forever.
 */

import type { PermissionAction } from '../../domain/permissions.ts';
import type { PendingApproval } from '../../shared/ipc.ts';

/** The person's decision on one ask. The note becomes the deny reason the model reads. */
export interface AskOutcome {
    readonly approve: boolean;
    readonly note: string | null;
}

/** What the gate hands the registry when a tool call needs approval. */
export interface AskRequest {
    readonly hireId: string;
    readonly action: PermissionAction;
    readonly path: string | null;
    readonly command: string | null;
}

export interface ApprovalRegistryDeps {
    readonly now: () => string;
    readonly uuid: () => string;
    /** Tell the renderer the pending set changed, so it re-reads the list. */
    readonly onChange: () => void;
    /**
     * A colleague started or stopped waiting on the person. Wired to the roster's
     * waiting-for-you state, so a paused colleague reads as waiting there, reusing that
     * state rather than inventing a new one.
     */
    readonly onPending: (hireId: string, pending: boolean) => void;
}

export class ApprovalRegistry {
    readonly #pending = new Map<string, { approval: PendingApproval; resolve: (outcome: AskOutcome) => void }>();
    readonly #deps: ApprovalRegistryDeps;

    constructor(deps: ApprovalRegistryDeps) {
        this.#deps = deps;
    }

    /** Registers a pending ask and returns a promise that resolves when the person answers. */
    ask(request: AskRequest): Promise<AskOutcome> {
        const approval: PendingApproval = {
            id: this.#deps.uuid(),
            hireId: request.hireId,
            action: request.action,
            path: request.path,
            command: request.command,
            at: this.#deps.now()
        };
        return new Promise<AskOutcome>((resolve) => {
            this.#pending.set(approval.id, { approval, resolve });
            this.#deps.onPending(request.hireId, true);
            this.#deps.onChange();
        });
    }

    /** Resolves one pending ask by id. A missing id is a no-op, so a stale answer cannot throw. */
    answer(id: string, approve: boolean, note: string | null): void {
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        entry.resolve({ approve, note });
        // Clear the waiting state only when the colleague has no other pending ask left.
        const stillWaiting = [...this.#pending.values()].some((e) => e.approval.hireId === entry.approval.hireId);
        if (!stillWaiting) this.#deps.onPending(entry.approval.hireId, false);
        this.#deps.onChange();
    }

    /** The current pending approvals, for the approvals surface. */
    list(): PendingApproval[] {
        return [...this.#pending.values()].map((entry) => entry.approval);
    }

    /**
     * Resolves every pending ask as deny. For shutdown: a turn never resumes an action the
     * person did not approve, and nothing is left awaiting a promise that would hang the quit.
     */
    denyAll(reason: string): void {
        for (const id of [...this.#pending.keys()]) this.answer(id, false, reason);
    }

    /**
     * Denies the pending asks for one colleague, and only that colleague. For firing: the fired
     * colleague's paused turn must not be left awaiting a promise, and its waiting state must clear,
     * without touching anyone else's pending ask. The match is on the ask's hireId, so a colleague
     * fired while another is waiting leaves the other one waiting. This is deliberately not denyAll:
     * denying every colleague's ask because one was fired would be a real and confusing bug.
     */
    denyForHire(hireId: string, reason: string): void {
        const ids = [...this.#pending.entries()]
            .filter(([, entry]) => entry.approval.hireId === hireId)
            .map(([id]) => id);
        for (const id of ids) this.answer(id, false, reason);
    }
}
