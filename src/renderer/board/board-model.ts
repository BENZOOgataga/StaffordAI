/**
 * The board's shaping: tasks from every colleague, arranged by lifecycle state.
 *
 * **A view, not a model.** Everything here reads task rows the engine already writes and
 * decides how to arrange them. There is no board state, no board lifecycle and no board
 * write: a column is a filter over `state`, and the only thing a card can do is take me to
 * the review surface that already exists. That is deliberate, because the alternative,
 * dragging a card between columns, would be a second way to change a task's state, and the
 * one rule this whole feature rests on is that a task reaches done exactly one way.
 *
 * Pure, so the arrangement can be tested without a browser and without the store.
 */

import type { TaskRow } from '../../shared/ipc.ts';

/** The columns, which are the lifecycle states. No column is invented. */
export type ColumnId = 'needs-you' | 'working' | 'assigned' | 'done' | 'failed';

export interface BoardColumn {
    readonly id: ColumnId;
    readonly label: string;
    readonly cards: readonly BoardCard[];
    /** True for the column my eye should land on first. */
    readonly primary: boolean;
    /** Set when older cards were left out, so the column can say so rather than mislead. */
    readonly truncatedNote: string | null;
}

/** One task as a card: the task, plus what the board resolved about it. */
export interface BoardCard {
    readonly task: TaskRow;
    /** The colleague's name, or its id when the colleague is gone. */
    readonly hireName: string;
    /**
     * True when this task is waiting on me right now. A needs-you task always is; a working
     * task is too when its colleague is paused on a permission ask, because a turn stopped
     * mid-tool-call is waiting on my answer even though the lifecycle still calls it working.
     */
    readonly waiting: boolean;
}

export interface BoardCopy {
    readonly needsYou: string;
    readonly working: string;
    readonly assigned: string;
    readonly done: string;
    readonly failed: string;
    /** The quiet per-column indicator for a single empty column in a populated board. */
    readonly empty: string;
    readonly nothingWaiting: string;
    readonly older: string;
    readonly title: string;
    readonly subtitle: string;
    /** The whole-board empty state when the project has no colleagues at all. */
    readonly noColleaguesTitle: string;
    readonly noColleaguesBody: string;
    readonly hireAction: string;
    /** The whole-board empty state when there are colleagues but no tasks yet. */
    readonly noTasksTitle: string;
    readonly noTasksBody: string;
    readonly assignAction: string;
    /**
     * The headline. It breaks the two kinds of waiting apart rather than adding them, because
     * a single total sat above a "Waiting for you" column holding fewer cards reads as a
     * mistake: the difference is the tasks paused on a permission ask, which stay in the
     * working column because their turn is still live.
     */
    readonly waitingSummary: (review: number, paused: number) => string;
}

const EN: BoardCopy = {
    needsYou: 'Waiting for you', working: 'Working', assigned: 'Assigned',
    done: 'Approved', failed: 'Failed',
    empty: 'None', nothingWaiting: 'Nothing is waiting on you.',
    older: 'Older ones are not shown',
    title: 'Tasks', subtitle: 'Every colleague, by state.',
    noColleaguesTitle: 'No colleagues yet',
    noColleaguesBody: 'Hire a colleague, then you can give them tasks and track them here by state.',
    hireAction: 'Hire a colleague',
    noTasksTitle: 'No tasks yet',
    noTasksBody: 'Assign a task to a colleague and it shows up here, arranged by state.',
    assignAction: 'Assign a task',
    waitingSummary: (review, paused) => {
        const parts: string[] = [];
        if (review > 0) parts.push(review === 1 ? '1 waiting for review' : String(review) + ' waiting for review');
        if (paused > 0) parts.push(paused === 1 ? '1 paused for approval' : String(paused) + ' paused for approval');
        return parts.join(', ');
    }
};

const FR: BoardCopy = {
    needsYou: 'En attente de vous', working: 'En cours', assigned: 'Assignées',
    done: 'Approuvées', failed: 'Échouées',
    empty: 'Aucune', nothingWaiting: 'Rien ne vous attend.',
    older: 'Les plus anciennes ne sont pas affichées',
    title: 'Tâches', subtitle: 'Tous les collègues, par état.',
    noColleaguesTitle: "Aucun collègue pour l'instant",
    noColleaguesBody: 'Recrutez un collègue, puis confiez-lui des tâches à suivre ici par état.',
    hireAction: 'Recruter un collègue',
    noTasksTitle: "Aucune tâche pour l'instant",
    noTasksBody: 'Assignez une tâche à un collègue et elle apparaît ici, classée par état.',
    assignAction: 'Assigner une tâche',
    waitingSummary: (review, paused) => {
        const parts: string[] = [];
        if (review > 0) parts.push(review === 1 ? '1 en attente de revue' : String(review) + ' en attente de revue');
        if (paused > 0) parts.push(paused === 1 ? '1 en pause pour approbation' : String(paused) + ' en pause pour approbation');
        return parts.join(', ');
    }
};

