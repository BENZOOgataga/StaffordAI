import * as React from 'react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { buildThread } from './conversation-model.ts';
import { referenceLabel, type Lang } from '../channel-view.ts';
import { activityTime } from '../activity-view.ts';
import type { ChannelMessageRow } from '../../shared/ipc.ts';

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
export function ConversationPanel({ hireId, rows, nameOf, self, lang }: {
    hireId: string;
    rows: readonly ChannelMessageRow[];
    nameOf: (senderId: string) => string;
    self: string;
    lang: Lang;
}): React.JSX.Element {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const stick = React.useRef(true);
    const [text, setText] = React.useState('');
    const now = Date.now();
    const items = buildThread(rows, nameOf, self, lang);

    const onScroll = (): void => {
        const el = scrollRef.current;
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    // Keep the newest message in view, but only when the reader is already at the bottom,
    // so scrolling up to read history is never yanked back down.
    React.useEffect(() => {
        const el = scrollRef.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [rows]);
    // A fresh colleague starts pinned to the bottom.
    React.useEffect(() => {
        stick.current = true;
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [hireId]);

    const send = (): void => {
        if (text.trim().length === 0) return;
        const outgoing = text;
        setText('');
        void window.stafford.channel.reply(hireId, outgoing);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
                {items.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">No messages yet. Say hello below.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {items.map((item) =>
                            item.kind === 'event' ? (
                                <div key={item.id} className="flex justify-center py-0.5">
                                    <span className={cn('text-xs', item.waiting ? 'text-status-waiting' : 'text-muted-foreground')}>
                                        {item.text}
                                    </span>
                                </div>
                            ) : (
                                <div key={item.messages[0]?.id ?? item.at}
                                    className={cn('flex flex-col gap-1', item.side === 'you' ? 'items-end' : 'items-start')}>
                                    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
                                        <span className="font-medium">{item.sender}</span>
                                        <span className="tabular-nums">{activityTime(item.at, now, lang)}</span>
                                    </div>
                                    {item.messages.map((m) => (
                                        <div key={m.id}
                                            className={cn(
                                                'max-w-[78%] rounded-lg px-3 py-1.5 text-sm break-words whitespace-pre-wrap',
                                                item.side === 'you'
                                                    ? 'bg-secondary text-secondary-foreground'
                                                    : 'bg-card border border-border'
                                            )}>
                                            {m.body}
                                            {m.reference ? (
                                                <span className="text-muted-foreground mt-1 block text-xs">{referenceLabel(m.reference)}</span>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            )
                        )}
                    </div>
                )}
            </div>

            <div className="border-border flex flex-col gap-1 border-t px-4 py-3">
                <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                    }}
                    rows={2}
                    placeholder="Type a message. Enter sends, Shift-Enter adds a line."
                    className="max-h-40 resize-none"
                />
                <p className="text-muted-foreground text-xs">Enter sends. Shift-Enter adds a line.</p>
            </div>
        </div>
    );
}
