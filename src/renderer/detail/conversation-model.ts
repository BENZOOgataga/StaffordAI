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

/**
 * A slash command or its CLI response, rendered as a centered system line rather than a chat bubble,
 * the same treatment an event gets. `command` is the person invoking the tool; `response` is the CLI
 * answering. Neither is conversation, so neither reads as the person or the colleague talking.
 */
export interface ThreadCli {
    readonly kind: 'cli';
    readonly id: string;
    readonly at: string;
    readonly text: string;
    readonly role: 'command' | 'response';
}

export type ThreadItem = ThreadGroup | ThreadEvent | ThreadCli;

/**
 * Whether a person's message is a slash command rather than a line of conversation. A command is a
 * single leading-slash word, optionally with arguments: `/compact`, `/model sonnet`. A bare path such
 * as `/etc/hosts` is not a command, because the first token is followed by another slash, so it stays
 * an ordinary message. The residual edge is a bare single-segment path like `/tmp`, which reads as a
 * command; it still delivers correctly, only its line style differs, which is the safe direction.
 */
export function isSlashCommand(text: string): boolean {
    return /^\/[A-Za-z][A-Za-z0-9_-]*(\s|$)/.test(text.trimStart());
}

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
        // A synthetic response is a CLI answer, not the colleague talking. An empty one still shows a
        // line, so a command that ran and returned nothing is not silence. It breaks the grouping.
        if (row.synthetic) {
            current = null;
            const empty = row.body.trim() === '';
            items.push({
                kind: 'cli',
                id: row.id,
                at: row.at,
                text: empty ? (lang === 'fr' ? 'Aucune sortie' : 'No output') : row.body,
                role: 'response'
            });
            continue;
        }
        // The person's own slash command is an instruction to the tool, not a line of conversation, so
        // it renders as a command line rather than a user bubble. A message that only looks like a path
        // is left as an ordinary message.
        if (row.senderId === self && isSlashCommand(row.body)) {
            current = null;
            items.push({ kind: 'cli', id: row.id, at: row.at, text: row.body.trim(), role: 'command' });
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
