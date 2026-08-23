/**
 * The board's data: every task across every colleague, the colleagues' names, and who is
 * paused on a permission ask.
 *
 * Three existing reads rather than one new aggregate. The task rows come from `tasks:board`,
 * the names from the roster snapshot the other screens already use, and the pending asks from
 * the approvals surface built in permission phase 2. Nothing here is a new source of truth.
 *
 * It re-reads on `tasks:changed` and on `approvals:changed`, which is what makes the board
 * answer "right now" rather than "when I opened it": a task moving to needs-you while I am
 * looking at another column appears without anything being clicked.
 */

import { useCallback, useEffect, useState } from 'react';
import type { TaskRow, TaskBoardReply, RosterSnapshot, PendingApprovals } from '../../shared/ipc.ts';

/** How many finished tasks the board carries. The unfinished ones are never capped. */
const CLOSED_LIMIT = 40;

export interface BoardState {
    readonly rows: readonly TaskRow[];
    readonly names: ReadonlyMap<string, string>;
    readonly awaiting: ReadonlySet<string>;
    readonly closedTruncated: boolean;
    /** Null before the first read lands, so the board can tell empty from not-yet-loaded. */
    readonly loaded: boolean;
    readonly error: string | null;
}

const EMPTY: BoardState = {
    rows: [], names: new Map(), awaiting: new Set(),
    closedTruncated: false, loaded: false, error: null
};

export function useBoard(): BoardState & { reload: () => void } {
    const [state, setState] = useState<BoardState>(EMPTY);

    const read = useCallback((): void => {
        void (async () => {
            try {
                const [board, roster, approvals] = await Promise.all([
                    window.stafford.tasks.board(CLOSED_LIMIT) as Promise<TaskBoardReply>,
                    window.stafford.roster.snapshot() as Promise<RosterSnapshot>,
                    window.stafford.approvals.pending() as Promise<PendingApprovals>
                ]);
                setState({
                    rows: board.rows,
                    names: new Map(roster.cards.map((c) => [c.id, c.name])),
                    awaiting: new Set(approvals.pending.map((a) => a.hireId)),
                    closedTruncated: board.closedTruncated,
                    loaded: true,
                    error: null
                });
            } catch (error) {
                // Kept visible. A board that silently shows nothing reads as "nothing needs
                // you", which is the most dangerous thing it could possibly say wrongly.
                setState((prev) => ({ ...prev, loaded: true, error: describe(error) }));
            }
        })();
    }, []);

    useEffect(() => {
        read();
        const offTasks = window.stafford.tasks.onChanged(() => { read(); });
        const offApprovals = window.stafford.approvals.onChanged(() => { read(); });
        return () => { offTasks(); offApprovals(); };
    }, [read]);

    return { ...state, reload: read };
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
