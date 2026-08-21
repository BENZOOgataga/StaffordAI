import * as React from 'react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { referenceLabel, type Lang } from '../channel-view.ts';
import { activityTime } from '../activity-view.ts';
import type { ThreadItem } from './conversation-model.ts';

/**
 * The shared grouped, two-sided message rendering, used by both the per-colleague
 * Conversation tab and the cross-colleague Channel timeline. Consecutive messages from
 * one sender share a single name and time; your messages sit right in a filled surface,
 * the others left in a bordered one; state events are centered system lines.
 *
 * When `onReply` is given, each incoming group gets a quiet inline reply, so the Channel
 * can reply to the colleague a message is from. The per-colleague Conversation omits it
 * and uses its own pinned composer instead.
 */

function InlineReply({ target, lang, onReply }: {
    target: string;
    lang: Lang;
    onReply: (target: string, text: string) => void;
}): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    const [text, setText] = React.useState('');
    const send = (): void => {
        if (text.trim().length === 0) return;
        onReply(target, text);
        setText('');
        setOpen(false);
    };
    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)}
                className="text-muted-foreground hover:text-foreground mt-0.5 px-1 text-xs transition-colors">
                Reply
            </button>
        );
    }
    return (
        <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                if (e.key === 'Escape') { setText(''); setOpen(false); }
            }}
            rows={2}
            placeholder={lang === 'fr' ? 'Répondre. Entrée envoie, Maj-Entrée ajoute une ligne.' : 'Reply. Enter sends, Shift-Enter adds a line.'}
            className="mt-1 max-w-md resize-none"
        />
    );
}

export function ConversationThread({ items, now, lang, onReply }: {
    items: readonly ThreadItem[];
    now: number;
    lang: Lang;
    onReply?: (target: string, text: string) => void;
}): React.JSX.Element {
    return (
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
                                    item.side === 'you' ? 'bg-secondary text-secondary-foreground' : 'bg-card border border-border'
                                )}>
                                {m.body}
                                {m.reference ? (
                                    <span className="text-muted-foreground mt-1 block text-xs">{referenceLabel(m.reference)}</span>
                                ) : null}
                            </div>
                        ))}
                        {onReply && item.side === 'them' ? (
                            <InlineReply target={item.senderId} lang={lang} onReply={onReply} />
                        ) : null}
                    </div>
                )
            )}
        </div>
    );
}
