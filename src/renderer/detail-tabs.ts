/**
 * The detail pane's tabs, kept as data so the order and the default are tested
 * without a browser. The inversion from the old app lives here: Conversation
 * leads and is the default, Transcript is the last, advanced tab. Transcript
 * replaced the old raw Terminal in that slot once the pty was removed: it is a
 * rendered turn view (the colleague's replies and its tool calls) from the
 * headless runner's stream, not a raw terminal.
 */

export type TabId = 'conversation' | 'activity' | 'transcript';

/** The tabs in priority order: the message exchange first, the transcript last. */
export const TAB_ORDER: readonly TabId[] = ['conversation', 'activity', 'transcript'];

/** Conversation is the front door, not the transcript. */
export const DEFAULT_TAB: TabId = 'conversation';

export interface Lang {
    readonly conversation: string;
    readonly activity: string;
    readonly transcript: string;
}

const EN: Lang = { conversation: 'Conversation', activity: 'Activity', transcript: 'Transcript' };
const FR: Lang = { conversation: 'Conversation', activity: 'Activité', transcript: 'Transcription' };

export function tabLabels(lang: 'en' | 'fr'): Lang {
    return lang === 'fr' ? FR : EN;
}

/** The label for a tab, from the localized set. */
export function tabLabel(labels: Lang, id: TabId): string {
    return labels[id];
}

/** True iff `id` is one of the three known tabs, so a stray value cannot activate a panel. */
export function isTabId(id: string): id is TabId {
    return (TAB_ORDER as readonly string[]).includes(id);
}
