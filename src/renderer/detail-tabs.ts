/**
 * The detail pane's tabs, kept as data so the order and the default are tested
 * without a browser. The inversion from the old app lives here: Conversation
 * leads and is the default, Transcript is the last, advanced tab. Transcript
 * replaced the old raw Terminal in that slot once the pty was removed: it is a
 * rendered turn view (the colleague's replies and its tool calls) from the
 * headless runner's stream, not a raw terminal.
 *
 * Permissions is last, after Transcript, because it is the tab I open deliberately rather
 * than the one I want on opening a colleague. It shows what that colleague may actually do
 * and lets me set its exceptions; the project baselines live on their own screen.
 */

export type TabId = 'conversation' | 'tasks' | 'activity' | 'transcript' | 'permissions';

/**
 * The tabs in priority order: the message exchange first, the transcript last.
 *
 * Tasks sits second, right after the conversation, because assigning work and reviewing what
 * came back are the two things I do most with a colleague after talking to them. It is ahead
 * of Activity because Activity is something I consult when I want to know how, and Tasks is
 * something I act on.
 */
export const TAB_ORDER: readonly TabId[] = ['conversation', 'tasks', 'activity', 'transcript', 'permissions'];

/** Conversation is the front door, not the transcript. */
export const DEFAULT_TAB: TabId = 'conversation';

export interface Lang {
    readonly conversation: string;
    readonly tasks: string;
    readonly activity: string;
    readonly transcript: string;
    readonly permissions: string;
}

const EN: Lang = { conversation: 'Conversation', tasks: 'Tasks', activity: 'Activity', transcript: 'Transcript', permissions: 'Permissions' };
const FR: Lang = { conversation: 'Conversation', tasks: 'Tâches', activity: 'Activité', transcript: 'Transcription', permissions: 'Permissions' };

export function tabLabels(lang: 'en' | 'fr'): Lang {
    return lang === 'fr' ? FR : EN;
}

/** The label for a tab, from the localized set. */
export function tabLabel(labels: Lang, id: TabId): string {
    return labels[id];
}

/** True iff `id` is one of the known tabs, so a stray value cannot activate a panel. */
export function isTabId(id: string): id is TabId {
    return (TAB_ORDER as readonly string[]).includes(id);
}
