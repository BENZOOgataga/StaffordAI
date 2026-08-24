import * as React from 'react';
import { BellOff, Bell, Plus, UserPlus } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { List, ListRow } from '@/components/ui/list';
import { StatusDot } from '@/components/ui/status-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { buildRosterGroups, type RosterRow } from './roster-model.ts';
import { SavedWorkBanner } from './saved-work-banner.tsx';
import { ApprovalsBanner } from '../approvals/approvals-banner.tsx';
import { DetailPane } from '../detail/detail-pane.tsx';
import type { RosterState } from './roster-store.ts';
import type { RosterCard } from '../../shared/ipc.ts';
import type { Lang } from '../create-forms-view.ts';

export interface RosterScreenCopy {
    readonly emptyLead: string;
    readonly emptyBody: string;
    readonly addProject: string;
    readonly hire: string;
}

/** One colleague row: status dot, name with its unseen badge, role, state line, and the quiet extras. */
function ColleagueRow({ row, onSelect }: { row: RosterRow; onSelect: (card: RosterCard) => void }): React.JSX.Element {
    const { card, status, stateText, badged, selected } = row;
    const open = (): void => onSelect(card);
    return (
        <ListRow
            role="button"
            tabIndex={0}
            data-active={selected}
            onClick={open}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
            }}
            className="cursor-pointer items-start gap-3 px-4 py-3"
        >
            <StatusDot status={status} pulse={status === 'working'} size="lg" className="mt-1" label={stateText} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{card.name}</span>
                    {badged ? (
                        <span
                            className="bg-status-waiting size-2 shrink-0 rounded-full"
                            role="status"
                            aria-label="waiting for you"
                        />
                    ) : null}
                    <span className="text-muted-foreground truncate text-sm">{card.role}</span>
                </span>
                {/* aria-hidden: the same words are announced by the status dot's live region
                    above, so hiding the visual copy from the reader avoids saying it twice. */}
                <span className="text-muted-foreground truncate text-sm" aria-hidden="true">{stateText}</span>
                {card.task ? <span className="text-muted-foreground truncate text-sm">{card.task}</span> : null}
                {card.contextLost ? (
                    <span className="text-status-error/80 text-xs">Started clean, earlier context lost</span>
                ) : null}
                {card.apprentices > 0 || card.queued > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                        {card.apprentices > 0 ? (
                            <Badge variant="secondary" className="text-muted-foreground font-normal">{card.apprentices} apprentices</Badge>
                        ) : null}
                        {card.queued > 0 ? (
                            <Badge variant="secondary" className="text-muted-foreground font-normal">{card.queued} queued</Badge>
                        ) : null}
                    </span>
                ) : null}
            </span>
        </ListRow>
    );
}

/**
 * The roster screen, presentational. It renders inside the island shell (the React
 * Sidebar plus inset panels the home dashboard established) and lays the migrated
 * colleague list beside the still-vanilla detail pane, which is reparented into the
 * detail host on mount. It holds no data logic: the store feeds state, and the
 * callbacks hand a selection or an action back to the shell.
 */
export function RosterScreen({
    state, lang, copy, current, onNavigate, onSelect, onToggleMute, onHire, onAddProject
}: {
    state: RosterState;
    lang: Lang;
    copy: RosterScreenCopy;
    current: string;
    onNavigate: (view: string) => void;
    onSelect: (card: RosterCard) => void;
    onToggleMute: () => void;
    onHire: () => void;
    onAddProject: () => void;
}): React.JSX.Element {
    const groups = buildRosterGroups(state.cards, lang, state.now, state.badged, state.selectedId);
    const empty = state.cards.length === 0;

    return (
        <AppShell current={current} onNavigate={onNavigate}>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <ApprovalsBanner cards={state.cards} />
                <SavedWorkBanner lang={lang} />
                <div className="flex min-h-0 flex-1 gap-2">
                <section
                    data-slot="content-panel"
                    className="bg-card text-card-foreground flex w-full shrink-0 basis-[clamp(320px,36%,460px)] flex-col overflow-hidden rounded-xl border"
                >
                    {/* Wraps, because this row does not fit. The panel is clamped to at most
                        460px and as little as 320px, and the title plus both buttons plus the
                        bell overflow that on a narrow window, where the panel's overflow-hidden
                        clips them against its own border. Wrapping rather than shrinking is the
                        right answer here because the labels are translated: the French ones are
                        longer than the English, so any layout that only just fits in English is
                        already broken in French. */}
                    <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
                        {state.unseenCount > 0 ? (
                            <span className="text-status-waiting text-sm font-medium">
                                {state.unseenCount === 1 ? '1 waiting for you' : state.unseenCount + ' waiting for you'}
                            </span>
                        ) : (
                            <h1 className="text-sm font-semibold tracking-tight">Roster</h1>
                        )}
                        {/* ml-auto keeps the controls right-aligned whether they sit beside the
                            title or wrap onto their own line, which a flex-1 spacer could not do
                            once wrapping is allowed. */}
                        <div className="ml-auto flex items-center gap-2">
                            <Button variant="secondary" size="sm" onClick={onAddProject}><Plus /> {copy.addProject}</Button>
                            <Button size="sm" onClick={onHire}><UserPlus /> {copy.hire}</Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-pressed={state.muted}
                                aria-label={state.muted ? 'Unmute' : 'Mute'}
                                onClick={onToggleMute}
                                className="size-8"
                            >
                                {state.muted ? <BellOff /> : <Bell />}
                            </Button>
                        </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-3">
                        {empty ? (
                            <Card className="items-start gap-2 p-6">
                                <p className="text-base font-medium">{copy.emptyLead}</p>
                                <p className="text-muted-foreground text-sm">{copy.emptyBody}</p>
                                <Button variant="secondary" size="sm" className="mt-2" onClick={onAddProject}>
                                    <Plus /> {copy.addProject}
                                </Button>
                            </Card>
                        ) : (
                            <div className="flex flex-col gap-4">
                                {groups.map((group) => (
                                    <section key={group.state} className="flex flex-col gap-2">
                                        <div className="flex items-baseline justify-between gap-2 px-1">
                                            <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">{group.label}</span>
                                            <span className="text-muted-foreground text-xs tabular-nums">{group.count}</span>
                                        </div>
                                        <List>
                                            {group.rows.map((row) => (
                                                <ColleagueRow key={row.card.id} row={row} onSelect={onSelect} />
                                            ))}
                                        </List>
                                    </section>
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                <DetailPane
                    selected={state.selectedCard}
                    cards={state.cards}
                    lang={lang}
                    openTab={state.openTab}
                    openTabNonce={state.openTabNonce}
                />
                </div>
            </div>
        </AppShell>
    );
}
