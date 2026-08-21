import * as React from 'react';
import { cn } from '@/lib/utils';
import { FeedIconGlyph } from './feed-icon.tsx';
import { eventLabel, type Lang } from '../channel-view.ts';
import { feedIcon, toolPhrase, toolStatusLabel, activityTime, type FeedRow } from '../activity-view.ts';

/**
 * The Activity tab: the colleague's state events and tool actions as one quiet, ordered,
 * read-only feed. A small line icon per type, the localized phrase, a status word only on
 * a failure or interruption, and a de-emphasized time. Only a waiting state carries the
 * one accent the app spends.
 */
export function ActivityPanel({ feed, nameOf, lang }: {
    feed: readonly FeedRow[];
    nameOf: (senderId: string) => string;
    lang: Lang;
}): React.JSX.Element {
    const now = Date.now();
    if (feed.length === 0) {
        return <p className="text-muted-foreground py-8 text-center text-sm">No activity yet.</p>;
    }
    return (
        <div className="flex flex-col">
            {feed.map((row) => {
                const waiting = row.kind === 'state' && row.state === 'waiting_for_you';
                const line = row.kind === 'state'
                    ? eventLabel(row.state, nameOf(row.senderId), lang)
                    : toolPhrase(row.tool, row.target, lang);
                const status = row.kind === 'tool' ? toolStatusLabel(row.status, lang) : null;
                return (
                    <div key={row.id} className="flex items-baseline gap-3 px-1 py-1.5">
                        <FeedIconGlyph icon={feedIcon(row)}
                            className={cn('size-4 shrink-0 translate-y-0.5', waiting ? 'text-status-waiting' : 'text-muted-foreground')} />
                        <span className={cn('min-w-0 flex-1 text-sm break-words', waiting && 'text-status-waiting')}>
                            {line}
                            {status ? <span className="text-muted-foreground ml-2 text-xs">{status}</span> : null}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{activityTime(row.at, now, lang)}</span>
                    </div>
                );
            })}
        </div>
    );
}
