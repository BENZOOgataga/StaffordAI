import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { buildThread } from './conversation-model.ts';
import { ConversationThread } from './conversation-thread.tsx';
import { Markdown } from './markdown.tsx';
import { type Lang } from '../channel-view.ts';
import { runSend } from './send-message.ts';
import type { ChannelMessageRow } from '../../shared/ipc.ts';

/**
 * The colleague's reply as it streams, in the same left-aligned bordered bubble a persisted
 * colleague message uses, so the live text and the final message look identical and there is no
 * jump when one replaces the other. aria-hidden keeps the screen reader off the per-token updates;
 * the persisted message announces once. A soft caret marks it as still arriving.
 */
function StreamingBubble({ sender, text }: { sender: string; text: string }): React.JSX.Element {
    return (
        <div className="flex flex-col items-start gap-1" aria-hidden="true">
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
                <span className="font-medium">{sender}</span>
            </div>
            <div className="bg-card border-border max-w-[78%] rounded-lg border px-3 py-1.5 text-sm break-words">
                {/* Same markdown renderer as a settled reply, so the text formats live as it streams
                    and there is no reformat when the persisted bubble replaces this one. */}
                <Markdown text={text} />
                <span className="bg-muted-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] align-middle" />
            </div>
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
     * The colleague's reply as it streams this turn, or null/empty when nothing is streaming. It
     * renders in a provisional bubble below the thread and is dropped when the persisted row lands.
     * The bubble is aria-hidden so the screen reader is not spammed a token at a time; the final
     * persisted message, in the live region, is what gets announced, once.
     */
    streaming?: string | null;
}): React.JSX.Element {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const stick = React.useRef(true);
    const [text, setText] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [sending, setSending] = React.useState(false);
    const now = Date.now();
    const items = buildThread(rows, nameOf, self, lang);
    const streamingText = streaming && streaming.trim() !== '' ? streaming : null;

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
                {items.length === 0 && !streamingText ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">No messages yet. Say hello below.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {items.length > 0 ? <ConversationThread items={items} now={now} lang={lang} /> : null}
                        {streamingText ? <StreamingBubble sender={nameOf(hireId)} text={streamingText} /> : null}
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
