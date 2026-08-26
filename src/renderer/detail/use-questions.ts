import { createContext, useContext, useEffect, useState } from 'react';
import type { PendingQuestion } from '../../shared/ipc.ts';

/**
 * The AskUserQuestion prompts currently waiting on the person. It reads the pending set and re-reads
 * on the questions:changed signal, so a new ask or an answered one updates live. Read only over
 * window.stafford; answering goes through questions.answer. Mirrors useApprovals, kept separate so the
 * approval flow is untouched.
 */
export function usePendingQuestions(): readonly PendingQuestion[] {
    const [pending, setPending] = useState<readonly PendingQuestion[]>([]);

    useEffect(() => {
        let active = true;
        const load = (): void => {
            void window.stafford.questions.pending().then((reply) => { if (active) setPending(reply.pending); });
        };
        load();
        const off = window.stafford.questions.onChanged(load);
        return () => { active = false; off(); };
    }, []);

    return pending;
}

/**
 * The pending questions, shared with the block renderers so an ask island can find its own pending
 * entry (by tool_use_id) and route a selection back. Defaults to empty: a persisted or Activity render
 * has no pending questions, so an ask there shows its answer or reads as plain, never a live control.
 */
export const PendingQuestionsContext = createContext<readonly PendingQuestion[]>([]);

export function usePendingQuestionFor(toolUseId: string): PendingQuestion | null {
    const pending = useContext(PendingQuestionsContext);
    return pending.find((q) => q.toolUseId === toolUseId) ?? null;
}
