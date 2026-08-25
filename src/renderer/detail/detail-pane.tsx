import * as React from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ConversationPanel } from './conversation-panel.tsx';
import { ActivityPanel } from './activity-panel.tsx';
import { TranscriptPanel } from './transcript-panel.tsx';
import { ColleaguePermissionsPanel } from '../permissions/colleague-permissions-panel.tsx';
import { TasksPanel } from '../tasks/tasks-panel.tsx';
import { useDetailData } from './use-detail-data.ts';
import { buildActivityFeed, buildTranscript } from './feed-model.ts';
import { tabLabels, isTabId, DEFAULT_TAB, type TabId } from '../detail-tabs.ts';
import type { Lang } from '../channel-view.ts';
import { CHANNEL_SELF_SENDER, type RosterCard } from '../../shared/ipc.ts';

/**
 * The detail pane, all React now: a header with the colleague's name and role, and the
 * four tabs (Conversation, Activity, Transcript, Permissions) on the Tabs primitive. It reads one
 * live data source through the hook and shapes each tab with the pure models. It renders
 * as the right island beside the roster; with no colleague selected it shows a real empty
 * state. Selecting a colleague resets to the Conversation tab, as before.
 */
export function DetailPane({ selected, cards, lang, openTab, openTabNonce }: {
    selected: RosterCard | null;
    cards: readonly RosterCard[];
    lang: Lang;
    /** A tab request, from the board sending me to a task. Null for the usual default. */
    openTab?: string | null;
    /** Changes on every request, so the same tab can be asked for twice. */
    openTabNonce?: number;
}): React.JSX.Element {
    const hireId = selected?.id ?? null;
    const { convRows, actRows, streaming } = useDetailData(hireId);
    const [tab, setTab] = React.useState<TabId>(DEFAULT_TAB);

    // A fresh colleague opens on the front tab, the conversation, unless something asked for
    // a particular one. The board does, because arriving on Conversation after clicking a
    // task card means one more click to reach the thing I clicked for.
    // The request is not cleared after use, deliberately. Clearing it changed `openTab` and
    // so re-ran this effect, which then fell through to the default and undid the very tab it
    // had just opened. The nonce makes a repeat request distinguishable instead, and an
    // ordinary roster selection clears the request as part of selecting.
    React.useEffect(() => {
        setTab(openTab && isTabId(openTab) ? openTab : DEFAULT_TAB);
    }, [hireId, openTab, openTabNonce]);

    const nameOf = React.useCallback((senderId: string): string => {
        if (senderId === CHANNEL_SELF_SENDER) return 'You';
        const card = cards.find((c) => c.id === senderId);
        if (card) return card.name;
        if (selected && selected.id === senderId) return selected.name;
        return senderId;
    }, [cards, selected]);

    return (
        <section
            data-slot="content-panel"
            aria-label="Colleague detail"
            className="bg-card text-card-foreground flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
        >
            {!selected || !hireId ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
                    <p className="text-lg font-medium">Select a colleague</p>
                    <p className="text-muted-foreground text-sm">Pick a card to see their conversation, activity, and transcript.</p>
                </div>
            ) : (
                <>
                    <div className="border-border flex items-baseline gap-2 border-b px-5 py-3">
                        <span className="font-medium">{selected.name}</span>
                        <span className="text-muted-foreground text-sm">{selected.role}</span>
                    </div>

                    <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex min-h-0 flex-1 flex-col gap-0">
                        <div className="px-4 pt-3 pb-1">
                            <TabsList className="w-full">
                                <TabsTrigger value="conversation" data-tab="conversation">{tabLabels(lang).conversation}</TabsTrigger>
                                <TabsTrigger value="tasks" data-tab="tasks">{tabLabels(lang).tasks}</TabsTrigger>
                                <TabsTrigger value="activity" data-tab="activity">{tabLabels(lang).activity}</TabsTrigger>
                                <TabsTrigger value="transcript" data-tab="transcript">{tabLabels(lang).transcript}</TabsTrigger>
                                <TabsTrigger value="permissions" data-tab="permissions">{tabLabels(lang).permissions}</TabsTrigger>
                            </TabsList>
                        </div>

                        <TabsContent value="conversation" className="mt-0 flex min-h-0 flex-1 flex-col">
                            <ConversationPanel hireId={hireId} rows={convRows} nameOf={nameOf} self={CHANNEL_SELF_SENDER} lang={lang} streaming={streaming} />
                        </TabsContent>
                        {/* Assign work and review what came back. In the detail pane rather
                            than on a screen of its own, because a task is something I give to
                            a person; a board across everyone is Model B. */}
                        <TabsContent value="tasks" className="mt-0 flex min-h-0 flex-1 flex-col px-4 py-3">
                            <TasksPanel hireId={hireId} hireName={selected.name} lang={lang} />
                        </TabsContent>
                        <TabsContent value="activity" className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 py-3">
                            <ActivityPanel feed={buildActivityFeed(convRows, actRows, hireId)} nameOf={nameOf} lang={lang} />
                        </TabsContent>
                        <TabsContent value="transcript" className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 py-3">
                            <TranscriptPanel items={buildTranscript(convRows, actRows, hireId)} lang={lang} />
                        </TabsContent>
                        {/* What this colleague may actually do, and its own exceptions. The
                            project's baseline rules live on the Permissions screen, since
                            they belong to the project rather than to one person. */}
                        <TabsContent value="permissions" className="mt-0 flex min-h-0 flex-1 flex-col">
                            <ColleaguePermissionsPanel lang={lang} projectId={selected.projectId} hireId={hireId} />
                        </TabsContent>
                    </Tabs>
                </>
            )}
        </section>
    );
}
