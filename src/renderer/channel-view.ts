/**
 * The pure rendering logic behind a timeline row: the localized text for an event,
 * the label for an artifact reference, and the class that gives a row its weight.
 * Kept out of the DOM so it is tested without a browser, and so the enum-to-text
 * mapping has one definition.
 *
 * Event rows carry a stable state enum, not a rendered phrase, so this maps the
 * enum to text per language. The row never holds English; the language is chosen
 * here, which is the i18n seam piece 1 set up.
 */

import { CHANNEL_SELF_SENDER, type ChannelMessageRow, type ChannelCursor } from '../shared/ipc.ts';

export type Lang = 'en' | 'fr';

/**
 * The hire a row is about, so a reply targets the right colleague, or null when the
 * row is the person's own message. A message from a hire is from that hire; an
 * event is about that hire; both resolve to the sender id, which is the hire id. A
 * message from the person resolves to nothing, since you do not reply to yourself.
 */
export function resolveReplyTarget(row: { senderId: string }): string | null {
    return row.senderId === CHANNEL_SELF_SENDER ? null : row.senderId;
}

/**
 * The loaded window of the timeline, ascending by time. It appends the tail and
 * prepends older pages without re-fetching what it already holds: new rows are
 * added to the end, older rows to the front, and a row already present by id is
 * not added twice. The cursors are what the renderer passes to since (the tail)
 * and page (scroll-back), so it never re-reads the whole stream.
 */
export class Timeline {
    #rows: ChannelMessageRow[] = [];

    get rows(): readonly ChannelMessageRow[] {
        return this.#rows;
    }

    /** The newest loaded row's cursor, for fetching the tail after it. */
    newestCursor(): ChannelCursor | null {
        const row = this.#rows.at(-1);
        return row ? { at: row.at, id: row.id } : null;
    }

    /** The oldest loaded row's cursor, for fetching older rows before it. */
    oldestCursor(): ChannelCursor | null {
        const row = this.#rows[0];
        return row ? { at: row.at, id: row.id } : null;
    }

    setInitial(rows: readonly ChannelMessageRow[]): void {
        this.#rows = [...rows];
    }

    /** Adds newer rows to the end, skipping any already held. Returns what was added. */
    appendTail(rows: readonly ChannelMessageRow[]): ChannelMessageRow[] {
        const added = rows.filter((r) => !this.#has(r.id));
        this.#rows.push(...added);
        return added;
    }

    /** Adds older rows to the front, skipping any already held. Returns what was added. */
    prependOlder(rows: readonly ChannelMessageRow[]): ChannelMessageRow[] {
        const added = rows.filter((r) => !this.#has(r.id));
        this.#rows = [...added, ...this.#rows];
        return added;
    }

    #has(id: string): boolean {
        return this.#rows.some((r) => r.id === id);
    }
}

/**
 * The phrase for each event state, per language. The colleague's name is prefixed
 * by the caller, so this is the predicate only. French carries its accents, as the
 * writing rules require.
 */
const EVENT_PHRASES: Record<Lang, Record<string, string>> = {
    en: {
        waiting_for_you: 'is waiting for you',
        crashed: 'crashed',
        needs_trust: 'needs you to trust the folder',
        rate_limited: 'is rate limited'
    },
    fr: {
        waiting_for_you: 'attend ta réponse',
        crashed: 's\'est arrêté',
        needs_trust: 'a besoin que tu approuves le dossier',
        rate_limited: 'a atteint la limite de quota'
    }
};

/**
 * The event line for a colleague, localized from the state enum. Reads the phrase
 * from the language map, never from the row, so the same enum renders differently
 * under two languages. Falls back to English, then to the raw enum, so an unknown
 * state still shows something rather than nothing.
 */
export function eventLabel(state: string, name: string, lang: Lang = 'en'): string {
    const phrase = EVENT_PHRASES[lang][state] ?? EVENT_PHRASES.en[state] ?? state;
    return name + ' ' + phrase;
}

/** The label for a typed artifact reference, or null when there is none. */
export function referenceLabel(reference: { kind: string; value: string } | null): string | null {
    if (!reference) return null;
    return reference.kind + ' ' + reference.value;
}

/**
 * The class list for a row. A message and an event read differently, and a
 * waiting_for_you event is the one about the person, so it gets the same weight
 * the roster spends its amber on, rather than reading like an ambient notice.
 */
export function channelRowClass(kind: string, body: string): string {
    if (kind !== 'event') return 'row message';
    return body === 'waiting_for_you' ? 'row event waiting' : 'row event';
}
