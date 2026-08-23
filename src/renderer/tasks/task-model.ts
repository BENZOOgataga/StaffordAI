/**
 * The task surface's shaping, kept out of the components so it can be tested without a
 * browser, the same split the roster and the permission views use.
 *
 * What lives here is every decision the panel makes about what a task looks like: which
 * group it falls in, what its state reads as in words, whether its controls are live, and
 * how a result is described. What does not live here is any decision about what a task is
 * allowed to do, which belongs to the lifecycle in the main process and is not something a
 * renderer gets an opinion on.
 */

import type { TaskRow, TaskDiffFile } from '../../shared/ipc.ts';

/** The three sections a task list reads as. Waiting first, because it is the one that needs me. */
export type TaskGroupId = 'needs-you' | 'active' | 'closed';

export interface TaskGroup {
    readonly id: TaskGroupId;
    readonly label: string;
    readonly tasks: readonly TaskRow[];
}

export interface TaskCopy {
    readonly needsYou: string;
    readonly active: string;
    readonly closed: string;
    readonly assigned: string;
    readonly working: string;
    readonly done: string;
    readonly failed: string;
    readonly waitingApproval: string;
    readonly approve: string;
    readonly fail: string;
    readonly sendBack: string;
    readonly notePlaceholder: string;
    readonly sendBackHistory: string;
    readonly onlyYouClose: string;
}

const EN: TaskCopy = {
    needsYou: 'Waiting for you', active: 'In progress', closed: 'Finished',
    assigned: 'Assigned, not started', working: 'Working', done: 'Approved',
    failed: 'Failed', waitingApproval: 'Paused, needs your approval',
    approve: 'Approve', fail: 'Fail', sendBack: 'Send back',
    notePlaceholder: 'What should change? Required to send back, optional otherwise.',
    sendBackHistory: 'What I sent back', onlyYouClose: 'Approving closes the task. Only you can.'
};

const FR: TaskCopy = {
    needsYou: 'En attente de vous', active: 'En cours', closed: 'Terminées',
    assigned: 'Assignée, pas démarrée', working: 'En cours', done: 'Approuvée',
    failed: 'Échouée', waitingApproval: 'En pause, votre approbation est requise',
    approve: 'Approuver', fail: 'Rejeter', sendBack: 'Renvoyer',
    notePlaceholder: 'Que faut-il changer ? Obligatoire pour renvoyer, sinon facultatif.',
    sendBackHistory: 'Ce que j\'ai renvoyé', onlyYouClose: 'Approuver clôt la tâche. Vous seul le pouvez.'
};

export function taskCopy(lang: 'en' | 'fr'): TaskCopy {
    return lang === 'fr' ? FR : EN;
}

/** Which section a task belongs in. */
export function groupOf(task: TaskRow): TaskGroupId {
    if (task.state === 'needs-you') return 'needs-you';
    if (task.state === 'done' || task.state === 'failed') return 'closed';
    return 'active';
}

/**
 * The list, grouped, with empty groups dropped.
 *
 * Waiting first and finished last, because the ordering is about what I have to do rather
 * than about when things happened. Within a group the newest is first, which is the order the
 * read already returns them in and is preserved rather than re-sorted.
 */
export function buildTaskGroups(tasks: readonly TaskRow[], copy: TaskCopy): TaskGroup[] {
    const order: readonly TaskGroupId[] = ['needs-you', 'active', 'closed'];
    const label: Record<TaskGroupId, string> = {
        'needs-you': copy.needsYou, active: copy.active, closed: copy.closed
    };
    return order
        .map((id) => ({ id, label: label[id], tasks: tasks.filter((t) => groupOf(t) === id) }))
        .filter((group) => group.tasks.length > 0);
}

/**
 * The state in words.
 *
 * `awaitingApproval` is not a task state and deliberately is not one: a task paused on a
 * permission ask is still working, because its turn is live and will resume the moment I
 * answer. It reads differently here because what I have to do about it is different, which
 * is a presentation concern and not a lifecycle one.
 */
export function stateText(task: TaskRow, copy: TaskCopy, awaitingApproval = false): string {
    if (awaitingApproval && task.state === 'working') return copy.waitingApproval;
    switch (task.state) {
        case 'assigned': return copy.assigned;
        case 'working': return copy.working;
        case 'needs-you': return copy.needsYou;
        case 'done': return copy.done;
        case 'failed': return copy.failed;
        default: return task.state;
    }
}

/** True when a task is finished either way, so its controls are gone rather than disabled. */
export function isClosed(task: TaskRow): boolean {
    return task.state === 'done' || task.state === 'failed';
}

/** True when a task is mine to decide on now. Only needs-you has review controls. */
export function isReviewable(task: TaskRow): boolean {
    return task.state === 'needs-you';
}

/** True when a task has been assigned but nothing has run yet, so it can be started. */
export function isStartable(task: TaskRow): boolean {
    return task.state === 'assigned';
}

/**
 * What the result amounts to, in one line, for a review that has not been opened yet.
 *
 * It distinguishes "committed nothing" from "not run yet", because those look the same in a
 * list that only shows a branch name and they mean opposite things.
 */
export function resultLine(task: TaskRow, files: readonly TaskDiffFile[] | null): string {
    if (task.state === 'assigned') return 'Not started';
    if (task.resultBranch === null) {
        return isClosed(task) || task.state === 'needs-you' ? 'No file changes' : 'Running';
    }
    if (files === null) return task.resultBranch;
    if (files.length === 0) return task.resultBranch;
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const count = files.length === 1 ? '1 file' : String(files.length) + ' files';
    return count + ', +' + String(added) + ' / -' + String(removed);
}

/**
 * How an attempt reads in one line, or null on a first attempt.
 *
 * Only shown once a task has been round more than once, because "attempt 1" on every task
 * would be noise on the common case and says nothing.
 */
export function attemptLine(task: TaskRow): string | null {
    if (task.attempts <= 1) return null;
    const sent = task.sendBacks.length;
    if (sent === 0) return 'Attempt ' + String(task.attempts);
    return 'Attempt ' + String(task.attempts) + ', sent back ' +
        (sent === 1 ? 'once' : String(sent) + ' times');
}

/** A short commit id for display. The full one is on the branch. */
export function shortCommit(commit: string | null): string | null {
    return commit === null ? null : commit.slice(0, 8);
}

/**
 * The refusals, split into lines.
 *
 * Stored as one joined string because that is what the service records, and split here rather
 * than at the source so the wire stays one nullable field. Each line is one file and why it
 * was left out, which is the whole reason a refusal is recorded at all.
 */
export function refusalLines(refused: string | null): string[] {
    if (refused === null || refused.trim() === '') return [];
    return refused.split(';').map((s) => s.trim()).filter((s) => s !== '');
}

/** The new files that actually made it, given what was declared and what was refused. */
export function deliveredOutputs(task: TaskRow): string[] {
    const refusedText = task.refusedOutputs ?? '';
    return task.declaredOutputs.filter((name) => !refusedText.includes(name));
}
