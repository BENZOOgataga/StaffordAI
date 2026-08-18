/**
 * The pure logic behind the Activity feed: which stored rows are a colleague's
 * activity, which of them are new since the feed last rendered, the small line
 * icon each event type gets, and the de-emphasized timestamp. Kept out of the DOM
 * so it is tested without a browser, and so the honest data source has one place.
 *
 * The honest source, confirmed by reading the forwarder and the registry: the only
 * per-colleague structured events Stafford persists are channel event rows, one per
 * qualifying state transition (waiting_for_you, crashed, needs_trust, rate_limited).
 * The raw hook events (SessionStart, UserPromptSubmit, Stop, and the rest) reach the
 * registry to derive state and are not stored, and the tool hooks are not registered
 * at all, so there is no "edited a file" or "ran a command" row to render yet. This
 * module renders the rows the data can fill and nothing it cannot: no stub rows.
 *
 * The event text itself is localized by channel-view's eventLabel, the same enum to
 * phrase map the Conversation tab uses, so a row never holds English and both tabs
 * render the same state consistently per language.
 */

import type { ChannelMessageRow } from '../shared/ipc.ts';
import type { Lang } from './channel-view.ts';

/**
 * A colleague's activity rows: the stored event rows about that colleague, in the
 * ascending order the channel returns them. It keeps only kind 'event' (a state the
 * colleague reached), and only this colleague's, so the feed is one person's
 * activity rather than the whole team's, and a person's own messages never appear
 * here (those are the Conversation tab). Filtering to event rows is also what keeps
 * the feed honest: a message is not an activity row, so none is invented from one.
 */
export function activityRows(rows: readonly ChannelMessageRow[], hireId: string): ChannelMessageRow[] {
    return rows.filter((r) => r.kind === 'event' && r.senderId === hireId);
}

/**
 * The rows not yet shown, by id, preserving order. This is the append seam: the feed
 * holds the ids it has rendered, and a live change appends only what is genuinely
 * new rather than rebuilding the list, which keeps a burst of changes from redrawing
 * the whole feed.
 */
export function unseenRows(seen: ReadonlySet<string>, rows: readonly ChannelMessageRow[]): ChannelMessageRow[] {
    return rows.filter((r) => !seen.has(r.id));
}

/** The icon key for an event state, so the DOM picks one small line icon per type. */
export type ActivityIcon = 'waiting' | 'crashed' | 'needs_trust' | 'rate_limited' | 'event';

export function activityIcon(state: string): ActivityIcon {
    switch (state) {
        case 'waiting_for_you': return 'waiting';
        case 'crashed': return 'crashed';
        case 'needs_trust': return 'needs_trust';
        case 'rate_limited': return 'rate_limited';
        default: return 'event';
    }
}

/**
 * The row class. Only a waiting event, the one the person must act on, carries the
 * amber the roster spends its single accent on; everything else stays grayscale
 * quiet, so the feed reads as a calm history with one thing that stands out.
 */
export function activityRowClass(state: string): string {
    return state === 'waiting_for_you' ? 'act-row waiting' : 'act-row';
}

const MONTHS: Record<Lang, readonly string[]> = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
};

/**
 * A short, de-emphasized time for a row: "now" under a minute, then minutes, then
 * hours within the day, then a day and month once it is older. Relative for the
 * recent past, where "how long ago" is what a person reads, and an absolute date
 * once relative stops meaning anything. Localized, and computed here from a passed
 * now so it is deterministic under test rather than reading the clock.
 */
export function activityTime(at: string, now: number, lang: Lang = 'en'): string {
    const then = Date.parse(at);
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.round((now - then) / 1000));
    if (secs < 60) return lang === 'fr' ? "à l'instant" : 'now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h';
    const d = new Date(then);
    const day = d.getDate();
    const month = MONTHS[lang][d.getMonth()] ?? MONTHS.en[d.getMonth()];
    return lang === 'fr' ? day + ' ' + month : month + ' ' + day;
}
