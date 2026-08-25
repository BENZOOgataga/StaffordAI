import { useEffect, useRef, useState } from 'react';
import type { ChannelMessageRow, ActivityRow, LiveBlock } from '../../shared/ipc.ts';

const LIMIT = 200;

/** A block carries real output: a tool call, or text that is not empty. An empty text run does not. */
function hasLiveContent(block: LiveBlock): boolean {
    return block.kind === 'tool' || block.text !== '';
}

export interface DetailData {
    readonly convRows: readonly ChannelMessageRow[];
    readonly actRows: readonly ActivityRow[];
    readonly loading: boolean;
    /**
     * The colleague's turn as it streams live, its reply text and tool-call islands in order, or
     * null when nothing is streaming. Shown provisionally and dropped the moment the persisted row
     * lands, so the final, stored message is what remains. Never persisted; it only changes how the
     * in-flight turn looks.
     */
    readonly streaming: readonly LiveBlock[] | null;
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
    const [streaming, setStreaming] = useState<readonly LiveBlock[] | null>(null);
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
        // The live turn. Each push carries the whole turn so far for one hire as ordered blocks, so
        // set it straight rather than appending; a push for another colleague is ignored. An empty
        // snapshot means the turn started but has not produced output yet, which the tab shows as a
        // working indicator. The final push carries `done`: it clears an indicator that never got
        // output, but leaves real content in place so the persisted row replaces it without a gap.
        const offStream = window.stafford.channel.onStreamDelta((delta) => {
            if (delta.hireId !== hireId) return;
            if (delta.done) {
                setStreaming((prev) => (prev && prev.some(hasLiveContent) ? prev : null));
                return;
            }
            setStreaming(delta.blocks);
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
