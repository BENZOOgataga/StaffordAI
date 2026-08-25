import { useEffect, useRef, useState } from 'react';
import type { ChannelMessageRow, ActivityRow } from '../../shared/ipc.ts';

const LIMIT = 200;

export interface DetailData {
    readonly convRows: readonly ChannelMessageRow[];
    readonly actRows: readonly ActivityRow[];
    readonly loading: boolean;
    /**
     * The colleague's reply as it streams live this turn, or null when nothing is streaming. It is
     * shown in a provisional bubble and dropped the moment the persisted row lands, so the final,
     * stored message is what remains. Never persisted; it only changes how the in-flight reply looks.
     */
    readonly streaming: string | null;
}

/**
 * Loads a colleague's detail data and keeps it live. It reads the two sources the three
 * tabs share, the channel rows (messages and state events) and the activity rows (tool
 * actions), so one fetch feeds Conversation, Activity, and Transcript. It re-reads the
 * channel on a channel:changed signal, coalescing a burst into one read, and appends a
 * live activity row on activity:appended. Everything is keyed on the hire: changing the
 * selected colleague resets and refetches, and a stale in-flight read is dropped.
 *
 * Talks only to window.stafford, the frozen bridge. The submit path is untouched; this
 * only reads.
 */
export function useDetailData(hireId: string | null): DetailData {
    const [convRows, setConvRows] = useState<readonly ChannelMessageRow[]>([]);
    const [actRows, setActRows] = useState<readonly ActivityRow[]>([]);
    const [loading, setLoading] = useState<boolean>(hireId !== null);
    const [streaming, setStreaming] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        // A colleague switch starts with no in-flight stream; the previous one's is discarded.
        setStreaming(null);
        if (!hireId) {
            setConvRows([]);
            setActRows([]);
            setLoading(false);
            return;
        }
        let active = true;
        setLoading(true);

        const loadConversation = async (): Promise<void> => {
            const page = await window.stafford.channel.conversation(hireId, LIMIT);
            if (!active) return;
            setConvRows(page.rows);
            // The persisted rows now hold whatever just streamed, so drop the provisional bubble in
            // the same render, which avoids both a duplicate (bubble plus row) and a gap (neither).
            setStreaming(null);
        };
        const loadActivity = async (): Promise<void> => {
            const reply = await window.stafford.activity.byHire(hireId, LIMIT);
            if (active) setActRows(reply.rows);
        };

        void Promise.all([loadConversation(), loadActivity()]).finally(() => {
            if (active) setLoading(false);
        });

        // A channel:changed signal can arrive in a burst; coalesce into one re-read.
        const scheduleConversation = (): void => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => { void loadConversation(); }, 80);
        };
        const offChanged = window.stafford.channel.onChanged(scheduleConversation);
        const offActivity = window.stafford.activity.onAppended((row) => {
            if (row.hireId !== hireId) return;
            setActRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]));
        });
        // The live reply. Each push carries the whole text so far for one hire, so set it straight
        // rather than appending; a push for another colleague is ignored.
        const offStream = window.stafford.channel.onStreamDelta((delta) => {
            if (delta.hireId !== hireId) return;
            setStreaming(delta.text);
        });

        return () => {
            active = false;
            if (timer.current) clearTimeout(timer.current);
            offChanged();
            offActivity();
            offStream();
        };
    }, [hireId]);

    return { convRows, actRows, loading, streaming };
}
