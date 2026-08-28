/**
 * Preload. Exposes exactly one frozen object through `contextBridge`.
 *
 * `ipcRenderer` never reaches the renderer. The renderer gets named methods
 * that wrap `ipcRenderer.invoke` and `on`, and the channel names come from the
 * shared allowlist rather than from the caller, so a renderer cannot reach a
 * channel main did not intend. Any name off the allowlist is refused here, in
 * the trusted context, before it can reach `ipcRenderer` at all.
 *
 * Section 6 of `docs/plans/stack-migration.technical.md` is the specification.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
    isInvokeChannel, isEventChannel, isWindowInvokeChannel, isWindowEventChannel,
    type InvokeChannel, type EventChannel, type WindowInvokeChannel, type WindowEventChannel,
    type HealthReport, type ProjectsList, type RosterSnapshot,
    type ChannelCursor, type ChannelPageReply, type ProjectCreated, type HireCreated,
    type ProjectsManageReply, type ProjectWriteReply, type FireReply,
    type ActivityByHireReply, type ActivityRow, type SavedCheckpoints, type PendingApprovals,
    type PendingQuestions, type AskAnswer,
    type PermissionRulesReply, type PermissionEffectiveReply, type PermissionWriteReply,
    type PermissionAdd, type PermissionUpdate,
    type TasksReply, type TaskWriteReply, type TaskDiffReply, type TaskBoardReply,
    type ConversationStreamDelta, type TurnEventsReply
} from '../shared/ipc.ts';

function invoke(channel: InvokeChannel, payload?: unknown): Promise<unknown> {
    // Belt and braces: the type says InvokeChannel, but the renderer is
    // untrusted and TypeScript is gone at runtime, so the name is checked
    // against the allowlist here rather than assumed.
    if (!isInvokeChannel(channel)) {
        return Promise.reject(new Error('refused: ' + String(channel) + ' is not an allowed channel'));
    }
    return ipcRenderer.invoke(channel, payload);
}

function on(channel: EventChannel, listener: (payload: unknown) => void): () => void {
    if (!isEventChannel(channel)) {
        throw new Error('refused: ' + String(channel) + ' is not an allowed event channel');
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => { ipcRenderer.removeListener(channel, wrapped); };
}

/** The window-control channels have their own allowlist, checked the same way. */
function winInvoke(channel: WindowInvokeChannel): Promise<unknown> {
    if (!isWindowInvokeChannel(channel)) {
        return Promise.reject(new Error('refused: ' + String(channel) + ' is not an allowed window channel'));
    }
    return ipcRenderer.invoke(channel);
}

