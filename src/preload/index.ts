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
    type ActivityByHireReply, type ActivityRow, type SavedCheckpoints, type PendingApprovals,
    type PermissionRulesReply, type PermissionEffectiveReply, type PermissionWriteReply,
    type PermissionAdd, type PermissionUpdate,
    type TasksReply, type TaskWriteReply
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
            invoke('project:create', { name, repoPaths }) as Promise<ProjectCreated>
    }),

    // Hiring a colleague into a project. Returns the created hire's id and safe
    // fields; the hire binds to the project so its cold-spawn cwd resolves.
    hire: Object.freeze({
        create: (name: string, type: string, title: string, projectId: string): Promise<HireCreated> =>
            invoke('hire:create', { name, type, title, projectId }) as Promise<HireCreated>
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
        reply: (hireId: string, text: string): Promise<void> =>
            invoke('channel:reply', { hireId, text }) as Promise<void>,
        onChanged: (listener: () => void): (() => void) => on('channel:changed', () => listener())
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

    /**
     * The permission configuration surface (phase 3).
     *
     * **This is the only path by which permission rules can be written, and that is the whole
     * security story.** The invariant is that only Benzoo sets permissions. It holds because a
     * colleague has no part of this object: it speaks stream-json to Claude Code over its own
     * stdin and stdout, with no preload, no contextBridge and no ipcRenderer, so there is no
     * bridge for it to call and no channel for it to name. Its only other route to the rules
     * is the database file, which the gate denies because userData is a protected path, and
     * that denial survives a case-varied spelling and a symlinked one.
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
        /** One colleague's resolved policy, each row tagged with where it came from. */
        effective: (projectId: string, hireId: string): Promise<PermissionEffectiveReply> =>
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
    })
});

contextBridge.exposeInMainWorld('stafford', api);

export type StaffordApi = typeof api;
