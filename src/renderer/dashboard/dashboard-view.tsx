import * as React from 'react';
import { LayoutDashboard, Users, MessageSquare, FolderGit2, CircleDot, CircleCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusDot } from '@/components/ui/status-dot';
import { List, ListRow } from '@/components/ui/list';
import { Sidebar, SidebarSection, SidebarItem } from '@/components/ui/sidebar';
import { statusForState, type Overview } from './dashboard-data.ts';
import type { RosterCard } from '../../shared/ipc.ts';

/** One summary card: a label, a real count, and an icon. Presentational. */
function StatCard({ label, value, hint, icon }: {
    label: string;
    value: number;
    hint?: string;
    icon: React.ReactNode;
}): React.JSX.Element {
    return (
        <Card className="gap-3 py-4">
            <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
                <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
            </CardHeader>
            <CardContent className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">{value}</span>
                {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
            </CardContent>
        </Card>
    );
}

/** A colleague row: a status dot, the name and role, its project, and a state badge. */
function ColleagueRow({ card }: { card: RosterCard }): React.JSX.Element {
    const status = statusForState(card.state);
    return (
        <ListRow>
            <StatusDot status={status} pulse={status === 'working'} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{card.name}</span>
                <span className="text-muted-foreground truncate text-xs">{card.role}</span>
            </span>
            {card.project ? <span className="text-muted-foreground hidden truncate text-xs sm:block">{card.project}</span> : null}
            <Badge variant={status === 'waiting' ? 'default' : 'outline'} className="shrink-0 capitalize">
                {card.state.replace(/_/g, ' ')}
            </Badge>
        </ListRow>
    );
}

/**
 * The dashboard, presentational: it takes the reduced overview and renders the rail,
 * the summary cards, and the colleague list. It holds no data logic and no IPC; the
 * hook feeds it and onNavigate hands a rail choice back to the vanilla shell.
 */
export function DashboardView({ overview, current, onNavigate }: {
    overview: Overview | null;
    current: string;
    onNavigate: (view: string) => void;
}): React.JSX.Element {
    return (
        <div className="dashboard-scope flex h-full min-h-0 w-full">
            <Sidebar>
                <SidebarSection>Stafford</SidebarSection>
                <SidebarItem active={current === 'home'} onClick={() => onNavigate('home')}><LayoutDashboard /> Home</SidebarItem>
                <SidebarItem active={current === 'roster'} onClick={() => onNavigate('roster')}><Users /> Roster</SidebarItem>
                <SidebarItem active={current === 'channel'} onClick={() => onNavigate('channel')}><MessageSquare /> Channel</SidebarItem>
            </Sidebar>

            <main className="flex-1 overflow-auto p-6 md:p-8">
                <div className="mx-auto flex max-w-5xl flex-col gap-6">
                    <header>
                        <h1 className="text-lg font-semibold">Overview</h1>
                        <p className="text-muted-foreground text-sm">Your colleagues and projects at a glance.</p>
                    </header>

                    {overview === null ? (
                        <p className="text-muted-foreground text-sm">Loading.</p>
                    ) : overview.empty ? (
                        <Card>
                            <CardContent className="flex flex-col items-start gap-2 py-8">
                                <p className="font-medium">No colleagues yet</p>
                                <p className="text-muted-foreground text-sm">
                                    Hire a colleague onto a project to see it here.
                                </p>
                            </CardContent>
                        </Card>
                    ) : (
                        <>
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                <StatCard label="Colleagues" value={overview.stats.total}
                                    hint={overview.stats.active + ' active'} icon={<Users />} />
                                <StatCard label="Working" value={overview.stats.byState.working} icon={<CircleDot />} />
                                <StatCard label="Waiting for you" value={overview.stats.byState.waiting} icon={<CircleCheck />} />
                                <StatCard label="Projects" value={overview.stats.projects} icon={<FolderGit2 />} />
                            </div>

                            <section className="flex flex-col gap-3">
                                <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Colleagues</h2>
                                <List>
                                    {overview.cards.map((card) => <ColleagueRow key={card.id} card={card} />)}
                                </List>
                            </section>
                        </>
                    )}
                </div>
            </main>
        </div>
    );
}
