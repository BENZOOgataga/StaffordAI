import * as React from 'react';
import { Users, CircleDot, CircleCheck, FolderGit2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusDot } from '@/components/ui/status-dot';
import { List, ListRow } from '@/components/ui/list';
import { AppShell } from '@/components/app-shell';
import { ApprovalsBanner } from '../approvals/approvals-banner.tsx';
import { statusForState, type Overview } from './dashboard-data.ts';
import type { RosterCard } from '../../shared/ipc.ts';

/**
 * One summary card, Dokploy's proportions: a small uppercase label with its icon at the
 * top, a large number, and a quiet line under it. Generous padding so it reads as a
 * panel, not a chip. Presentational.
 */
function StatCard({ label, value, hint, icon }: {
    label: string;
    value: number;
    hint?: string;
    icon: React.ReactNode;
}): React.JSX.Element {
    return (
        <Card className="gap-4 p-5">
            <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">{label}</span>
                <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-4xl font-semibold leading-none tabular-nums">{value}</span>
                {hint ? <span className="text-muted-foreground text-sm">{hint}</span> : null}
            </div>
        </Card>
    );
}

/** A colleague row: status dot, name and role, its project, and a quiet state tag. */
function ColleagueRow({ card }: { card: RosterCard }): React.JSX.Element {
    const status = statusForState(card.state);
    return (
        <ListRow className="gap-4 px-5 py-4">
            <StatusDot status={status} pulse={status === 'working'} size="lg" />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{card.name}</span>
                <span className="text-muted-foreground truncate text-sm">{card.role}</span>
            </span>
            {card.project ? <span className="text-muted-foreground hidden truncate text-sm sm:block">{card.project}</span> : null}
            <Badge variant="secondary" className="text-muted-foreground shrink-0 font-normal capitalize">
                {card.state.replace(/_/g, ' ')}
            </Badge>
        </ListRow>
    );
}

/**
 * The home dashboard, presentational. Built to Dokploy's dashboard proportions: a
 * prominent heading, a row of large summary cards, and a spacious list below. It holds
 * no data logic; the hook feeds it and onNavigate hands a rail choice to the shell.
 */
export function DashboardView({ overview, current, onNavigate }: {
    overview: Overview | null;
    current: string;
    onNavigate: (view: string) => void;
}): React.JSX.Element {
    return (
        <AppShell current={current} onNavigate={onNavigate}>
            <main data-slot="content-panel" className="bg-card text-card-foreground min-w-0 flex-1 overflow-auto rounded-xl border">
                <div className="mx-auto flex max-w-6xl flex-col gap-10 px-8 py-10 md:px-12">
                    <header className="flex flex-col gap-1.5">
                        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
                        <p className="text-muted-foreground text-base">Your colleagues and projects at a glance.</p>
                    </header>

                    <ApprovalsBanner cards={overview?.cards ?? []} />

                    {overview === null ? (
                        <p className="text-muted-foreground text-sm">Loading.</p>
                    ) : overview.empty ? (
                        <Card className="items-start gap-2 p-10">
                            <p className="text-lg font-medium">No colleagues yet</p>
                            <p className="text-muted-foreground">Hire a colleague onto a project to see it here.</p>
                        </Card>
                    ) : (
                        <>
                            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                                <StatCard label="Colleagues" value={overview.stats.total}
                                    hint={overview.stats.active + ' active'} icon={<Users />} />
                                <StatCard label="Working" value={overview.stats.byState.working}
                                    hint="right now" icon={<CircleDot />} />
                                <StatCard label="Waiting for you" value={overview.stats.byState.waiting}
                                    hint="need a reply" icon={<CircleCheck />} />
                                <StatCard label="Projects" value={overview.stats.projects}
                                    hint="in your workspace" icon={<FolderGit2 />} />
                            </div>

                            <section className="flex flex-col gap-4">
                                <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">Colleagues</h2>
                                <List>
                                    {overview.cards.map((card) => <ColleagueRow key={card.id} card={card} />)}
                                </List>
                            </section>
                        </>
                    )}
                </div>
            </main>
        </AppShell>
    );
}
