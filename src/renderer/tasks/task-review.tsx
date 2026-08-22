import * as React from 'react';
import { Check, X, GitBranch, FileDiff, FilePlus2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useTaskDiff, reviewTask } from './use-tasks.ts';
import { resultLine, shortCommit, refusalLines, deliveredOutputs } from './task-model.ts';
import type { TaskRow } from '../../shared/ipc.ts';

/**
 * The review, which is what needs-you means.
 *
 * The order is the order I read in, and it is the whole design of this panel. What I asked
 * for, then what the colleague says it did, then what actually changed. The summary is above
 * the diff and not below it because I want the claim before the evidence, and the diff is
 * last because it is the part I trust: it is the work rather than a description of the work.
 *
 * The diff is worth trusting here in a way it was not before. The result branch holds exactly
 * this task's own changes, so a file listed is a file this colleague touched, rather than
 * whatever happened to be dirty when it finished.
 *
 * Approve and Fail are consequential and are the only two shipped. Approving is the single
 * route to done in the whole application, and it exists on the renderer-to-main task channel
 * alone, which no colleague can reach. Send-back is deliberately absent rather than
 * half-built: the transition is legal already, but returning a task to working without
 * feeding my note into the next turn would leave it sitting in a state nothing is running,
 * which is worse than not offering it. That note-as-instruction is phase 2.
 */
export function TaskReview({ task }: { task: TaskRow }): React.JSX.Element {
    const diff = useTaskDiff(task.id, task.resultCommit);
    const [note, setNote] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [refused, setRefused] = React.useState<string | null>(null);

    const decide = (decision: 'approve' | 'fail'): void => {
        setBusy(true);
        void (async () => {
            try {
                const reply = await reviewTask(task.id, decision, note.trim() === '' ? null : note.trim());
                setRefused(reply.ok ? null : reply.refused);
            } catch (error) {
                setRefused(error instanceof Error ? error.message : String(error));
            } finally {
                setBusy(false);
            }
        })();
    };

    const delivered = deliveredOutputs(task);
    const refusals = refusalLines(task.refusedOutputs);

    return (
        <div className="flex flex-col gap-4">
            <Section label="What I asked for">
                <p className="text-sm whitespace-pre-wrap break-words">{task.text}</p>
            </Section>

            <Section label="What it says it did">
                {task.resultSummary ? (
                    <p className="text-muted-foreground text-sm whitespace-pre-wrap break-words">{task.resultSummary}</p>
                ) : (
                    <p className="text-muted-foreground text-sm italic">It said nothing.</p>
                )}
                {task.failedReason ? (
                    <p className="text-status-error/90 mt-2 text-sm">{task.failedReason}</p>
                ) : null}
            </Section>

            <Section label="What actually changed">
                {task.resultBranch === null ? (
                    <p className="text-muted-foreground text-sm">
                        Nothing was committed. It changed no tracked file, and named no new one.
                    </p>
                ) : (
                    <div className="flex flex-col gap-2">
                        <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-2 text-xs">
                            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                            <code className="min-w-0 break-all">{task.resultBranch}</code>
                            {shortCommit(task.resultCommit) ? (
                                <Badge variant="secondary" className="font-mono font-normal">
                                    {shortCommit(task.resultCommit)}
                                </Badge>
                            ) : null}
                        </div>

                        {diff.error ? (
                            <p className="text-status-error/90 text-sm">{diff.error}</p>
                        ) : !diff.loaded ? (
                            <p className="text-muted-foreground text-sm">Reading the branch...</p>
                        ) : diff.files.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No file changes on the branch.</p>
                        ) : (
                            <>
                                <p className="text-muted-foreground text-xs">{resultLine(task, diff.files)}</p>
                                <ul className="flex list-none flex-col gap-1 p-0">
                                    {diff.files.map((file) => (
                                        <li key={file.path} className="flex min-w-0 items-center gap-2 text-sm">
                                            <FileDiff className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                                            <code className="min-w-0 flex-1 truncate">{file.path}</code>
                                            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                                                +{file.added} / -{file.removed}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>
                )}
            </Section>

            {/* Only when the colleague named something. A refusal is shown here rather than
                left silent, because a file it thinks it delivered and that is not on the
                branch is exactly the discrepancy a review exists to catch. */}
            {task.declaredOutputs.length > 0 ? (
                <Section label="New files it named">
                    <ul className="flex list-none flex-col gap-1 p-0">
                        {delivered.map((name) => (
                            <li key={name} className="flex min-w-0 items-center gap-2 text-sm">
                                <FilePlus2 className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                                <code className="min-w-0 truncate">{name}</code>
                            </li>
                        ))}
                        {refusals.map((line) => (
                            <li key={line} className="flex min-w-0 items-start gap-2 text-sm">
                                <ShieldAlert className="text-status-waiting mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                                <span className="text-muted-foreground min-w-0 break-words">
                                    Not committed: {line}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Section>
            ) : null}

            <Separator />

            <div className="flex flex-col gap-2">
                <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Reason (optional, kept on the task if you fail it)"
                    aria-label="Reason for this decision"
                    className="h-9"
                />
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={busy} onClick={() => decide('approve')}>
                        <Check aria-hidden="true" /> Approve
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide('fail')}>
                        <X aria-hidden="true" /> Fail
                    </Button>
                    <span className="text-muted-foreground text-xs">
                        Approving closes the task. Only you can.
                    </span>
                </div>
                {refused ? <p className="text-status-error/90 text-sm">{refused}</p> : null}
            </div>
        </div>
    );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <section className="flex min-w-0 flex-col gap-1.5">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">{label}</h4>
            {children}
        </section>
    );
}
