/**
 * The pure logic behind the Activity feed: which stored rows are a colleague's
 * activity, which of them are new since the feed last rendered, the small line
 * icon each event type gets, and the de-emphasized timestamp. Kept out of the DOM
 * so it is tested without a browser, and so the honest data source has one place.
 *
 * The feed merges two sources into one ordered stream. The state rows are the
 * channel event rows, one per qualifying state transition (waiting_for_you, crashed,
 * needs_trust, rate_limited), the same the Conversation tab shows. The tool rows are
 * the colleague's actions from the transcript feed: the persisted accomplishments
 * (edits, commands, dispatch) that survive a reopen, plus the live-only reads and
 * searches shown in the moment and gone on reopen. Both are ordered by time into one
 * feed, so a person reads what a colleague did and is doing as one story.
 *
 * Text is localized here, never held in a row: a state through eventLabel, a tool
 * through its own verb map. A row carries the tool, the target, and the status only,
 * never file contents or a result body.
 */

import type { ChannelMessageRow, ActivityRow, ActivityToolStatus } from '../shared/ipc.ts';
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

// --- the merged feed: state rows and tool rows in one ordered stream ----------

/** One row in the merged feed, discriminated by kind. */
export type FeedRow =
    | { readonly kind: 'state'; readonly id: string; readonly at: string; readonly senderId: string; readonly state: string }
    | {
        readonly kind: 'tool'; readonly id: string; readonly at: string; readonly tool: string;
        readonly target: string | null; readonly status: ActivityToolStatus | null; readonly live: boolean
    };

/** A channel event row becomes a state feed row. */
export function stateRowToFeed(row: ChannelMessageRow): FeedRow {
    return { kind: 'state', id: row.id, at: row.at, senderId: row.senderId, state: row.body };
}

/** A persisted or live activity row becomes a tool feed row. */
export function activityRowToFeed(row: ActivityRow): FeedRow {
    return { kind: 'tool', id: row.id, at: row.at, tool: row.tool, target: row.target, status: row.status, live: row.live };
}

/** Orders the feed by time then id, and drops a row already present by id. */
export function mergeFeed(rows: readonly FeedRow[]): FeedRow[] {
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    return unique.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The feed rows not shown yet, by id, preserving order, for the live append seam. */
export function unseenFeed(seen: ReadonlySet<string>, rows: readonly FeedRow[]): FeedRow[] {
    return rows.filter((r) => !seen.has(r.id));
}

/** The unified icon key: the state icons plus one per tool category. */
export type FeedIcon = ActivityIcon | 'edit' | 'wrote' | 'command' | 'read' | 'search' | 'task' | 'tool';

const TOOL_ICONS: Record<string, FeedIcon> = {
    Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'wrote',
    Bash: 'command', PowerShell: 'command',
    Read: 'read', Glob: 'search', Grep: 'search', LS: 'search', Task: 'task'
};

export function feedIcon(row: FeedRow): FeedIcon {
    return row.kind === 'state' ? activityIcon(row.state) : (TOOL_ICONS[row.tool] ?? 'tool');
}

type Verb = 'edited' | 'wrote' | 'ran' | 'read' | 'searched' | 'listed' | 'delegated' | 'used';

const TOOL_VERBS: Record<string, Verb> = {
    Edit: 'edited', MultiEdit: 'edited', NotebookEdit: 'edited', Write: 'wrote',
    Bash: 'ran', PowerShell: 'ran', Read: 'read', Glob: 'searched', Grep: 'searched', LS: 'listed', Task: 'delegated'
};

const VERB_WORDS: Record<Lang, Record<Verb, string>> = {
    en: { edited: 'edited', wrote: 'wrote', ran: 'ran', read: 'read', searched: 'searched', listed: 'listed', delegated: 'delegated', used: 'used' },
    fr: { edited: 'a modifié', wrote: 'a créé', ran: 'a exécuté', read: 'a lu', searched: 'a cherché', listed: 'a listé', delegated: 'a délégué', used: 'a utilisé' }
};

/**
 * The present-tense words, for a call that has not resolved successfully yet: one that is still
 * running or is paused on an approval, and one that failed. A pending write must not read "wrote",
 * which claims a thing that has not happened and is the exact moment the wording is load bearing,
 * since it is what the person decides against. Past tense is earned only by a successful result.
 */
const VERB_WORDS_RUNNING: Record<Lang, Record<Verb, string>> = {
    en: { edited: 'editing', wrote: 'writing', ran: 'running', read: 'reading', searched: 'searching', listed: 'listing', delegated: 'delegating', used: 'using' },
    fr: { edited: 'modifie', wrote: 'crée', ran: 'exécute', read: 'lit', searched: 'cherche', listed: 'liste', delegated: 'délègue', used: 'utilise' }
};

/** The tool status a phrase is built for. Only a resolved success reads in the past tense. */
export type PhraseStatus = 'running' | 'ok' | 'error' | 'incomplete';

/**
 * The plain phrase for a tool action, localized. A known tool reads as its verb plus
 * its target ("edited f.ts"); an unknown tool names itself ("used SomeTool x"), so a
 * new tool still renders rather than vanishing. Built only from the tool and target
 * the event carries, never from a result body.
 *
 * The tense follows the status. A successful call reads in the past ("wrote f.ts"); a call that is
 * running, paused on approval, failed, or interrupted reads in the present ("writing f.ts"), so the
 * island never claims an action that has not happened. Defaults to the past-tense success form, which
 * is what a historical row with no live status is.
 */
export function toolPhrase(tool: string, target: string | null, lang: Lang = 'en', status: PhraseStatus = 'ok'): string {
    const verb = TOOL_VERBS[tool] ?? 'used';
    const word = (status === 'ok' ? VERB_WORDS : VERB_WORDS_RUNNING)[lang][verb];
    if (verb === 'used') return word + ' ' + tool + (target ? ' ' + target : '');
    return word + (target ? ' ' + target : '');
}

/**
 * The small status tag for a tool row, or null when there is none to show. An ok
 * action shows no tag, so the feed stays quiet; only a failure or an interruption
 * carries a word, and grayscale, never the amber the waiting state keeps.
 */
export function toolStatusLabel(status: ActivityToolStatus | null, lang: Lang = 'en'): string | null {
    if (status === 'error') return lang === 'fr' ? 'échec' : 'failed';
    if (status === 'incomplete') return lang === 'fr' ? 'interrompu' : 'interrupted';
    return null;
}

/**
 * The row class. A waiting state keeps the one amber accent; a failed or interrupted
 * tool action is marked grayscale-quiet (act-error / act-incomplete), so an error is
 * legible without stealing the accent the waiting state exists to own.
 */
export function feedRowClass(row: FeedRow): string {
    if (row.kind === 'state') return activityRowClass(row.state);
    if (row.status === 'error') return 'act-row act-tool act-error';
    if (row.status === 'incomplete') return 'act-row act-tool act-incomplete';
    return 'act-row act-tool';
}
