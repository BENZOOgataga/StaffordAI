import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { buildThread } from './conversation-model.ts';
import { ConversationThread } from './conversation-thread.tsx';
import { TurnBlocks } from './turn-blocks.tsx';
import { usePendingQuestions, PendingQuestionsContext } from './use-questions.ts';
import { type Lang } from '../channel-view.ts';
import { runSend } from './send-message.ts';
import type { ChannelMessageRow, LiveBlock } from '../../shared/ipc.ts';

/**
 * The colleague's turn as it streams: the same block rendering a settled turn uses, wrapped so it is
 * aria-hidden (the screen reader is not read the per-token updates; the persisted message announces
 * once) and marked live (a caret on the last text run). When the turn ends, the persisted turn renders
 * the identical blocks, so there is no jump.
 */
function LiveTurn({ blocks, sender, lang, interactive }: {
    blocks: readonly LiveBlock[];
    sender: string;
    lang: Lang;
    /**
     * True when the turn holds a pending question the person can answer. The streaming turn is normally
     * aria-hidden so the screen reader is not read every token; a pending ask carries an interactive
     * form, so the turn is made reachable then, and hidden again once nothing is waiting.
     */
    interactive: boolean;
}): React.JSX.Element {
    return (
        <div className="flex flex-col items-start gap-1.5" aria-hidden={interactive ? undefined : true}>
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
                <span className="font-medium">{sender}</span>
            </div>
            <TurnBlocks blocks={blocks} lang={lang} live />
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
export function ConversationPanel({ hireId, rows, nameOf, self, lang, streaming, turnEvents }: {
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
    /** The persisted rich blocks per message id, so past turns re-render their full rich content. */
    turnEvents?: Readonly<Record<string, readonly LiveBlock[]>>;
}): React.JSX.Element {
    const richFor = React.useCallback(
        (messageId: string): readonly LiveBlock[] | null => turnEvents?.[messageId] ?? null,
        [turnEvents]
    );
    // The AskUserQuestion prompts waiting on the person, narrowed to this colleague, so a live ask
    // renders its answer form and the streaming turn is made reachable while one is pending.
    const allPending = usePendingQuestions();
    const pendingForHire = React.useMemo(() => allPending.filter((q) => q.hireId === hireId), [allPending, hireId]);
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
        <PendingQuestionsContext.Provider value={pendingForHire}>
        <div className="flex min-h-0 flex-1 flex-col">
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
                {items.length === 0 && !turnActive ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">No messages yet. Say hello below.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {items.length > 0 ? <ConversationThread items={items} now={now} lang={lang} richFor={richFor} /> : null}
                        {streamingBlocks
                            ? <LiveTurn blocks={streamingBlocks} sender={nameOf(hireId)} lang={lang} interactive={pendingForHire.length > 0} />
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
        </PendingQuestionsContext.Provider>
    );
}
