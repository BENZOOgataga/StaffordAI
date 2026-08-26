/**
 * The detail pane's tabs, kept as data so the order and the default are tested
 * without a browser. Conversation leads and is the default; the rest follow in the
 * order I reach for them.
 *
 * The Transcript tab was retired once the Conversation tab rendered a colleague's full
 * turn (thinking, tool calls, diffs, todos, text), live and persisted: the transcript
 * showed a strict subset of that with nothing Conversation lacked, so it no longer
 * earned its place. Activity kept its own tab, the actions-only "what it did" view.
 *
 * Permissions is last, the tab I open deliberately rather than the one I want on opening a
 * colleague. It shows what that colleague may actually do and lets me set its exceptions;
 * the project baselines live on their own screen.
 */

export type TabId = 'conversation' | 'tasks' | 'activity' | 'permissions';

/**
 * The tabs in priority order. Tasks sits second, right after the conversation, because
 * assigning work and reviewing what came back are the two things I do most with a colleague
 * after talking to them. It is ahead of Activity because Activity is something I consult when
 * I want to know how, and Tasks is something I act on.
 */
export const TAB_ORDER: readonly TabId[] = ['conversation', 'tasks', 'activity', 'permissions'];

/** Conversation is the front door. */
export const DEFAULT_TAB: TabId = 'conversation';

export interface Lang {
    readonly conversation: string;
    readonly tasks: string;
    readonly activity: string;
    readonly permissions: string;
}

const EN: Lang = { conversation: 'Conversation', tasks: 'Tasks', activity: 'Activity', permissions: 'Permissions' };
const FR: Lang = { conversation: 'Conversation', tasks: 'Tâches', activity: 'Activité', permissions: 'Permissions' };

export function tabLabels(lang: 'en' | 'fr'): Lang {
    return lang === 'fr' ? FR : EN;
}

/** The label for a tab, from the localized set. */
export function tabLabel(labels: Lang, id: TabId): string {
    return labels[id];
}

/** True iff `id` is one of the known tabs, so a stray value cannot activate a panel. A remembered
 * tab that no longer exists (a retired Transcript) fails this and falls back to the default. */
export function isTabId(id: string): id is TabId {
    return (TAB_ORDER as readonly string[]).includes(id);
}
