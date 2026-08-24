import * as React from 'react';
import { AppShell } from '@/components/app-shell';
import { ConversationThread } from '../detail/conversation-thread.tsx';
import { buildThread } from '../detail/conversation-model.ts';
import { type Lang } from '../channel-view.ts';
import { CHANNEL_SELF_SENDER, type RosterCard, type ChannelMessageRow } from '../../shared/ipc.ts';

/**
 * The Channel: one timeline across every colleague, in the island shell. It reuses the
 * redesigned conversation rendering, so the cross-colleague stream reads in the same
 * grouped, two-sided, compact register as a per-colleague thread. Because it spans many
 * colleagues, the per-group sender label is the attribution: each group names the
 * colleague it is from. An incoming group carries a quiet inline reply that targets that
 * colleague, the same reply path the vanilla Channel used.
 */
export function ChannelScreen({ rows, cards, lang, current, onNavigate, onLoadOlder }: {
    rows: readonly ChannelMessageRow[];
    cards: readonly RosterCard[];
    lang: Lang;
    current: string;
    onNavigate: (view: string) => void;
    onLoadOlder: () => Promise<number>;
}): React.JSX.Element {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const stick = React.useRef(true);
    // The scroll height captured just before an older page loads, so the reading
    // position can be held steady once the older rows prepend.
    const anchor = React.useRef<number | null>(null);
    const pending = React.useRef(false);
    const now = Date.now();

    const nameOf = React.useCallback((senderId: string): string => {
        if (senderId === CHANNEL_SELF_SENDER) return 'You';
        return cards.find((c) => c.id === senderId)?.name ?? senderId;
    }, [cards]);

    const items = buildThread(rows, nameOf, CHANNEL_SELF_SENDER, lang);

    const onScroll = (): void => {
        const el = scrollRef.current;
        if (!el) return;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (el.scrollTop < 60 && !pending.current) {
            pending.current = true;
            anchor.current = el.scrollHeight;
            void onLoadOlder().then((added) => {
                pending.current = false;
                if (added === 0) anchor.current = null;
            });
        }
    };

    // Hold the newest message in view when already at the bottom, and hold the reading
    // position steady when an older page prepends.
    React.useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (anchor.current != null) {
            el.scrollTop += el.scrollHeight - anchor.current;
            anchor.current = null;
        } else if (stick.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [rows]);

    return (
        <AppShell current={current} onNavigate={onNavigate}>
            <section
                data-slot="content-panel"
                aria-label="Channel timeline"
                className="bg-card text-card-foreground flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
            >
                <div className="border-border flex items-baseline gap-2 border-b px-5 py-3">
                    <span className="font-medium">Channel</span>
                    <span className="text-muted-foreground text-sm">Every colleague, one timeline</span>
                </div>
                <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
                    {items.length === 0 ? (
                        <p className="text-muted-foreground py-8 text-center text-sm">No messages yet.</p>
                    ) : (
                        <ConversationThread
                            items={items}
                            now={now}
                            lang={lang}
                            onReply={(target, text) => window.stafford.channel.reply(target, text)}
                        />
                    )}
                </div>
            </section>
        </AppShell>
    );
}
