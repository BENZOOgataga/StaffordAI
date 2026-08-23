import * as React from 'react';
import { Check, X, Undo2, GitBranch, FileDiff, FilePlus2, ShieldAlert, MessageSquareReply } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useTaskDiff, reviewTask } from './use-tasks.ts';
import { resultLine, shortCommit, refusalLines, deliveredOutputs, attemptLine, taskCopy } from './task-model.ts';
import type { Lang } from '../channel-view.ts';
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
 * Three controls, all consequential, all owner-only on the renderer-to-main task channel that
 * no colleague can reach. Approve is the single route to done in the whole application. Fail
 * abandons it. Send back is the one that is not an ending: it puts the colleague back to work
 * with my note as its next instruction, resuming the session it was already in, so it builds
 * on what it did rather than starting again. That is what makes a task iterative instead of
 * one-shot, and it is why the note is required for that button and optional for the others.
 */
export function TaskReview({ task, lang }: { task: TaskRow; lang: Lang }): React.JSX.Element {
    const diff = useTaskDiff(task.id, task.resultCommit);
    const [note, setNote] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [refused, setRefused] = React.useState<string | null>(null);

    const copy = taskCopy(lang);
    const trimmed = note.trim();

    const decide = (decision: 'approve' | 'fail' | 'send-back'): void => {
        // Guarded here as well as in the service, so the button reads as unavailable rather
        // than failing after a click. The service is the rule; this is the affordance.
        if (decision === 'send-back' && trimmed === '') return;
        setBusy(true);
        void (async () => {
            try {
                const reply = await reviewTask(task.id, decision, trimmed === '' ? null : trimmed);
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
            {attemptLine(task) ? (
                <p className="text-muted-foreground text-xs">{attemptLine(task)}</p>
            ) : null}

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

            {/* Every note I have sent back, oldest first. Without these the review shows a
                diff that changed for no visible reason, and on a third attempt I would have
                no way to remember what I already asked for. */}
            {task.sendBacks.length > 0 ? (
                <Section label={copy.sendBackHistory}>
                    <ul className="flex list-none flex-col gap-1.5 p-0">
                        {task.sendBacks.map((sent, i) => (
                            <li key={sent.at + String(i)} className="flex min-w-0 items-start gap-2 text-sm">
                                <MessageSquareReply className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                                <span className="text-muted-foreground min-w-0 break-words whitespace-pre-wrap">{sent.note}</span>
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
                    placeholder={copy.notePlaceholder}
                    aria-label="Note for this decision"
                    className="h-9"
                />
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={busy} onClick={() => decide('approve')}>
                        <Check aria-hidden="true" /> {copy.approve}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || trimmed === ''}
                        onClick={() => decide('send-back')}
                        title={trimmed === '' ? 'Write what should change first' : undefined}
                    >
                        <Undo2 aria-hidden="true" /> {copy.sendBack}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide('fail')}>
                        <X aria-hidden="true" /> {copy.fail}
                    </Button>
                </div>
                <span className="text-muted-foreground text-xs">
                    {copy.onlyYouClose} Sending it back sets it working again on your note.
                </span>
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
