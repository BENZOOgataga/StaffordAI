import * as React from 'react';
import { cn } from '@/lib/utils';
import { FeedIconGlyph } from './feed-icon.tsx';
import { type Lang } from '../channel-view.ts';
import { feedIcon, toolPhrase, toolStatusLabel, activityTime } from '../activity-view.ts';
import type { TranscriptItem } from './feed-model.ts';

/**
 * The Transcript tab: the colleague's own replies interleaved with the tool calls it
 * made, in time order. Text turns render as plain blocks; tool turns render as the same
 * quiet icon-and-phrase row the Activity feed uses. This is the colleague's turn view,
 * not the two-sided exchange.
 */
export function TranscriptPanel({ items, lang }: {
    items: readonly TranscriptItem[];
    lang: Lang;
}): React.JSX.Element {
    const now = Date.now();
    if (items.length === 0) {
        return <p className="text-muted-foreground py-8 text-center text-sm">No transcript yet.</p>;
    }
    return (
        <div className="flex flex-col gap-1">
            {items.map((item) =>
                item.kind === 'text' ? (
                    <p key={item.id} className="px-1 py-1 text-sm break-words whitespace-pre-wrap">{item.body}</p>
                ) : (
                    <div key={item.id} className="flex items-baseline gap-3 px-1 py-1">
                        <FeedIconGlyph icon={feedIcon(item.row)}
                            className={cn('text-muted-foreground size-4 shrink-0 translate-y-0.5',
                                item.row.kind === 'tool' && item.row.status === 'error' && 'text-status-error')} />
                        <span className="text-muted-foreground min-w-0 flex-1 text-sm break-words">
                            {item.row.kind === 'tool' ? toolPhrase(item.row.tool, item.row.target, lang) : ''}
                            {item.row.kind === 'tool' && toolStatusLabel(item.row.status, lang)
                                ? <span className="ml-2 text-xs">{toolStatusLabel(item.row.status, lang)}</span>
                                : null}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{activityTime(item.at, now, lang)}</span>
                    </div>
                )
            )}
        </div>
    );
}
