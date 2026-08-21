/**
 * The pure model behind the redesigned conversation thread. It turns the flat channel
 * rows into a chat-shaped thread: consecutive messages from one sender are grouped so
 * the name shows once per group, each group carries a side (yours or the colleague's)
 * for the two-sided layout, and an event row (a state change) becomes a centered system
 * line that breaks the grouping. Kept pure so the grouping is tested without a DOM.
 */

import { eventLabel, type Lang } from '../channel-view.ts';
import type { ChannelMessageRow } from '../../shared/ipc.ts';

export interface ThreadMessage {
    readonly id: string;
    readonly body: string;
    readonly at: string;
    readonly reference: { readonly kind: string; readonly value: string } | null;
}

export interface ThreadGroup {
    readonly kind: 'group';
    /** 'you' for the person's own messages, 'them' for the colleague's. */
    readonly side: 'you' | 'them';
    readonly senderId: string;
    readonly sender: string;
    /** The first message's time, for the group's timestamp. */
    readonly at: string;
    readonly messages: readonly ThreadMessage[];
}

export interface ThreadEvent {
    readonly kind: 'event';
    readonly id: string;
    readonly at: string;
    readonly text: string;
    /** The one event the person must act on, so the view can give it the accent. */
    readonly waiting: boolean;
}

export type ThreadItem = ThreadGroup | ThreadEvent;

/**
 * Builds the grouped thread. Message rows from the same sender in a row fold into one
 * group; an event row stands alone and breaks the run, so the next message starts a
 * fresh group. `self` is the sender id that reads as "you"; `nameOf` resolves any other
 * sender to a display name.
 */
export function buildThread(
    rows: readonly ChannelMessageRow[],
    nameOf: (senderId: string) => string,
    self: string,
    lang: Lang
): ThreadItem[] {
    const items: ThreadItem[] = [];
    let current: (ThreadGroup & { messages: ThreadMessage[] }) | null = null;

    for (const row of rows) {
        if (row.kind === 'event') {
            current = null;
            items.push({
                kind: 'event',
                id: row.id,
                at: row.at,
                text: eventLabel(row.body, nameOf(row.senderId), lang),
                waiting: row.body === 'waiting_for_you'
            });
            continue;
        }
        const message: ThreadMessage = { id: row.id, body: row.body, at: row.at, reference: row.reference };
        if (current && current.senderId === row.senderId) {
            current.messages.push(message);
            continue;
        }
        current = {
            kind: 'group',
            side: row.senderId === self ? 'you' : 'them',
            senderId: row.senderId,
            sender: nameOf(row.senderId),
            at: row.at,
            messages: [message]
        };
        items.push(current);
    }
    return items;
}
