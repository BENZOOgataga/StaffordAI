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
    isInvokeChannel, isEventChannel, type InvokeChannel, type EventChannel,
    type HealthReport, type ProjectsList, type RosterSnapshot,
    type ChannelCursor, type ChannelPageReply, type ProjectCreated, type HireCreated,
    type ActivityByHireReply, type ActivityRow, type SavedCheckpoints
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
    })
});

contextBridge.exposeInMainWorld('stafford', api);

export type StaffordApi = typeof api;
