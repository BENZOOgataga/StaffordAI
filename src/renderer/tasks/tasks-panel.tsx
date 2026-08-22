import * as React from 'react';
import { Play, Send, ChevronRight, ChevronDown, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { StatusDot } from '@/components/ui/status-dot';
import { List, ListRow } from '@/components/ui/list';
import { TaskReview } from './task-review.tsx';
import { useTasks, assignTask, startTask } from './use-tasks.ts';
import { useApprovals } from '../approvals/use-approvals.ts';
import {
    taskCopy, buildTaskGroups, stateText, isReviewable, isStartable, resultLine
} from './task-model.ts';
import type { TaskRow } from '../../shared/ipc.ts';
import type { Lang } from '../channel-view.ts';

/**
 * The Tasks tab: assign a colleague a task, and review the ones waiting for me.
 *
 * It sits in the colleague detail pane rather than on a screen of its own because a task is
 * something I give to a person. Assigning one belongs where I already work with them, beside
 * their conversation, and a task board across everyone is Model B rather than this.
 *
 * A task waiting on a permission ask is shown as waiting here too, and says so, but the
 * answering happens on the approvals surface that already exists rather than being rebuilt.
 * Both kinds of waiting read as waiting on me, which is the thing that matters; what differs
 * is what I do about it, and that is where they part.
 */
export function TasksPanel({ hireId, hireName, lang }: {
    hireId: string;
    hireName: string;
    lang: Lang;
}): React.JSX.Element {
    const { tasks, loaded, error } = useTasks(hireId);
    const pending = useApprovals();
    const copy = taskCopy(lang);
    const [open, setOpen] = React.useState<string | null>(null);

    // This colleague is paused on an ask. Not a task state: its turn is live and resumes the
    // moment I answer, so it colours how a working task reads rather than moving it.
    const awaitingApproval = pending.some((a) => a.hireId === hireId);
    const groups = buildTaskGroups(tasks, copy);

    // The one waiting for me opens by itself, since a review I have to hunt for is a review
    // I will put off. Only when exactly one is waiting, so a queue does not fight over it.
    const waiting = tasks.filter((t) => t.state === 'needs-you');
    const soleWaitingId = waiting.length === 1 ? waiting[0]?.id ?? null : null;
    React.useEffect(() => { if (soleWaitingId) setOpen(soleWaitingId); }, [soleWaitingId]);

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <AssignForm hireId={hireId} hireName={hireName} />

            {error ? <p className="text-status-error/90 text-sm">{error}</p> : null}

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                {!loaded ? null : tasks.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                        No tasks yet. Give {hireName} something to work on and they will get on with it.
                    </p>
                ) : (
                    groups.map((group) => (
                        <section key={group.id} className="flex flex-col gap-2">
                            <div className="flex items-baseline justify-between gap-2 px-1">
                                <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                    {group.label}
                                </span>
                                <span className="text-muted-foreground text-xs tabular-nums">{group.tasks.length}</span>
                            </div>
                            <List>
                                {group.tasks.map((task) => (
                                    <TaskItem
                                        key={task.id}
                                        task={task}
                                        copy={copy}
                                        awaitingApproval={awaitingApproval}
                                        expanded={open === task.id}
                                        onToggle={() => setOpen(open === task.id ? null : task.id)}
                                    />
                                ))}
                            </List>
                        </section>
                    ))
                )}
            </div>
        </div>
    );
}

