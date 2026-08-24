import * as React from 'react';
import { ClipboardList, ShieldAlert, GitBranch, ChevronRight, Users } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { useBoard } from './use-board.ts';
import {
    boardCopy, buildBoard, waitingCounts, cardTitle, cardNote,
    type BoardCard, type BoardColumn, type BoardCopy, type ColumnId
} from './board-model.ts';
import type { Lang } from '../channel-view.ts';

/**
 * The board: every colleague's tasks, arranged by lifecycle state.
 *
 * It exists for one question. The per-colleague Tasks tab is where I work with one person,
 * and it is exactly the wrong shape for "is anything waiting on me", because the answer is
 * spread across as many tabs as I have colleagues and an unattended task can sit in needs-you
 * unseen. So this is at the app level beside Home and Roster, and the waiting column leads.
 *
 * **It writes nothing.** A card takes me to that colleague's Tasks tab, where the review
 * surface and its approve, send back and fail already live. There is deliberately no drag to
 * move a card between columns: that would be a second way to change a task's state, and the
 * rule the whole feature rests on is that a task reaches done exactly one way, through a
 * review I actually did.
 */
export function BoardScreen({ lang, current, onNavigate, onOpenTask, onHire }: {
    lang: Lang;
    current: string;
    onNavigate: (view: string) => void;
    /** Takes me to the colleague whose task this is, where the review surface lives. */
    onOpenTask: (hireId: string) => void;
    /** Opens the hire flow, for the empty board with no colleagues. */
    onHire: () => void;
}): React.JSX.Element {
    const { rows, names, awaiting, closedTruncated, loaded, error } = useBoard();
    const copy = boardCopy(lang);
    const columns = buildBoard({ rows, names, awaiting, closedTruncated, copy });
    const waiting = waitingCounts(rows, awaiting);

    // Three empty shapes, told apart so the board points at the real next action instead of
    // repeating a generic label per column. Gated on `loaded` so nothing flashes before the
    // first read lands. A missing column is never dropped in the populated case (an empty
    // "waiting for you" is itself the answer), so the whole-board empty state only replaces
    // the columns when there is genuinely nothing to arrange.
    const noColleagues = loaded && names.size === 0;
    const noTasks = loaded && names.size > 0 && rows.length === 0;
    const firstColleagueId = names.size > 0 ? [...names.keys()][0] ?? null : null;

    return (
        <AppShell current={current} onNavigate={onNavigate}>
            <section
                data-slot="content-panel"
                aria-label="Task board"
                className="bg-card text-card-foreground flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
            >
                <div className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-3">
                    <span className="flex items-center gap-2">
                        <ClipboardList className="size-4" aria-hidden="true" />
                        <h1 className="text-sm font-semibold tracking-tight">{copy.title}</h1>
                    </span>
                    <span className="text-muted-foreground text-sm">{copy.subtitle}</span>
                    {/* The headline number, because it is the reason to open this screen. */}
                    <span className={'ml-auto text-sm ' + (waiting.total > 0 ? 'text-status-waiting font-medium' : 'text-muted-foreground')}>
                        {waiting.total > 0 ? copy.waitingSummary(waiting.review, waiting.paused) : copy.nothingWaiting}
                    </span>
                </div>

                {error ? <p className="text-status-error/90 px-5 py-3 text-sm">{error}</p> : null}

                <div className="min-h-0 flex-1 overflow-auto p-3">
                    {noColleagues || noTasks ? (
                        <BoardEmptyState
                            copy={copy}
                            kind={noColleagues ? 'no-colleagues' : 'no-tasks'}
                            onHire={onHire}
                            onAssign={() => { if (firstColleagueId) onOpenTask(firstColleagueId); }}
                        />
                    ) : (
                        /* Columns wrap rather than scrolling sideways, because a column pushed off
                           a narrow window is a waiting task I cannot see, which is the one thing
                           this screen must never do. The translated labels are longer, so a layout
                           that only just fits in English is already broken in French. */
                        <div className="flex flex-wrap items-start gap-3">
                            {columns.map((column) => (
                                <BoardColumnView
                                    key={column.id}
                                    column={column}
                                    emptyLabel={copy.empty}
                                    onOpenTask={onOpenTask}
                                    loaded={loaded}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </AppShell>
    );
}

/**
 * The whole-board empty state, shown instead of five empty columns. It tells the two empty
 * shapes apart and points each at its real next action: hire a colleague when there are none,
 * or assign a task when there are colleagues but no tasks. The action is a real button, not
 * just text, wired to the same flows the roster and the detail Tasks tab already use.
 */
function BoardEmptyState({ copy, kind, onHire, onAssign }: {
    copy: BoardCopy;
    kind: 'no-colleagues' | 'no-tasks';
    onHire: () => void;
    onAssign: () => void;
}): React.JSX.Element {
    const noColleagues = kind === 'no-colleagues';
    const Icon = noColleagues ? Users : ClipboardList;
    return (
        <div className="flex min-h-full items-center justify-center p-6">
            <Card className="max-w-md items-center gap-3 p-8 text-center">
                <span className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
                    <Icon className="size-5" aria-hidden="true" />
                </span>
                <p className="text-base font-medium">{noColleagues ? copy.noColleaguesTitle : copy.noTasksTitle}</p>
                <p className="text-muted-foreground text-sm">{noColleagues ? copy.noColleaguesBody : copy.noTasksBody}</p>
                <Button size="sm" className="mt-1" onClick={noColleagues ? onHire : onAssign}>
                    {noColleagues ? copy.hireAction : copy.assignAction}
                </Button>
            </Card>
        </div>
    );
}

function BoardColumnView({ column, emptyLabel, onOpenTask, loaded }: {
    column: BoardColumn;
    emptyLabel: string;
    onOpenTask: (hireId: string) => void;
    loaded: boolean;
}): React.JSX.Element {
    return (
        <section
            aria-label={column.label}
            className="flex min-w-0 flex-1 basis-[clamp(220px,18%,320px)] flex-col gap-2"
        >
            <div className="flex items-baseline justify-between gap-2 px-1">
                <span
                    className={'text-xs font-medium tracking-wider uppercase ' +
                        (column.primary && column.cards.length > 0 ? 'text-status-waiting' : 'text-muted-foreground')}
                >
                    {column.label}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">{column.cards.length}</span>
            </div>

            <div className="flex flex-col gap-2">
                {column.cards.map((card) => (
                    <TaskCardView key={card.task.id} card={card} onOpenTask={onOpenTask} />
                ))}
                {loaded && column.cards.length === 0 ? (
                    <p className="text-muted-foreground/60 px-1 py-2 text-xs">{emptyLabel}</p>
                ) : null}
                {column.truncatedNote ? (
                    <p className="text-muted-foreground px-1 text-xs">{column.truncatedNote}</p>
                ) : null}
            </div>
        </section>
    );
}

/** One task. Clicking it goes to the review surface; it changes nothing itself. */
function TaskCardView({ card, onOpenTask }: {
    card: BoardCard;
    onOpenTask: (hireId: string) => void;
}): React.JSX.Element {
    const { task, hireName, waiting } = card;
    const open = (): void => onOpenTask(task.hireId);
    const note = cardNote(task);

    return (
        <Card
            role="button"
            tabIndex={0}
            aria-label={'Open ' + hireName + ' task: ' + cardTitle(task)}
            onClick={open}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
            }}
            className={'focus-visible:ring-ring hover:bg-accent/50 cursor-pointer gap-1.5 p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none ' +
                (waiting ? 'border-status-waiting/40' : '')}
        >
            <div className="flex min-w-0 items-center gap-2">
                <StatusDot status={dotFor(task.state, waiting)} pulse={task.state === 'working' && !waiting} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{hireName}</span>
                {waiting ? (
                    <ShieldAlert className="text-status-waiting size-3.5 shrink-0" aria-label="waiting for you" />
                ) : null}
                <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
            </div>
            <p className="min-w-0 text-sm break-words">{cardTitle(task)}</p>
            {note ? (
                <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate text-xs">
                    {task.resultBranch && task.state !== 'failed'
                        ? <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                        : null}
                    <span className="min-w-0 truncate">{note}</span>
                </p>
            ) : null}
        </Card>
    );
}

/** The status colour a card reads as. Waiting on me is the one that stands out. */
function dotFor(state: ColumnId | string, waiting: boolean): 'working' | 'waiting' | 'idle' | 'error' {
    if (waiting) return 'waiting';
    if (state === 'working') return 'working';
    if (state === 'failed') return 'error';
    return 'idle';
}
