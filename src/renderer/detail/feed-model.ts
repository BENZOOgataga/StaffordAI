/**
 * The pure models behind the Activity and Transcript tabs, built from the same two data
 * sources the vanilla detail used: the channel rows (messages and state events) and the
 * colleague's activity rows (tool actions). Kept pure so the merge and ordering are
 * tested without a DOM. All text stays localized in the view via the activity-view
 * helpers; these only shape and order the rows.
 */

import { activityRows, stateRowToFeed, activityRowToFeed, mergeFeed, type FeedRow } from '../activity-view.ts';
import type { ChannelMessageRow, ActivityRow } from '../../shared/ipc.ts';

/**
 * The Activity feed: the colleague's state events (from the channel rows) and its tool
 * actions (from the activity rows), merged into one time-ordered stream. This is one
 * person's activity, so the person's own messages never appear here.
 */
export function buildActivityFeed(
    conversation: readonly ChannelMessageRow[],
    activity: readonly ActivityRow[],
    hireId: string
): FeedRow[] {
    const states = activityRows(conversation, hireId).map(stateRowToFeed);
    const tools = activity.map(activityRowToFeed);
    return mergeFeed([...states, ...tools]);
}

/** A rendered transcript item: the colleague's own text, or one of its tool actions. */
export type TranscriptItem =
    | { readonly kind: 'text'; readonly id: string; readonly at: string; readonly body: string }
    | { readonly kind: 'tool'; readonly id: string; readonly at: string; readonly row: FeedRow };

/**
 * The Transcript: the colleague's replies interleaved with the tool calls it made, in
 * time order. Only the colleague's own messages (sender is the hire) are text items, so
 * the transcript is the colleague's turn view, not the two-sided exchange.
 */
export function buildTranscript(
    conversation: readonly ChannelMessageRow[],
    activity: readonly ActivityRow[],
    hireId: string
): TranscriptItem[] {
    const texts: TranscriptItem[] = conversation
        .filter((r) => r.kind === 'message' && r.senderId === hireId)
        .map((r) => ({ kind: 'text', id: r.id, at: r.at, body: r.body }));
    const tools: TranscriptItem[] = activity.map((r) => {
        const row = activityRowToFeed(r);
        return { kind: 'tool', id: row.id, at: row.at, row };
    });
    return [...texts, ...tools].sort((a, b) =>
        a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
}
