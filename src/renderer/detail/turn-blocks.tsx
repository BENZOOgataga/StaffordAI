import * as React from 'react';
import { Brain, ChevronRight, ChevronDown, Square, SquareCheckBig, Loader2, ListChecks } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown.tsx';
import { CollapsibleLines } from './collapsible-lines.tsx';
import { DiffViewer } from '../tasks/diff-viewer.tsx';
import { FeedIconGlyph } from './feed-icon.tsx';
import { feedIcon, toolPhrase, toolStatusLabel, type FeedRow } from '../activity-view.ts';
import { type Lang } from '../channel-view.ts';
import type { LiveBlock, LiveTodo } from '../../shared/ipc.ts';

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

/**
 * The ordered blocks of one turn: thinking, tool calls, shell output, diffs, todos, and reply text,
 * each in its own island or bubble, interleaved as they happened. `live` puts a caret on the last
 * text run for a streaming turn; a persisted turn passes false. TodoWrite is collapsed to one
 * evolving checklist (latest list at the first TodoWrite's spot). Rendered the same live or persisted,
 * so a reopened turn looks like it did while it streamed.
 */
export function TurnBlocks({ blocks, lang, live }: {
    blocks: readonly LiveBlock[];
    lang: Lang;
    live: boolean;
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
            {blocks.map((block, i) =>
                block.kind === 'text' ? (
                    block.text !== '' ? (
                        <div key={i} className="bg-card border-border max-w-[78%] rounded-lg border px-3 py-1.5 text-sm break-words">
                            <Markdown text={block.text} />
                            {live && i === lastTextIndex ? (
                                <span className="bg-muted-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] align-middle" />
                            ) : null}
                        </div>
                    ) : null
                ) : block.kind === 'thinking' ? (
                    block.text !== '' || block.seconds !== null
                        ? <ThinkingIsland key={i} text={block.text} seconds={block.seconds} lang={lang} />
                        : null
                ) : block.kind === 'tool' && block.todos !== undefined ? (
                    i === firstTodoIndex && currentTodos
                        ? <TodoList key="todos" todos={currentTodos} lang={lang} />
                        : null
                ) : block.edit ? (
                    <div key={i} className="w-full max-w-[78%]">
                        <DiffViewer files={[block.edit]} defaultOpen />
                    </div>
                ) : (
                    <ToolIsland key={i} block={block} lang={lang} />
                )
            )}
        </div>
    );
}
