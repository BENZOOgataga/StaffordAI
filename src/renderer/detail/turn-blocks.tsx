import * as React from 'react';
import { Brain, ChevronRight, ChevronDown, Square, SquareCheckBig, Loader2, ListChecks, CircleHelp, Circle, CircleDot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown.tsx';
import { CollapsibleLines } from './collapsible-lines.tsx';
import { DiffViewer } from '../tasks/diff-viewer.tsx';
import { FeedIconGlyph } from './feed-icon.tsx';
import { feedIcon, toolPhrase, toolStatusLabel, type FeedRow } from '../activity-view.ts';
import { groupTurn } from './group-turn.ts';
import { usePendingQuestionFor } from './use-questions.ts';
import { type Lang } from '../channel-view.ts';
import type { LiveBlock, LiveTodo, AskQuestion, AskOption, AskAnswer } from '../../shared/ipc.ts';

/**
 * The block rendering shared by a live turn and a persisted one, so a reopened conversation shows the
 * same thinking, tool calls, shell output, diffs, todos, and text it showed live. The only difference
 * is `live`: a streaming turn puts a soft caret on its last text run, a persisted turn does not.
 */

/**
 * One tool call as a collapsed inset island: the Activity feed's own icon and phrase, plus its
 * status and, for a command tool, its output. A failure takes the status-error token; a running call
 * shows a soft pulse. Reuses feedIcon/toolPhrase/toolStatusLabel so a colleague's actions read here
 * exactly as they do in Activity, and an unknown tool renders a safe generic phrase rather than
 * throwing.
 */
function ToolIsland({ block, lang }: { block: Extract<LiveBlock, { kind: 'tool' }>; lang: Lang }): React.JSX.Element {
    const isError = block.status === 'error';
    const isRunning = block.status === 'running';
    const row: FeedRow = {
        kind: 'tool', id: block.id, at: '', tool: block.name, target: block.target,
        status: isError ? 'error' : 'ok', live: true
    };
    const statusLabel = isError ? toolStatusLabel('error', lang) : null;
    const hasOutput = block.output !== undefined;
    const emptyOutput = hasOutput && (block.output ?? '').trim() === '';
    return (
        <div className={cn(
            'w-full max-w-[78%] overflow-hidden rounded-md border text-sm',
            isError ? 'border-status-error/40 bg-status-error/5' : 'border-border bg-muted/30'
        )}>
            <div className="flex items-center gap-2 px-2.5 py-1.5">
                <FeedIconGlyph icon={feedIcon(row)}
                    className={cn('size-3.5 shrink-0', isError ? 'text-status-error' : 'text-muted-foreground')} />
                <span className={cn('min-w-0 flex-1 truncate', isError ? 'text-status-error' : 'text-muted-foreground')}>
                    {toolPhrase(block.name || 'a tool', block.target, lang)}
                </span>
                {isRunning ? (
                    <span className="bg-muted-foreground/50 size-1.5 shrink-0 animate-pulse rounded-full" />
                ) : null}
                {statusLabel ? <span className="text-status-error shrink-0 text-xs">{statusLabel}</span> : null}
            </div>
            {hasOutput ? (
                <div className="px-2 pb-2">
                    {emptyOutput
                        ? <p className="text-muted-foreground px-2 py-1 font-mono text-xs">(no output)</p>
                        : <CollapsibleLines text={block.output ?? ''} />}
                </div>
            ) : null}
        </div>
    );
}

/**
 * The colleague's reasoning as a collapsed muted island above the reply. Collapsed by default, click
 * to expand. Reads "Thinking..." while it streams and "Thought for Ns" once it finishes. The
 * cryptographic signature is never in this text, it is dropped upstream.
 */
function ThinkingIsland({ text, seconds, lang }: { text: string; seconds: number | null; lang: Lang }): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    const label = seconds === null
        ? (lang === 'fr' ? 'Réflexion...' : 'Thinking...')
        : (lang === 'fr' ? 'Réfléchi pendant ' + seconds + ' s' : 'Thought for ' + seconds + 's');
    return (
        <div className="bg-muted/40 border-border w-full max-w-[78%] overflow-hidden rounded-md border">
            <button
                type="button"
                data-thinking
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="hover:bg-accent/30 flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
            >
                {open
                    ? <ChevronDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                    : <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />}
                <Brain className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{label}</span>
            </button>
            {open ? (
                <div className="text-muted-foreground border-border border-t px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
                    {text !== ''
                        ? text
                        : <span className="italic">{lang === 'fr' ? '(raisonnement non affiché)' : '(reasoning not shown)'}</span>}
                </div>
            ) : null}
        </div>
    );
}

