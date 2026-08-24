import { type Lang } from '../channel-view.ts';

/**
 * The send decision, shared by the pinned conversation composer and the inline channel
 * reply. It exists so the "clear only on confirmed success, keep the text and show an
 * error on failure" rule is one tested function rather than repeated inline in two
 * components, where the earlier fire-and-forget version dropped the typed text on a
 * failed send with nothing shown.
 *
 * Pure and awaitable: the caller passes the actual send (the bridge call), and gets back
 * whether to clear the input and what error to show. No React, so it is unit tested with a
 * send that resolves and one that rejects.
 */
export interface SendDecision {
    /** True only when the send confirmed success, so the caller clears the input. */
    readonly cleared: boolean;
    /** The inline error to show, or null. Non-null exactly when the send failed. */
    readonly error: string | null;
}

/** The inline failure copy, per language. Kept here so both composers read the same words. */
export function sendFailedText(lang: Lang): string {
    return lang === 'fr'
        ? 'Envoi impossible. Ton message est conservé, réessaie.'
        : 'Could not send. Your message is kept, try again.';
}

/**
 * Runs one send. Empty or whitespace-only text is a no-op (no send, no error, no clear).
 * On success the caller clears the input; on failure the input is kept and the error is
 * returned for an inline message.
 */
export async function runSend(
    text: string,
    send: (text: string) => Promise<void>,
    lang: Lang
): Promise<SendDecision> {
    if (text.trim().length === 0) return { cleared: false, error: null };
    try {
        await send(text);
        return { cleared: true, error: null };
    } catch {
        return { cleared: false, error: sendFailedText(lang) };
    }
}
