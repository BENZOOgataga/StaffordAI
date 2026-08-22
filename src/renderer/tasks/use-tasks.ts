/**
 * The task panel's data: one colleague's tasks, and one task's result diff.
 *
 * It re-reads on `tasks:changed`, which main sends after every lifecycle write. That is the
 * signal that makes an unattended task watchable: a task started from here moves to working
 * and then to needs-you without anything being clicked, because the engine writes and the
 * screen follows.
 *
 * It talks only to `window.stafford`, the frozen bridge, like every other view.
 */

import { useCallback, useEffect, useState } from 'react';
import type { TaskRow, TasksReply, TaskWriteReply, TaskDiffFile, TaskDiffReply } from '../../shared/ipc.ts';

/** How many of a colleague's tasks the panel reads. Recent work, not an archive. */
const TASK_PAGE = 50;

export interface TasksState {
    readonly tasks: readonly TaskRow[];
    /** Null before the first read lands, so the panel can tell empty from not-yet-loaded. */
    readonly loaded: boolean;
    readonly error: string | null;
}

const EMPTY: TasksState = { tasks: [], loaded: false, error: null };

export function useTasks(hireId: string | null): TasksState & { reload: () => void } {
    const [state, setState] = useState<TasksState>(EMPTY);

    const read = useCallback((): void => {
        if (!hireId) { setState({ ...EMPTY, loaded: true }); return; }
        void (async () => {
            try {
                const reply = await window.stafford.tasks.byHire(hireId, TASK_PAGE) as TasksReply;
                setState({ tasks: reply.rows, loaded: true, error: null });
            } catch (error) {
                // Kept visible. A task list that silently shows nothing reads as "no tasks",
                // and the one thing I must not miss is a task waiting for me.
                setState((prev) => ({ ...prev, loaded: true, error: describe(error) }));
            }
        })();
    }, [hireId]);

    useEffect(() => {
        read();
        return window.stafford.tasks.onChanged(() => { read(); });
    }, [read]);

    return { ...state, reload: read };
}

export interface DiffState {
    readonly files: readonly TaskDiffFile[];
    readonly loaded: boolean;
    readonly error: string | null;
}

/**
 * The changed files on one task's result branch.
 *
 * Keyed on the commit as well as the id, so a task that is sent back and run again re-reads
 * rather than showing the previous attempt's diff under the new attempt's heading.
 */
export function useTaskDiff(taskId: string | null, commit: string | null): DiffState {
    const [state, setState] = useState<DiffState>({ files: [], loaded: false, error: null });

    useEffect(() => {
        if (!taskId || !commit) { setState({ files: [], loaded: true, error: null }); return; }
        let live = true;
        void (async () => {
            try {
                const reply = await window.stafford.tasks.diff(taskId) as TaskDiffReply;
                if (live) setState({ files: reply.files, loaded: true, error: reply.error });
            } catch (error) {
                if (live) setState({ files: [], loaded: true, error: describe(error) });
            }
        })();
        return () => { live = false; };
    }, [taskId, commit]);

    return state;
}

/**
 * The three writes, as plain calls that hand back what main decided.
 *
 * They are thin on purpose. A refused transition comes back as `refused` rather than a throw,
 * because "you cannot approve a task that is already closed" is an answer worth showing, and
 * the panel shows it rather than swallowing it.
 */
export async function assignTask(hireId: string, text: string): Promise<TaskWriteReply> {
    return window.stafford.tasks.assign(hireId, text) as Promise<TaskWriteReply>;
}

export async function startTask(id: string): Promise<TaskWriteReply> {
    return window.stafford.tasks.start(id) as Promise<TaskWriteReply>;
}

export async function reviewTask(
    id: string, decision: 'approve' | 'fail' | 'send-back', note: string | null
): Promise<TaskWriteReply> {
    return window.stafford.tasks.review(id, decision, note) as Promise<TaskWriteReply>;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