function winOn(channel: WindowEventChannel, listener: (payload: unknown) => void): () => void {
    if (!isWindowEventChannel(channel)) {
        throw new Error('refused: ' + String(channel) + ' is not an allowed window event channel');
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => { ipcRenderer.removeListener(channel, wrapped); };
}

// The main process passes --stafford-frameless as a launch argument for a frameless
// window, so the renderer knows synchronously at load whether to draw the custom title
// bar, without an extra IPC round-trip.
const FRAMELESS = process.argv.includes('--stafford-frameless');
// Only a dev build passes --stafford-dev (see index.ts). It gates the dev trigger surface, so a
// packaged build never exposes `dev` and there is nothing for the hidden panel to call.
const DEV = process.argv.includes('--stafford-dev');

/**
 * The one object the renderer sees. Frozen, so the renderer cannot rewrite a
 * method to reach a channel it should not. Method names, not raw channels, so
 * the surface is exactly what is written here.
 */
const api = Object.freeze({
    health: (): Promise<HealthReport> => invoke('health') as Promise<HealthReport>,

    // Projects. list is read-only; create validates the repo path is a real
    // directory in main and returns an id and name, never a path back.
    projects: Object.freeze({
        list: (): Promise<ProjectsList> => invoke('projects:list') as Promise<ProjectsList>,
        create: (name: string, repoPaths: readonly string[]): Promise<ProjectCreated> =>
            invoke('project:create', { name, repoPaths }) as Promise<ProjectCreated>,
        // Opens the native folder picker for the create form. Returns the chosen directory or null.
        pickFolder: (): Promise<string | null> => invoke('dialog:pick-folder') as Promise<string | null>,
        // The Projects management tab: read every project with its colleagues (folders included, for
        // Benzoo's own UI), edit a project's name and folder, delete it (parking its colleagues), and
        // rebind a parked colleague to a project as a fresh session. onChanged re-reads on a change.
        manageView: (): Promise<ProjectsManageReply> => invoke('projects:manage-view') as Promise<ProjectsManageReply>,
        update: (id: string, name: string, repoPaths: readonly string[]): Promise<ProjectWriteReply> =>
            invoke('project:update', { id, name, repoPaths }) as Promise<ProjectWriteReply>,
        remove: (id: string): Promise<ProjectWriteReply> =>
            invoke('project:delete', { id }) as Promise<ProjectWriteReply>,
        rebind: (hireId: string, projectId: string): Promise<ProjectWriteReply> =>
            invoke('colleague:rebind', { hireId, projectId }) as Promise<ProjectWriteReply>,
        // Remove a colleague from the roster. Archive: its session is stopped and it leaves the roster,
        // while its conversation, tasks, and activity stay. A refusal comes back with a reason to show.
        fire: (hireId: string): Promise<FireReply> =>
            invoke('colleague:fire', { hireId }) as Promise<FireReply>,
        onChanged: (listener: () => void): (() => void) => on('projects:changed', () => listener())
    }),

    // Hiring a colleague into a project. Returns the created hire's id and safe
    // fields; the hire binds to the project so its cold-spawn cwd resolves.
    hire: Object.freeze({
        create: (type: string, title: string, projectId: string): Promise<HireCreated> =>
            invoke('hire:create', { type, title, projectId }) as Promise<HireCreated>
    }),

    // The roster. Read-only cards, and a change signal the renderer answers by
    // re-requesting the snapshot. onChanged returns an unsubscribe.
    roster: Object.freeze({
        snapshot: (): Promise<RosterSnapshot> => invoke('roster:snapshot') as Promise<RosterSnapshot>,
        onChanged: (listener: () => void): (() => void) => on('roster:changed', () => listener())
    }),

    // The channel timeline. Read-only and paginated: page loads the newest or an
    // older page, since fetches the tail after a cursor, onChanged signals a row
    // landed. Ids and text only, no path.
    channel: Object.freeze({
        page: (before: ChannelCursor | null, limit: number): Promise<ChannelPageReply> =>
            invoke('channel:page', { before, limit }) as Promise<ChannelPageReply>,
        since: (after: ChannelCursor, limit: number): Promise<ChannelPageReply> =>
            invoke('channel:since', { after, limit }) as Promise<ChannelPageReply>,
        conversation: (hireId: string, limit: number): Promise<ChannelPageReply> =>
            invoke('channel:conversation', { hireId, limit }) as Promise<ChannelPageReply>,
        // The persisted rich turns for a colleague, keyed by message id, so a reopened conversation
        // re-renders its past thinking, tools, diffs, and todos from storage. Read-only.
        turnEvents: (hireId: string): Promise<TurnEventsReply> =>
            invoke('channel:turn-events', { hireId }) as Promise<TurnEventsReply>,
        reply: (hireId: string, text: string): Promise<void> =>
            invoke('channel:reply', { hireId, text }) as Promise<void>,
        onChanged: (listener: () => void): (() => void) => on('channel:changed', () => listener()),
        // The colleague's reply streaming in live during a turn. The payload carries the whole
        // text so far for one hire; the tab shows it until the persisted row lands. Read-only push.
        onStreamDelta: (listener: (delta: ConversationStreamDelta) => void): (() => void) =>
            on('conversation:delta', (payload) => listener(payload as ConversationStreamDelta))
    }),

    // The rich activity feed. byHire reads a colleague's persisted accomplishment
    // rows for the Activity tab's history; onAppended pushes a live action (including
    // the reads and searches the store drops) while the colleague is open. Tool,
    // target, and status only, never file contents.
    activity: Object.freeze({
        byHire: (hireId: string, limit: number): Promise<ActivityByHireReply> =>
            invoke('activity:by-hire', { hireId, limit }) as Promise<ActivityByHireReply>,
        onAppended: (listener: (row: ActivityRow) => void): (() => void) =>
            on('activity:appended', (payload) => listener(payload as ActivityRow))
    }),

    // The saved-work notice on launch: what a drain committed and where, read from
    // the drain report. saved returns null when there is nothing new to show; ack
    // marks a drain's notice seen so it does not show again. Branch names only.
    checkpoints: Object.freeze({
        saved: (): Promise<SavedCheckpoints | null> =>
            invoke('checkpoints:saved') as Promise<SavedCheckpoints | null>,
        ack: (drainId: string): Promise<void> =>
            invoke('checkpoints:ack', { drainId }) as Promise<void>
    }),

    // The permission approvals (phase 2). pending lists the asks waiting on the person,
    // answer resolves one (the note becomes the deny reason), and onChanged fires when the
    // pending set changes so the approvals surface re-reads.
    approvals: Object.freeze({
        pending: (): Promise<PendingApprovals> => invoke('approvals:pending') as Promise<PendingApprovals>,
        answer: (id: string, approve: boolean, note: string | null): Promise<void> =>
            invoke('approval:answer', { id, approve, note }) as Promise<void>,
        onChanged: (listener: () => void): (() => void) => on('approvals:changed', () => listener())
    }),

    // The AskUserQuestion prompts. pending lists the asks waiting on the person, answer sends the
    // selected labels back (which the colleague receives as its tool result), and onChanged fires when
    // the pending set changes so the conversation re-reads its choices. Separate from approvals above.
    questions: Object.freeze({
        pending: (): Promise<PendingQuestions> => invoke('questions:pending') as Promise<PendingQuestions>,
        answer: (id: string, answers: AskAnswer): Promise<void> =>
            invoke('question:answer', { id, answers }) as Promise<void>,
        onChanged: (listener: () => void): (() => void) => on('questions:changed', () => listener())
    }),

    /**
     * The permission configuration surface (phase 3).
     *
     * **This is the only path by which permission rules can be written, and that is the whole
     * security story.** The invariant is that only Benzoo sets permissions. It holds because a
     * colleague has no part of this object: it speaks stream-json to Claude Code over its own
     * stdin and stdout, with no preload, no contextBridge and no ipcRenderer, so there is no
     * bridge for it to call and no channel for it to name. Its only other route to the rules
     * is the database file, which the gate denies because the database directory is a protected
     * path, and that denial survives a case-varied spelling and a symlinked one.
     *
     * So adding an editing UI does not add a way in. It adds a caller to a surface a colleague
     * could never reach, which is why the surface is worth being explicit about here rather
     * than being an unremarkable block of methods.
     *
     * Named methods over raw channels, and frozen with the rest, so the reachable set is
     * exactly these five reads and writes.
     */
    permissions: Object.freeze({
        /** A project's stored rules, split into the baseline and the colleague overrides. */
        rules: (projectId: string): Promise<PermissionRulesReply> =>
            invoke('permissions:rules', { projectId }) as Promise<PermissionRulesReply>,
        /** A resolved policy, each row tagged with where it came from. null hireId is the project level. */
        effective: (projectId: string, hireId: string | null): Promise<PermissionEffectiveReply> =>
            invoke('permissions:effective', { projectId, hireId }) as Promise<PermissionEffectiveReply>,
        /** hireId null adds a project baseline rule; a hire id adds that colleague's override. */
        add: (payload: PermissionAdd): Promise<PermissionWriteReply> =>
            invoke('permissions:add', payload) as Promise<PermissionWriteReply>,
        update: (payload: PermissionUpdate): Promise<PermissionWriteReply> =>
            invoke('permissions:update', payload) as Promise<PermissionWriteReply>,
        remove: (id: string): Promise<PermissionWriteReply> =>
            invoke('permissions:remove', { id }) as Promise<PermissionWriteReply>,
        /** Fired after every write, so an open config view re-reads. */
        onChanged: (listener: () => void): (() => void) => on('permissions:changed', () => listener())
    }),

    /**
     * Tasks (phase 1).
     *
     * `review` is the same shape of claim as the permission writes above, and rests on the
     * same fact: a colleague has no part of this object. Approving a task is the only route
     * to done anywhere in the application, it exists on this bridge alone, and a colleague
     * has no bridge. The lifecycle refuses a colleague reaching done as well, so the rule is
     * enforced in two independent places rather than resting on this one.
     *
     * `start` returns as soon as the task is running, not when it finishes. A task is
     * something I walk away from, so the call that begins one does not wait for it.
     */
    tasks: Object.freeze({
        byHire: (hireId: string, limit: number): Promise<TasksReply> =>
            invoke('tasks:by-hire', { hireId, limit }) as Promise<TasksReply>,
        assign: (hireId: string, text: string): Promise<TaskWriteReply> =>
            invoke('tasks:assign', { hireId, text }) as Promise<TaskWriteReply>,
        start: (id: string): Promise<TaskWriteReply> =>
            invoke('tasks:start', { id }) as Promise<TaskWriteReply>,
        /** approve closes it, fail abandons it, send-back returns it to working. */
        review: (id: string, decision: 'approve' | 'fail' | 'send-back', note: string | null = null): Promise<TaskWriteReply> =>
            invoke('tasks:review', { id, decision, note }) as Promise<TaskWriteReply>,
        /** The changed files on a task's result branch, for the review. */
        diff: (id: string): Promise<TaskDiffReply> =>
            invoke('tasks:diff', { id }) as Promise<TaskDiffReply>,
        /**
         * Every task across every colleague, for the board.
         *
         * A read, and the only one on this object that is not scoped to a colleague. The board
         * writes nothing: acting on a card navigates to the review surface, which goes through
         * `review` above, so there is no second route to a state change and the done-invariant
         * is untouched by adding this.
         */
        board: (closedLimit: number): Promise<TaskBoardReply> =>
            invoke('tasks:board', { closedLimit }) as Promise<TaskBoardReply>,
        onChanged: (listener: () => void): (() => void) => on('tasks:changed', () => listener())
    }),

    // The custom frameless title bar's window controls. frameless says whether this
    // window has no OS frame, so the renderer draws the bar. close routes through the
    // window's close, which the app hides to the tray, so it never quits or skips the
    // drain. onMaximizeChange lets the maximize/restore button track the real state.
    win: Object.freeze({
        frameless: FRAMELESS,
        minimize: (): Promise<void> => winInvoke('window:minimize') as Promise<void>,
        toggleMaximize: (): Promise<boolean> => winInvoke('window:toggle-maximize') as Promise<boolean>,
        close: (): Promise<void> => winInvoke('window:close') as Promise<void>,
        isMaximized: (): Promise<boolean> => winInvoke('window:is-maximized') as Promise<boolean>,
        onMaximizeChange: (listener: (maximized: boolean) => void): (() => void) =>
            winOn('window:maximized-changed', (payload) => listener(Boolean(payload)))
    }),

    // The shell surface: main asking the renderer to switch views. Used by the tray, which
    // routes a click to the board when something is waiting. One-way, read-only from here.
    shell: Object.freeze({
        onNavigate: (listener: (view: string) => void): (() => void) =>
            on('shell:navigate', (payload) => listener(String(payload)))
    }),

    // Dev-only UI-state triggers, present only when --stafford-dev was passed (dev builds). A
    // packaged build leaves this undefined, so the hidden panel has nothing to call. These invoke
    // the dev channels directly rather than through the guarded allowlist, because the whole
    // surface is dev-gated at exposure; in a packaged build main also registers no handler for them.
    dev: DEV
        ? Object.freeze({
            isDev: true as const,
            trigger: (state: string, n?: number): Promise<unknown> =>
                ipcRenderer.invoke('dev:trigger', { state, n }),
            clear: (): Promise<unknown> => ipcRenderer.invoke('dev:clear')
        })
        : undefined
});

contextBridge.exposeInMainWorld('stafford', api);

export type StaffordApi = typeof api;
