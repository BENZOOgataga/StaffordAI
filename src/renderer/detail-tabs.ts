/**
 * The detail pane's tabs, kept as data so the order and the default are tested
 * without a browser. The inversion from the old app lives here: Conversation
 * leads and is the default, Terminal is the last, advanced tab.
 */

export type TabId = 'conversation' | 'activity' | 'terminal';

/** The tabs in priority order: the message exchange first, the raw terminal last. */
export const TAB_ORDER: readonly TabId[] = ['conversation', 'activity', 'terminal'];

/** Conversation is the front door now, not the terminal. */
export const DEFAULT_TAB: TabId = 'conversation';

export interface Lang {
    readonly conversation: string;
    readonly activity: string;
    readonly terminal: string;
}

const EN: Lang = { conversation: 'Conversation', activity: 'Activity', terminal: 'Terminal' };
const FR: Lang = { conversation: 'Conversation', activity: 'Activité', terminal: 'Terminal' };

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