export function boardCopy(lang: 'en' | 'fr'): BoardCopy {
    return lang === 'fr' ? FR : EN;
}

/**
 * The column order, which is a reading order and not the lifecycle order.
 *
 * Waiting first, because the board exists to answer "what needs me". Then the things in
 * flight, then the ones not started, then the archive. Ordering these by where a task is in
 * its life would put assigned first and bury the only column I have to act on.
 */
export const COLUMN_ORDER: readonly ColumnId[] = ['needs-you', 'working', 'assigned', 'done', 'failed'];

/** Which column a task falls in. The state, directly: a column is a filter, not a category. */
export function columnOf(task: TaskRow): ColumnId | null {
    switch (task.state) {
        case 'needs-you': return 'needs-you';
        case 'working': return 'working';
        case 'assigned': return 'assigned';
        case 'done': return 'done';
        case 'failed': return 'failed';
        default: return null;
    }
}

export interface BoardInput {
    readonly rows: readonly TaskRow[];
    /** Colleague names by id, for the card. A missing one falls back to the id. */
    readonly names: ReadonlyMap<string, string>;
    /** Hire ids with a permission ask pending, so a paused task reads as waiting. */
    readonly awaiting: ReadonlySet<string>;
    readonly closedTruncated: boolean;
    readonly copy: BoardCopy;
}

/**
 * The board.
 *
 * Every column is returned even when empty, unlike the per-colleague list which drops empties.
 * A board with a missing column would read as though that state does not exist, and an empty
 * "waiting for you" is itself the answer I came for.
 */
export function buildBoard(input: BoardInput): BoardColumn[] {
    const label: Record<ColumnId, string> = {
        'needs-you': input.copy.needsYou, working: input.copy.working,
        assigned: input.copy.assigned, done: input.copy.done, failed: input.copy.failed
    };

    const cards = new Map<ColumnId, BoardCard[]>();
    for (const id of COLUMN_ORDER) cards.set(id, []);

    for (const task of input.rows) {
        const id = columnOf(task);
        if (!id) continue;
        cards.get(id)?.push({
            task,
            hireName: input.names.get(task.hireId) ?? task.hireId,
            waiting: isWaiting(task, input.awaiting)
        });
    }

    return COLUMN_ORDER.map((id) => ({
        id,
        label: label[id],
        cards: cards.get(id) ?? [],
        primary: id === 'needs-you',
        truncatedNote: input.closedTruncated && (id === 'done' || id === 'failed')
            ? input.copy.older
            : null
    }));
}

/**
 * Whether a task is waiting on me right now.
 *
 * Two different situations that mean the same thing to me: it finished an attempt and needs
 * a decision, or it stopped mid-turn on a permission ask and needs an answer. The board's job
 * is to make sure neither is hidden, so it counts both, while the lifecycle keeps calling the
 * second one working because its turn is still live.
 */
export function isWaiting(task: TaskRow, awaiting: ReadonlySet<string>): boolean {
    if (task.state === 'needs-you') return true;
    return task.state === 'working' && awaiting.has(task.hireId);
}

/**
 * What is waiting on me, across everyone, split by which kind.
 *
 * `review` is the needs-you column, and `paused` is the tasks stopped mid-turn on a permission
 * ask, which sit in the working column because their turn is still live. Both need me; they
 * need different things, and the headline says so rather than adding them into one number
 * that would not match any column.
 */
export function waitingCounts(
    rows: readonly TaskRow[], awaiting: ReadonlySet<string>
): { review: number; paused: number; total: number } {
    const review = rows.filter((t) => t.state === 'needs-you').length;
    const paused = rows.filter((t) => t.state === 'working' && awaiting.has(t.hireId)).length;
    return { review, paused, total: review + paused };
}

/** The instruction's first line, bounded, for a card. Never the whole prompt. */
export function cardTitle(task: TaskRow): string {
    const line = (task.text.split('\n')[0] ?? '').trim() || task.text.trim();
    return line.length > 120 ? line.slice(0, 120) + '...' : line;
}

/**
 * The quiet second line on a card: the attempt history, and what came of the last run.
 *
 * Null when there is nothing worth saying, so a first-attempt card stays one line and the
 * ones that have been round again stand out by having something to read.
 */
export function cardNote(task: TaskRow): string | null {
    const parts: string[] = [];
    if (task.sendBacks.length > 0) {
        parts.push(task.sendBacks.length === 1 ? 'sent back once' : 'sent back ' + String(task.sendBacks.length) + ' times');
    }
    if (task.state === 'failed' && task.failedReason) parts.push(task.failedReason);
    else if (task.resultBranch) parts.push(task.resultBranch);
    return parts.length > 0 ? parts.join(' | ') : null;
}