/** The state glyph for a todo row: checked when done, a spinner while in progress, an empty box else. */
function TodoGlyph({ status }: { status: LiveTodo['status'] }): React.JSX.Element {
    if (status === 'done') return <SquareCheckBig className="text-status-idle size-3.5 shrink-0" aria-hidden="true" />;
    if (status === 'in-progress') return <Loader2 className="text-status-working size-3.5 shrink-0 animate-spin" aria-hidden="true" />;
    return <Square className="text-muted-foreground/60 size-3.5 shrink-0" aria-hidden="true" />;
}

/** A colleague's plan, from TodoWrite, as a checklist island: shadcn checkbox-style rows with a state
 * glyph per item. An empty list renders just the header, never a crash. Reused by the Activity tab. */
export function TodoList({ todos, lang }: { todos: readonly LiveTodo[]; lang: Lang }): React.JSX.Element {
    const doneCount = todos.filter((t) => t.status === 'done').length;
    return (
        <div className="bg-muted/40 border-border w-full max-w-[78%] overflow-hidden rounded-md border">
            <div className="text-muted-foreground flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <ListChecks className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="font-medium">{lang === 'fr' ? 'Plan' : 'Plan'}</span>
                {todos.length > 0 ? <span className="tabular-nums">{doneCount}/{todos.length}</span> : null}
            </div>
            {todos.length > 0 ? (
                <ul className="border-border list-none border-t px-2.5 py-1.5">
                    {todos.map((t, i) => (
                        <li key={i} className="flex items-start gap-2 py-0.5 text-sm">
                            <span className="mt-0.5"><TodoGlyph status={t.status} /></span>
                            <span className={cn(
                                'min-w-0 flex-1 break-words',
                                t.status === 'done' ? 'text-muted-foreground line-through'
                                    : t.status === 'in-progress' ? 'text-foreground' : 'text-muted-foreground'
                            )}>
                                {t.text}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

/** The "Asked a question" header, shared by every state of the ask island. */
function AskHeader({ lang }: { lang: Lang }): React.JSX.Element {
    return (
        <div className="text-status-waiting flex items-center gap-2 text-xs font-medium">
            <CircleHelp className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{lang === 'fr' ? 'A posé une question' : 'Asked a question'}</span>
        </div>
    );
}

/** The labels a person chose for one question that are not one of its listed options (a free-text answer). */
function customAnswers(chosen: readonly string[], options: readonly AskOption[]): string[] {
    return chosen.filter((c) => !options.some((o) => o.label === c));
}

/**
 * One option row, rendered the same in the live form (clickable) and the answered/read-only view
 * (locked). `selected` fills it in Stafford's waiting accent; `onPick` present makes it a button, its
 * absence a static row, so an answered ask shows the pick without being re-clickable.
 */
function AskOptionRow({ option, selected, multi, onPick }: {
    option: AskOption; selected: boolean; multi: boolean; onPick?: () => void;
}): React.JSX.Element {
    const Marker = multi
        ? (selected ? SquareCheckBig : Square)
        : (selected ? CircleDot : Circle);
    const body = (
        <>
            <Marker className={cn('mt-0.5 size-3.5 shrink-0', selected ? 'text-status-waiting' : 'text-muted-foreground/60')} aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className={cn('block break-words', selected ? 'text-foreground font-medium' : 'text-foreground')}>{option.label}</span>
                {option.description !== '' ? <span className="text-muted-foreground block break-words text-xs">{option.description}</span> : null}
            </span>
        </>
    );
    const cls = cn(
        'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm',
        selected ? 'border-status-waiting/50 bg-status-waiting/10' : 'border-border bg-background/40'
    );
    return onPick
        ? <button type="button" onClick={onPick} className={cn(cls, 'hover:border-status-waiting/40')}>{body}</button>
        : <div className={cls}>{body}</div>;
}

/**
 * The answered or read-only view of an ask: every question with its options, the chosen ones filled in
 * and locked, plus any free-text answer as its own row. With no answer (a persisted ask that was never
 * answered, or the Activity tab) the options simply show unselected, never a broken control.
 */
function AskAnswered({ questions, answer, lang }: {
    questions: readonly AskQuestion[]; answer: AskAnswer | undefined; lang: Lang;
}): React.JSX.Element {
    return (
        <div className="border-status-waiting/40 bg-status-waiting/5 w-full max-w-[78%] rounded-md border px-2.5 py-2 text-sm">
            <AskHeader lang={lang} />
            <div className="mt-1.5 flex flex-col gap-3">
                {questions.map((q, qi) => {
                    const chosen = answer?.[q.question] ?? [];
                    const customs = customAnswers(chosen, q.options);
                    return (
                        <div key={qi} className="flex flex-col gap-1.5">
                            <div className="text-foreground font-medium whitespace-pre-wrap">{q.question}</div>
                            {q.options.map((o, oi) => (
                                <AskOptionRow key={oi} option={o} multi={q.multiSelect} selected={chosen.includes(o.label)} />
                            ))}
                            {customs.map((c, ci) => (
                                <AskOptionRow key={'c' + ci} option={{ label: c, description: '' }} multi={q.multiSelect} selected />
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * The live answer form for an ask that is still waiting: clickable options (a radio per question, or
 * checkboxes when the question is multi-select), a free-text field for a custom answer, and a Send
 * button that routes the selection back to the blocked colleague as its tool result. A send failure
 * keeps the choices answerable and shows the error inline, so the prompt is never lost.
 */
function AskAnswerForm({ questions, pendingId, lang }: {
    questions: readonly AskQuestion[]; pendingId: string; lang: Lang;
}): React.JSX.Element {
    const [selections, setSelections] = React.useState<Record<string, string[]>>({});
    const [freeText, setFreeText] = React.useState<Record<string, string>>({});
    const [sending, setSending] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const pick = (qText: string, label: string, multi: boolean): void => {
        setSelections((prev) => {
            const current = prev[qText] ?? [];
            if (multi) {
                const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
                return { ...prev, [qText]: next };
            }
            return { ...prev, [qText]: current.length === 1 && current[0] === label ? [] : [label] };
        });
    };

    const answersToSend = (): AskAnswer => {
        const out: Record<string, string[]> = {};
        for (const q of questions) {
            const picked = [...(selections[q.question] ?? [])];
            const typed = (freeText[q.question] ?? '').trim();
            if (typed !== '') picked.push(typed);
            if (picked.length > 0) out[q.question] = picked;
        }
        return out;
    };

    const canSend = Object.keys(answersToSend()).length > 0 && !sending;

    const send = (): void => {
        const answers = answersToSend();
        if (Object.keys(answers).length === 0) return;
        setSending(true);
        setError(null);
        window.stafford.questions.answer(pendingId, answers).catch(() => {
            setSending(false);
            setError(lang === 'fr' ? "L'envoi a échoué. Réessayez." : 'Sending failed. Try again.');
        });
    };

    return (
        <div className="border-status-waiting/50 bg-status-waiting/5 w-full max-w-[78%] rounded-md border px-2.5 py-2 text-sm">
            <AskHeader lang={lang} />
            <div className="mt-1.5 flex flex-col gap-3">
                {questions.map((q, qi) => {
                    const picked = selections[q.question] ?? [];
                    return (
                        <div key={qi} className="flex flex-col gap-1.5">
                            <div className="text-foreground font-medium whitespace-pre-wrap">{q.question}</div>
                            {q.options.map((o, oi) => (
                                <AskOptionRow key={oi} option={o} multi={q.multiSelect}
                                    selected={picked.includes(o.label)} onPick={() => pick(q.question, o.label, q.multiSelect)} />
                            ))}
                            <input
                                type="text"
                                value={freeText[q.question] ?? ''}
                                onChange={(e) => setFreeText((prev) => ({ ...prev, [q.question]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter' && canSend) send(); }}
                                placeholder={lang === 'fr' ? 'Autre réponse...' : 'Other answer...'}
                                className="border-border bg-background/60 text-foreground focus:border-status-waiting/50 mt-0.5 w-full rounded-md border px-2 py-1 text-sm outline-none"
                            />
                        </div>
                    );
                })}
            </div>
            <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={send} disabled={!canSend}
                    className="bg-status-waiting/90 hover:bg-status-waiting text-background disabled:opacity-40 rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed">
                    {sending ? (lang === 'fr' ? 'Envoi...' : 'Sending...') : (lang === 'fr' ? 'Envoyer' : 'Send answer')}
                </button>
                {error ? <span className="text-status-error text-xs">{error}</span> : null}
            </div>
        </div>
    );
}

/**
 * A colleague's clarifying question, from AskUserQuestion, as a visible step so the ask is not lost
 * behind a generic tool one-liner. It shows the choices and, while the colleague is blocked waiting,
 * lets the person pick an answer that routes back as the tool result. Not the permission-approval
 * banner, which is a separate flow. The ask is never nested inside collapsed reasoning, so it is
 * always seen.
 */
function AskIsland({ block, lang }: { block: Extract<LiveBlock, { kind: 'tool' }>; lang: Lang }): React.JSX.Element {
    const pending = usePendingQuestionFor(block.id);
    const questions = block.ask;
    const answered = block.answer !== undefined;
    const active = !answered && pending !== null;

    // No structured choices parsed (malformed input): degrade to the plain question text as before.
    if (!questions || questions.length === 0) {
        return (
            <div className="border-status-waiting/40 bg-status-waiting/5 w-full max-w-[78%] rounded-md border px-2.5 py-1.5 text-sm">
                <AskHeader lang={lang} />
                {block.question !== undefined
                    ? <div className="text-foreground mt-1 whitespace-pre-wrap">{block.question}</div>
                    : null}
            </div>
        );
    }
    return active && pending
        ? <AskAnswerForm questions={questions} pendingId={pending.id} lang={lang} />
        : <AskAnswered questions={questions} answer={block.answer} lang={lang} />;
}

/**
 * A flat run of blocks, rendered as islands and bubbles. Used both at the top level of a turn and,
 * with `insideReasoning`, inside the reasoning container, where a thinking block renders as plain
 * reasoning text rather than another collapsed island. `live` puts a caret on the last text run.
 */
function BlockList({ blocks, lang, live, insideReasoning = false }: {
    blocks: readonly LiveBlock[];
    lang: Lang;
    live: boolean;
    insideReasoning?: boolean;
}): React.JSX.Element {
    let lastTextIndex = -1;
    blocks.forEach((b, i) => { if (b.kind === 'text' && b.text !== '') lastTextIndex = i; });
    let firstTodoIndex = -1;
    let currentTodos: readonly LiveTodo[] | null = null;
    blocks.forEach((b, i) => {
        if (b.kind === 'tool' && b.todos !== undefined) {
            if (firstTodoIndex === -1) firstTodoIndex = i;
            currentTodos = b.todos;
        }
    });
    return (
        <div className="flex w-full flex-col items-start gap-1.5">
            {blocks.map((block, i) => {
                if (block.kind === 'text') {
                    if (block.text === '') return null;
                    return (
                        <div key={i} className="bg-card border-border max-w-[78%] rounded-lg border px-3 py-1.5 text-sm break-words">
                            <Markdown text={block.text} />
                            {live && !insideReasoning && i === lastTextIndex ? (
                                <span className="bg-muted-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] align-middle" />
                            ) : null}
                        </div>
                    );
                }
                if (block.kind === 'thinking') {
                    if (block.text === '' && block.seconds === null) return null;
                    // Inside the reasoning container the thinking is the reasoning, shown as plain text.
                    // At the top level (a lone thinking with no actions), it keeps its own island.
                    if (insideReasoning) {
                        return (
                            <div key={i} className="text-muted-foreground w-full max-w-[78%] text-xs leading-relaxed whitespace-pre-wrap">
                                {block.text !== ''
                                    ? block.text
                                    : <span className="italic">{lang === 'fr' ? '(raisonnement non affiché)' : '(reasoning not shown)'}</span>}
                            </div>
                        );
                    }
                    return <ThinkingIsland key={i} text={block.text} seconds={block.seconds} lang={lang} />;
                }
                if (block.name === 'AskUserQuestion' && (block.ask !== undefined || block.question !== undefined)) {
                    return <AskIsland key={i} block={block} lang={lang} />;
                }
                if (block.todos !== undefined) {
                    return i === firstTodoIndex && currentTodos
                        ? <TodoList key="todos" todos={currentTodos} lang={lang} />
                        : null;
                }
                if (block.edit) {
                    return <div key={i} className="w-full max-w-[78%]"><DiffViewer files={[block.edit]} defaultOpen /></div>;
                }
                return <ToolIsland key={i} block={block} lang={lang} />;
            })}
        </div>
    );
}

/**
 * The collapsed reasoning container: it wraps the thinking and the actions the colleague took while
 * reasoning, so even redacted reasoning has real content (the tool calls). Collapsed by default, a
 * click reveals the reasoning text and the nested action islands. The final reply renders after it.
 */
function ReasoningBlock({ blocks, seconds, lang }: {
    blocks: readonly LiveBlock[];
    seconds: number | null;
    lang: Lang;
}): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    const label = seconds === null
        ? (lang === 'fr' ? 'Réflexion...' : 'Reasoning...')
        : (lang === 'fr' ? 'A travaillé ' + seconds + ' s' : 'Worked for ' + seconds + 's');
    return (
        <div className="bg-muted/40 border-border w-full max-w-[78%] overflow-hidden rounded-md border">
            <button type="button" data-reasoning aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="hover:bg-accent/30 flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
                {open
                    ? <ChevronDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                    : <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />}
                <Brain className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{label}</span>
            </button>
            {open ? (
                <div className="border-border border-t px-2.5 py-2">
                    <BlockList blocks={blocks} lang={lang} live={false} insideReasoning />
                </div>
            ) : null}
        </div>
    );
}

/**
 * The layout of one turn: a collapsed reasoning block wrapping the thinking and the actions taken
 * while reasoning, then the final reply after it, with any blocks outside the reasoning span kept at
 * the top level. The reasoning span is inferred from block order (see groupTurn). A turn with no
 * thinking has no reasoning block and renders flat, as before. `live` puts the streaming caret on the
 * final reply. Reuses the same block renderers live and persisted, so a reopened turn nests the same.
 */
export function TurnBlocks({ blocks, lang, live }: {
    blocks: readonly LiveBlock[];
    lang: Lang;
    live: boolean;
}): React.JSX.Element {
    const items = groupTurn(blocks);
    const parts: React.JSX.Element[] = [];
    let buffer: LiveBlock[] = [];
    let key = 0;
    const flush = (): void => {
        if (buffer.length === 0) return;
        parts.push(<BlockList key={'b' + key++} blocks={buffer} lang={lang} live={live} />);
        buffer = [];
    };
    for (const item of items) {
        if (item.kind === 'block') { buffer.push(item.block); continue; }
        flush();
        parts.push(<ReasoningBlock key={'r' + key++} blocks={item.blocks} seconds={item.seconds} lang={lang} />);
    }
    flush();
    return <div className="flex w-full flex-col items-start gap-1.5">{parts}</div>;
}
