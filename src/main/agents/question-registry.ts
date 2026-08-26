/**
 * The pending-question registry. When a colleague calls AskUserQuestion, the permission gate hands
 * the parsed questions here and awaits the promise this returns; the turn is paused at that tool call
 * until the person picks an answer. Each pending question is keyed by its own id, so answering one
 * resolves exactly that ask and never another, even with several colleagues waiting or one colleague
 * asking several times in sequence.
 *
 * It mirrors the approval registry but is deliberately separate: answering a question is not granting
 * a permission, the two never share a record, and the approval flow is untouched. On shutdown,
 * cancelAll resolves every pending question as unanswered, so a turn never hangs on a promise that
 * would otherwise wait forever, and the colleague is told no answer was given rather than a fake one.
 */

import type { AskAnswer, AskQuestion, PendingQuestion } from '../../shared/ipc.ts';

/** The person's answer to one question, or null when it was dismissed or cancelled (unanswered). */
export interface QuestionOutcome {
    readonly answers: AskAnswer | null;
}

/** What the gate hands the registry when a colleague asks a question. */
export interface QuestionRequest {
    readonly hireId: string;
    readonly toolUseId: string;
    readonly questions: readonly AskQuestion[];
}

export interface QuestionRegistryDeps {
    readonly now: () => string;
    readonly uuid: () => string;
    /** Tell the renderer the pending set changed, so it re-reads the list. */
    readonly onChange: () => void;
    /**
     * A colleague started or stopped waiting on the person. Wired to the roster's waiting-for-you
     * state, the same one an approval uses, so a paused colleague reads as waiting there.
     */
    readonly onPending: (hireId: string, pending: boolean) => void;
}

export class QuestionRegistry {
    readonly #pending = new Map<string, { question: PendingQuestion; resolve: (outcome: QuestionOutcome) => void }>();
    readonly #deps: QuestionRegistryDeps;

    constructor(deps: QuestionRegistryDeps) {
        this.#deps = deps;
    }

    /** Registers a pending question and returns a promise that resolves when the person answers. */
    ask(request: QuestionRequest): Promise<QuestionOutcome> {
        const question: PendingQuestion = {
            id: this.#deps.uuid(),
            hireId: request.hireId,
            toolUseId: request.toolUseId,
            questions: request.questions,
            at: this.#deps.now()
        };
        return new Promise<QuestionOutcome>((resolve) => {
            this.#pending.set(question.id, { question, resolve });
            this.#deps.onPending(request.hireId, true);
            this.#deps.onChange();
        });
    }

    /**
     * Resolves one pending question by id with the person's selected answers. A missing id is a no-op,
     * so a stale or duplicate answer cannot throw or double-resolve.
     */
    answer(id: string, answers: AskAnswer): void {
        this.#resolve(id, { answers });
    }

    /** Resolves one pending question as unanswered (the person dismissed it). */
    cancel(id: string): void {
        this.#resolve(id, { answers: null });
    }

    #resolve(id: string, outcome: QuestionOutcome): void {
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        entry.resolve(outcome);
        // Clear the waiting state only when the colleague has no other pending ask left.
        const stillWaiting = [...this.#pending.values()].some((e) => e.question.hireId === entry.question.hireId);
        if (!stillWaiting) this.#deps.onPending(entry.question.hireId, false);
        this.#deps.onChange();
    }

    /** The current pending questions, for the conversation surface. */
    list(): PendingQuestion[] {
        return [...this.#pending.values()].map((entry) => entry.question);
    }

    /**
     * Resolves every pending question as unanswered. For shutdown: a turn never hangs on a promise
     * that would otherwise wait forever, and the colleague is told no answer was given.
     */
    cancelAll(): void {
        for (const id of [...this.#pending.keys()]) this.cancel(id);
    }
}
