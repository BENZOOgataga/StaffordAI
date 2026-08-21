import { useCallback, useEffect, useRef, useState } from 'react';
import { Timeline } from '../channel-view.ts';
import type { ChannelMessageRow } from '../../shared/ipc.ts';

const PAGE = 50;

export interface ChannelData {
    readonly rows: readonly ChannelMessageRow[];
    /** Loads the page before the oldest row, for scroll-back. Returns how many were added. */
    readonly loadOlder: () => Promise<number>;
}

/**
 * Loads the cross-colleague timeline and keeps it live. It reuses the pure Timeline,
 * the same read contract the vanilla Channel used: the newest page first, the tail
 * appended on a channel:changed signal, and older pages fetched on scroll-back, none
 * re-reading what it already holds. Talks only to window.stafford; read only.
 */
export function useChannel(): ChannelData {
    const timeline = useRef(new Timeline());
    const [rows, setRows] = useState<readonly ChannelMessageRow[]>([]);
    const loadingOlder = useRef(false);

    useEffect(() => {
        let active = true;
        const sync = (): void => { if (active) setRows([...timeline.current.rows]); };

        void (async () => {
            const page = await window.stafford.channel.page(null, PAGE);
            timeline.current.setInitial(page.rows);
            sync();
        })();

        const pullTail = async (): Promise<void> => {
            const cursor = timeline.current.newestCursor();
            if (!cursor) {
                const page = await window.stafford.channel.page(null, PAGE);
                timeline.current.setInitial(page.rows);
            } else {
                const page = await window.stafford.channel.since(cursor, PAGE);
                timeline.current.appendTail(page.rows);
            }
            sync();
        };
        const off = window.stafford.channel.onChanged(() => { void pullTail(); });

        return () => { active = false; off(); };
    }, []);

    const loadOlder = useCallback(async (): Promise<number> => {
        if (loadingOlder.current) return 0;
        const cursor = timeline.current.oldestCursor();
        if (!cursor) return 0;
        loadingOlder.current = true;
        try {
            const page = await window.stafford.channel.page(cursor, PAGE);
            const added = timeline.current.prependOlder(page.rows);
            if (added.length > 0) setRows([...timeline.current.rows]);
            return added.length;
        } finally {
            loadingOlder.current = false;
        }
    }, []);

    return { rows, loadOlder };
}
