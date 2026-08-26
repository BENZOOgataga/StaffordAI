import { useEffect, useRef, useState } from 'react';
import { afterPersistedRows, afterDone } from './live-stream.ts';
import type { ChannelMessageRow, ActivityRow, LiveBlock } from '../../shared/ipc.ts';

const LIMIT = 200;

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
    /**
     * The persisted rich blocks for the colleague's past turns, keyed by message id, so a reopened
     * conversation re-renders their thinking, tools, diffs, and todos. A message with no entry renders
     * its plain text, which is the pre-feature case and the fallback for a turn that did not persist.
     */
    readonly turnEvents: Readonly<Record<string, readonly LiveBlock[]>>;
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
    const [turnEvents, setTurnEvents] = useState<Readonly<Record<string, readonly LiveBlock[]>>>({});
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        // A colleague switch starts with no in-flight stream; the previous one's is discarded.
        setStreaming(null);
        setTurnEvents({});
        if (!hireId) {
            setConvRows([]);
            setActRows([]);
            setLoading(false);
            return;
        }
        let active = true;
        setLoading(true);

        const loadConversation = async (): Promise<void> => {
            // The messages and their persisted rich turns are read together, so a message and its
            // blocks land in the same render: the reopen shows the full rich turn with no flash of
            // plain text first, and a finished live turn hands off to the persisted blocks cleanly.
            const [page, rich] = await Promise.all([
                window.stafford.channel.conversation(hireId, LIMIT),
                window.stafford.channel.turnEvents(hireId)
            ]);
            if (!active) return;
            setConvRows(page.rows);
            setTurnEvents(rich.byMessage);
            // Drop a provisional content bubble now that its persisted row covers it, but keep a bare
            // working indicator: the person's own message triggers this re-read during the gap before
            // the colleague replies, and clearing here is what blanked the indicator mid-gap.
            setStreaming(afterPersistedRows);
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
                setStreaming(afterDone);
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

    return { convRows, actRows, loading, streaming, turnEvents };
}
