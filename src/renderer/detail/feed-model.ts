/**
 * The pure model behind the Activity tab, built from the persisted rich turns (phase 7's turn_events)
 * joined to the colleague's messages for their timestamps. Kept pure so the flatten and ordering are
 * tested without a DOM.
 *
 * Activity is the colleague's actions, not what it said: it flattens every turn's blocks into one
 * time-ordered list, dropping the text blocks (the reply prose) and keeping the tool calls, thinking,
 * and todos. Each action still carries its full block, so the view can show a one-liner and expand to
 * the rich body (a diff, shell output, the reasoning, a checklist) with the same renderers the
 * Conversation uses. A turn from before turn_events existed has no blocks, so its actions do not
 * appear here; every turn from now on does.
 */

import type { ChannelMessageRow, LiveBlock } from '../../shared/ipc.ts';

/** The block kinds Activity shows: a tool call or a thinking block, never a text reply. */
export type ActivityBlock = Extract<LiveBlock, { kind: 'tool' | 'thinking' }>;

/** One action in the flat Activity list: its block, the turn's time, and a stable key. */
export interface ActivityAction {
    readonly key: string;
    readonly at: string;
    readonly block: ActivityBlock;
}

/**
 * The flat, chronological, actions-only Activity list. For each of the colleague's own messages that
 * has persisted rich blocks, its non-text blocks become actions timestamped with that turn's time,
 * then everything is ordered by time across turns. The person's prompts and the colleague's prose
 * replies are never here, only what it did.
 */
export function buildActivityActions(
    conversation: readonly ChannelMessageRow[],
    turnEvents: Readonly<Record<string, readonly LiveBlock[]>>,
    hireId: string
): ActivityAction[] {
    const out: ActivityAction[] = [];
    for (const row of conversation) {
        if (row.kind !== 'message' || row.senderId !== hireId) continue;
        const blocks = turnEvents[row.id];
        if (!blocks) continue;
        blocks.forEach((block, i) => {
            if (block.kind === 'text') return;
            out.push({ key: row.id + ':' + i, at: row.at, block });
        });
    }
    return out.sort((a, b) =>
        a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    );
}
