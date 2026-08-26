import * as React from 'react';
import { Brain, ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { buildThread } from './conversation-model.ts';
import { ConversationThread } from './conversation-thread.tsx';
import { Markdown } from './markdown.tsx';
import { CollapsibleLines } from './collapsible-lines.tsx';
import { DiffViewer } from '../tasks/diff-viewer.tsx';
import { FeedIconGlyph } from './feed-icon.tsx';
import { feedIcon, toolPhrase, toolStatusLabel, type FeedRow } from '../activity-view.ts';
import { type Lang } from '../channel-view.ts';
import { runSend } from './send-message.ts';
import type { ChannelMessageRow, LiveBlock } from '../../shared/ipc.ts';

/**
 * One tool call as a collapsed inset island: the Activity feed's own icon and phrase, plus its
 * status. A failure takes the status-error token so it reads as failed; a call still running shows
 * a soft pulse and resolves when its result lands. Collapsed one-liner only, no output body: the
 * command, the file contents, and the diff are later phases. It reuses feedIcon/toolPhrase/
 * toolStatusLabel so a colleague's actions read here exactly as they do in Activity, and an unknown
 * tool still renders a safe generic phrase rather than throwing.
 */
function ToolIsland({ block, lang }: { block: Extract<LiveBlock, { kind: 'tool' }>; lang: Lang }): React.JSX.Element {
    const isError = block.status === 'error';
    const isRunning = block.status === 'running';
    // A FeedRow shaped for the shared helpers. Only a real failure carries a status word; running
    // and ok stay quiet, exactly as the Activity feed treats them.
    const row: FeedRow = {
        kind: 'tool', id: block.id, at: '', tool: block.name, target: block.target,
        status: isError ? 'error' : 'ok', live: true
    };
    const statusLabel = isError ? toolStatusLabel('error', lang) : null;
    // A shell tool carries its output once the result lands (present, even if empty); a read or an
    // edit never does. So the presence of `output` is what turns the one-line island into a command
    // island with its stdout/stderr below, on failure included, where stderr is the useful part.
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
 * The colleague's reasoning for a turn, as a collapsed muted island above the reply. Collapsed by
 * default (reasoning is background, not the answer), a click expands it. The label reads "Thinking..."
 * while it streams and "Thought for Ns" once it finishes. The reasoning text accumulates live, so
 * expanding mid-thought shows what has arrived so far. The cryptographic signature is never part of
 * this text, it is dropped upstream. Uses the same click-to-expand idiom as the diff file row.
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

/**
 * The colleague's turn as it streams: reply text in the same left-aligned bordered bubble a settled
 * message uses, and each tool call as an inset island, interleaved in the order they happened. The
 * live text and the final message look identical, so there is no jump when the persisted bubble
 * replaces this. aria-hidden keeps the screen reader off the per-token updates; the persisted
 * message announces once. A soft caret on the last text run marks it as still arriving.
 */
function LiveTurn({ blocks, sender, lang }: {
    blocks: readonly LiveBlock[];
    sender: string;
    lang: Lang;
}): React.JSX.Element {
    // The caret belongs on the last text run, the thing actually typing; if the turn currently ends
    // on a tool call, no caret shows and the running island's pulse carries the liveness instead.
    let lastTextIndex = -1;
    blocks.forEach((b, i) => { if (b.kind === 'text' && b.text !== '') lastTextIndex = i; });
    return (
        <div className="flex flex-col items-start gap-1.5" aria-hidden="true">
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
                <span className="font-medium">{sender}</span>
            </div>
            {blocks.map((block, i) =>
                block.kind === 'text' ? (
                    block.text !== '' ? (
                        <div key={i} className="bg-card border-border max-w-[78%] rounded-lg border px-3 py-1.5 text-sm break-words">
                            <Markdown text={block.text} />
                            {i === lastTextIndex ? (
                                <span className="bg-muted-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] align-middle" />
                            ) : null}
                        </div>
                    ) : null
                ) : block.kind === 'thinking' ? (
                    // Thinking renders above the reply (it precedes output in the stream). It shows
                    // once it is streaming text or has finished (a duration): a finished think with
                    // redacted text still reads "Thought for Ns", which is worth showing. A block that
                    // has neither (omitted, or just opened) renders nothing.
                    block.text !== '' || block.seconds !== null
                        ? <ThinkingIsland key={i} text={block.text} seconds={block.seconds} lang={lang} />
                        : null
                ) : block.edit ? (
                    // A successful edit renders its actual change through the same viewer the task
                    // review uses, expanded in place. A failed or unparseable edit has no `edit` and
                    // falls to the one-line island below.
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

/**
 * The working words the indicator cycles through before any output arrives. Decorative, not literal
 * status from the stream: the stream gives no per-moment human status, so these fill the gap the way
 * the Claude apps' mumbling does. Kept generic and tasteful, and localized.
 */
const WORKING_WORDS: Record<Lang, readonly string[]> = {
    en: ['Working', 'Thinking', 'Planning', 'Working on it', 'Getting started'],
    fr: ['Au travail', 'Réflexion', 'Planification', 'En cours', 'Démarrage']
};

/** True when the OS asks for reduced motion, read once so the indicator can degrade to static. */
function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The gap filler: an immediate working affordance shown in the in-flight bubble before the first
 * token or tool event arrives, then replaced by the real streaming content. It cycles a few generic
 * working words with a soft animated dot, in Stafford's muted bordered bubble so it matches a
 * settled colleague message and there is no jump when output swaps in.
 *
 * Accessibility: the rotating word is aria-hidden, so the screen reader is not read a new word on
 * every tick; one polite "working" status is announced instead. Under reduced motion the word does
 * not rotate and the dot does not animate, it shows a single static "Working".
 */
function WorkingIndicator({ sender, lang }: { sender: string; lang: Lang }): React.JSX.Element {
    const words = WORKING_WORDS[lang];
    const reduced = React.useRef(prefersReducedMotion()).current;
    const [i, setI] = React.useState(0);
    React.useEffect(() => {
        if (reduced) return;
        const id = setInterval(() => setI((n) => (n + 1) % words.length), 1600);
        return () => clearInterval(id);
    }, [reduced, words.length]);
    const word = reduced ? (words[0] ?? 'Working') : (words[i] ?? words[0] ?? 'Working');
    return (
        <div className="flex flex-col items-start gap-1">
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs" aria-hidden="true">
                <span className="font-medium">{sender}</span>
            </div>
            <div className="bg-card border-border flex items-center gap-2 rounded-lg border px-3 py-1.5" aria-hidden="true">
                <span className="text-muted-foreground text-sm">{word}</span>
                {!reduced ? (
                    <span className="flex gap-0.5">
                        <span className="bg-muted-foreground/50 size-1 animate-pulse rounded-full [animation-delay:0ms]" />
                        <span className="bg-muted-foreground/50 size-1 animate-pulse rounded-full [animation-delay:200ms]" />
                        <span className="bg-muted-foreground/50 size-1 animate-pulse rounded-full [animation-delay:400ms]" />
                    </span>
                ) : null}
            </div>
            {/* One polite announcement, constant text so it is read once, not per rotated word. */}
            <span className="sr-only" role="status">{lang === 'fr' ? 'Au travail' : 'Working'}</span>
        </div>
    );
}

/**
 * The redesigned conversation: a grouped, two-sided thread with a pinned composer.
 * Consecutive messages from one sender share a single name and time; your messages sit
 * on the right in a filled surface, the colleague's on the left in a bordered one, so
 * the exchange reads as a conversation rather than a flat list. Compact rows keep more
 * of the thread on screen. State events render as centered system lines.
 *
 * The composer keeps the existing behaviour exactly: Enter sends, Shift-Enter adds a
 * line, and the send goes through window.stafford.channel.reply unchanged.
 */
export function ConversationPanel({ hireId, rows, nameOf, self, lang, streaming }: {
    hireId: string;
    rows: readonly ChannelMessageRow[];
    nameOf: (senderId: string) => string;
    self: string;
    lang: Lang;
    /**
     * The colleague's turn as it streams, its reply text and tool-call islands in order, or
     * null/empty when nothing is streaming. It renders provisionally below the thread and is dropped
     * when the persisted row lands. It is aria-hidden so the screen reader is not spammed as tokens
     * arrive; the final persisted message, in the live region, is what gets announced, once.
     */
    streaming?: readonly LiveBlock[] | null;
}): React.JSX.Element {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const stick = React.useRef(true);
    const [text, setText] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [sending, setSending] = React.useState(false);
    const now = Date.now();
    const items = buildThread(rows, nameOf, self, lang);
    // A turn is in flight while streaming is non-null. It has real content once a block carries text
    // or a tool call; before that (an empty opening snapshot) it shows the working indicator.
    const turnActive = streaming != null;
    const streamingBlocks = streaming && streaming.some((b) => b.kind === 'tool' || b.text !== '')
        ? streaming : null;

    const onScroll = (): void => {
        const el = scrollRef.current;
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    // Keep the newest message in view, but only when the reader is already at the bottom,
    // so scrolling up to read history is never yanked back down. `streaming` is a dep too, so the
    // view follows the reply as it types out, under the same at-the-bottom guard.
    React.useEffect(() => {
        const el = scrollRef.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [rows, streaming]);
    // A fresh colleague starts pinned to the bottom.
    React.useEffect(() => {
        stick.current = true;
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [hireId]);

    // Clear the input only after the send confirms. If it fails, the text stays and an
    // inline error shows below, so a failed send never silently eats what was typed.
    const send = async (): Promise<void> => {
        if (sending) return;
        setSending(true);
        setError(null);
        const decision = await runSend(text, (t) => window.stafford.channel.reply(hireId, t), lang);
        if (decision.cleared) setText('');
        setError(decision.error);
        setSending(false);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
                {items.length === 0 && !turnActive ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">No messages yet. Say hello below.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {items.length > 0 ? <ConversationThread items={items} now={now} lang={lang} /> : null}
                        {streamingBlocks
                            ? <LiveTurn blocks={streamingBlocks} sender={nameOf(hireId)} lang={lang} />
                            : turnActive
                                ? <WorkingIndicator sender={nameOf(hireId)} lang={lang} />
                                : null}
                    </div>
                )}
            </div>

            <div className="border-border flex flex-col gap-1 border-t px-4 py-3">
                <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                    }}
                    rows={2}
                    placeholder="Type a message. Enter sends, Shift-Enter adds a line."
                    className="max-h-40 resize-none"
                />
                {error ? (
                    <p role="alert" className="text-status-error text-xs">{error}</p>
                ) : (
                    <p className="text-muted-foreground text-xs">Enter sends. Shift-Enter adds a line.</p>
                )}
            </div>
        </div>
    );
}
