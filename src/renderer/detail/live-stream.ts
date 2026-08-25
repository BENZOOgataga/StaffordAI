/**
 * The state machine for the in-flight live turn, kept pure so it is tested without a renderer.
 *
 * The value is `null` when no turn is in flight, an empty array when a turn has started but produced
 * no output yet (which the tab shows as a working indicator), or a block list once the reply text or
 * a tool call has arrived. Two events move it back toward `null`, and getting them right is what the
 * working indicator's live bug turned on:
 *
 *  - The persisted conversation rows are re-read (the colleague's reply landed, or the person's own
 *    message did). A provisional content bubble is now covered by its real row, so it is dropped to
 *    avoid a duplicate. A bare indicator is NOT dropped: the reply has not landed, so clearing here
 *    would blank the indicator mid-gap, which is exactly the dead air that looked like nothing was
 *    happening. This is the case the screenshot harness never exercised, so it passed a broken
 *    feature: the harness never records a person's message, so no re-read raced the indicator.
 *
 *  - The turn signals `done`. Content is left in place for its persisted row to replace without a
 *    gap; a bare indicator is cleared, so a turn that produced nothing does not spin forever.
 */

import type { LiveBlock } from '../../shared/ipc.ts';

/** A block carries real output: a tool call, or text that is not empty. An empty text run does not. */
export function hasLiveContent(block: LiveBlock): boolean {
    return block.kind === 'tool' || block.text !== '';
}

/** True when the streaming state holds real output rather than only the working indicator. */
export function streamHasContent(streaming: readonly LiveBlock[] | null): boolean {
    return streaming !== null && streaming.some(hasLiveContent);
}

/**
 * The next streaming state after the persisted rows are re-read. Drop a content bubble (its row now
 * covers it), keep a bare indicator (the reply has not landed, so the indicator must survive).
 */
export function afterPersistedRows(streaming: readonly LiveBlock[] | null): readonly LiveBlock[] | null {
    return streamHasContent(streaming) ? null : streaming;
}

/**
 * The next streaming state after the turn's `done` marker. Keep content for its persisted row to
 * replace; clear a bare indicator so a no-output turn does not leave it spinning.
 */
export function afterDone(streaming: readonly LiveBlock[] | null): readonly LiveBlock[] | null {
    return streamHasContent(streaming) ? streaming : null;
}