/** One task in the list: its state, its instruction, and its review when opened. */
function TaskItem({ task, copy, awaitingApproval, expanded, onToggle }: {
    task: TaskRow;
    copy: ReturnType<typeof taskCopy>;
    awaitingApproval: boolean;
    expanded: boolean;
    onToggle: () => void;
}): React.JSX.Element {
    const [busy, setBusy] = React.useState(false);
    const paused = awaitingApproval && task.state === 'working';
    const reviewable = isReviewable(task);

    const start = (event: React.MouseEvent): void => {
        event.stopPropagation();
        setBusy(true);
        void startTask(task.id).finally(() => setBusy(false));
    };

    return (
        <ListRow className="flex-col items-stretch gap-2 px-4 py-3">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={onToggle}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); }
                }}
                className="focus-visible:ring-ring flex min-w-0 cursor-pointer items-start gap-3 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
            >
                {expanded
                    ? <ChevronDown className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    : <ChevronRight className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                <StatusDot
                    status={dotFor(task.state, paused)}
                    pulse={task.state === 'working' && !paused}
                    className="mt-1.5"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{firstLine(task.text)}</span>
                    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate text-xs">
                        {paused ? <ShieldAlert className="text-status-waiting size-3 shrink-0" aria-hidden="true" /> : null}
                        {stateText(task, copy, awaitingApproval)}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">{resultLine(task, null)}</span>
                </span>
                {isStartable(task) ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={start}>
                        <Play aria-hidden="true" /> Start
                    </Button>
                ) : null}
            </div>

            {expanded ? (
                <div className="border-border mt-1 border-t pt-3">
                    {reviewable
                        ? <TaskReview task={task} />
                        : <ClosedOrRunning task={task} />}
                </div>
            ) : null}
        </ListRow>
    );
}

/** A task that is not mine to decide on: what it was, and what came of it. */
function ClosedOrRunning({ task }: { task: TaskRow }): React.JSX.Element {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-sm whitespace-pre-wrap break-words">{task.text}</p>
            {task.resultSummary ? (
                <p className="text-muted-foreground text-sm whitespace-pre-wrap break-words">{task.resultSummary}</p>
            ) : null}
            {task.failedReason ? <p className="text-status-error/90 text-sm">{task.failedReason}</p> : null}
            {task.resultBranch ? (
                <code className="text-muted-foreground min-w-0 break-all text-xs">{task.resultBranch}</code>
            ) : null}
        </div>
    );
}

/** Give this colleague something to do. */
function AssignForm({ hireId, hireName }: { hireId: string; hireName: string }): React.JSX.Element {
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const submit = (): void => {
        const instruction = text.trim();
        if (instruction === '' || busy) return;
        setBusy(true);
        setError(null);
        void (async () => {
            try {
                const created = await assignTask(hireId, instruction);
                if (!created.ok || !created.task) {
                    setError(created.refused ?? 'The task could not be assigned.');
                    return;
                }
                setText('');
                // Assigning and starting are separate in the engine so a stray click costs a
                // row and not a run. From here they are one action, because a person filling
                // in an instruction and pressing Assign has already decided.
                const started = await startTask(created.task.id);
                if (!started.ok) setError(started.refused ?? 'The task was assigned but could not start.');
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setBusy(false);
            }
        })();
    };

    return (
        <Card className="gap-2 p-3">
            <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(event) => {
                    // Enter sends, as it does everywhere else here. Shift and Enter is a new
                    // line, since a real instruction is often more than one.
                    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
                }}
                placeholder={'Give ' + hireName + ' a task. They will work it on their own and come back for review.'}
                aria-label={'Task for ' + hireName}
                rows={2}
                className="min-h-16 resize-none"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                    They work under their own permissions and cannot close the task themselves.
                </span>
                <Button size="sm" disabled={busy || text.trim() === ''} onClick={submit}>
                    <Send aria-hidden="true" /> Assign
                </Button>
            </div>
            {error ? <p className="text-status-error/90 text-sm">{error}</p> : null}
        </Card>
    );
}

/** The status colour a task reads as. Waiting on me is the one that stands out. */
function dotFor(state: string, paused: boolean): 'working' | 'waiting' | 'idle' | 'error' {
    if (paused) return 'waiting';
    if (state === 'needs-you') return 'waiting';
    if (state === 'working') return 'working';
    if (state === 'failed') return 'error';
    return 'idle';
}

function firstLine(text: string): string {
    const line = (text.split('\n')[0] ?? '').trim();
    return line.length > 0 ? line : text.trim();
}
