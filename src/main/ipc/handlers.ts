/**
 * The IPC handlers, registered against the shared allowlist.
 *
 * Every invoke channel gets exactly one handler and every handler validates its
 * arguments with a guard from `src/domain/guards.ts` before acting. The
 * registration is keyed off `INVOKE_CHANNELS`, so a channel added to the
 * allowlist without a handler here, or a handler here for a channel not on the
 * allowlist, is a mismatch a test catches.
 *
 * The renderer acts on ids and sizes, never on paths. Nothing here reads a
 * filename or a directory the renderer named.
 */

import type { IpcMain, WebContents } from 'electron';
import {
    INVOKE_CHANNELS, type InvokeChannel, type HealthReport, type ProjectsList, type RosterSnapshot,
    type SessionOpened, type ChannelCursor, type ChannelMessageRow, type ChannelPageReply,
    type ProjectCreated, type HireCreated, type ActivityRow, type ActivityByHireReply,
    type SavedCheckpoints
} from '../../shared/ipc.ts';
import {
    isProofSpawn, isProofWrite, isSessionOpen, isSessionResize, isSessionWrite,
    isChannelPage, isChannelSince, isChannelConversation, isChannelReply, isProjectCreate, isHireCreate, isActivityByHire, isCheckpointAck
} from '../../domain/guards.ts';
import { sanitiseMessage } from '../../domain/message-input.ts';
import { OutputCoalescer } from './output-coalescer.ts';
import type { ProofPty } from './proof-pty.ts';

export interface HandlerDeps {
    readonly startedAt: string;
    readonly platformId: string;
    readonly proof: ProofPty;
    /** Where proof:data and proof:exit are pushed. */
    readonly sender: () => WebContents | null;
    /**
     * A read-only, bounded list of projects as summaries, ids and names only.
     * A function rather than the repository itself, so the handler stays
     * injectable and testable and never reaches for the store directly.
     */
    readonly listProjects: () => ProjectsList;
    /**
     * Creates a project from a name and repo paths, returning its id and name.
     * Validation (the repo path is a real directory, the name is non-empty) lives
     * in the create logic and throws on a bad input, which becomes a rejected
     * invoke. Ids and names cross back, never a path.
     */
    readonly createProject: (payload: { name: string; repoPaths: readonly string[] }) => ProjectCreated;
    /**
     * Creates a hire bound to a project, returning its id and safe fields. Throws
     * on an unknown definition type or a missing project, which becomes a rejected
     * invoke.
     */
    readonly createHire: (
        payload: { name: string; type: string; title: string; projectId: string }
    ) => HireCreated;
    /**
     * The roster as cards, read-only and bounded (one per hire). A function, so
     * the handler stays injectable and never reaches into the store or the
     * registry directly.
     */
    readonly rosterSnapshot: () => RosterSnapshot;
    /**
     * Subscribes to a hire's live terminal output, returning an unsubscribe. The
     * listener is called with the replayed buffer first, then live chunks, per the
     * PtySession replay-then-stream contract. A hire with no live session returns a
     * no-op unsubscribe.
     */
    readonly subscribeSession: (hireId: string, listener: (data: string) => void) => () => void;
    /** Propagates a pane resize to the pty. */
    readonly resizeSession: (hireId: string, cols: number, rows: number) => void;
    /** Whether a live session is up for a hire, so the renderer knows to expect output. */
    readonly hasSession: (hireId: string) => boolean;
    /**
     * Submits a sanitised message to a hire's session, spawning or resuming if
     * none is up. The handler sanitises and scopes; this delivers it.
     */
    readonly submitMessage: (hireId: string, text: string) => Promise<void>;
    /** A page of the timeline: the newest when `before` is null, else older rows. */
    readonly channelPage: (before: ChannelCursor | null, limit: number) => readonly ChannelMessageRow[];
    /** Rows newer than a cursor, for the tail append. */
    readonly channelSince: (after: ChannelCursor, limit: number) => readonly ChannelMessageRow[];
    readonly channelConversation: (hireId: string, limit: number) => readonly ChannelMessageRow[];
    /** One colleague's persisted activity, oldest-first, for the Activity feed's history. */
    readonly activityByHire: (hireId: string, limit: number) => readonly ActivityRow[];
    /** The saved work from the most recent committed drain, or null when there is nothing new to show. */
    readonly savedCheckpoints: () => SavedCheckpoints | null;
    /** Marks a drain's saved-work notice seen, so it does not show again. */
    readonly ackCheckpoints: (drainId: string) => void;
    /**
     * An inline reply to a colleague. Records it in the timeline as a message from
     * the person, then delivers it to that hire's session through the lifecycle,
     * which spawns, resumes, or writes to a live one. The text is already sanitised
     * by the handler.
     */
    readonly channelReply: (hireId: string, text: string) => Promise<void>;
}

/**
 * The handler for each invoke channel, as a map so a test can assert the keys
 * are exactly the allowlist without electron. Each returns a value or throws;
 * a throw becomes a rejected invoke on the renderer side.
 */
export function buildHandlers(deps: HandlerDeps): Record<InvokeChannel, (payload: unknown) => unknown> {
    // The one open terminal's subscription and coalescer. Only the open card
    // streams: opening closes any previous one first, so a card that is not open
    // receives nothing, and closing stops the stream. Held here because streaming
    // is stateful where the rest of the handlers are not.
    let open: { hireId: string; unsubscribe: () => void; coalescer: OutputCoalescer } | null = null;

    function closeOpen(): void {
        if (!open) return;
        open.unsubscribe();
        open.coalescer.dispose();
        open = null;
    }

    return {
        health: (): HealthReport => ({
            ok: true,
            platform: deps.platformId,
            startedAt: deps.startedAt,
            ptyOpen: deps.proof.isOpen()
        }),

        // Read-only. No payload, like health, so no argument guard: it takes
        // nothing from the renderer to act on. It exists to exercise the store's
        // mapping and query path on every run rather than only under the smoke
        // flag.
        'projects:list': (): ProjectsList => deps.listProjects(),

        // Creating a project. The renderer names repo paths for validation; the
        // create logic refuses any that is not a real directory, so a bad path
        // fails here rather than as a dead terminal after a first message. Only an
        // id and a name cross back.
        'project:create': (payload: unknown): ProjectCreated => {
            if (!isProjectCreate(payload)) {
                throw new Error('project:create requires {name,repoPaths}');
            }
            return deps.createProject({ name: payload.name, repoPaths: payload.repoPaths });
        },

        // Creating a hire, bound to an owning project so its cold-spawn cwd
        // resolves to that project's real directory. Refuses an unknown definition
        // type or a missing project.
        'hire:create': (payload: unknown): HireCreated => {
            if (!isHireCreate(payload)) {
                throw new Error('hire:create requires {name,type,title,projectId}');
            }
            return deps.createHire({
                name: payload.name, type: payload.type, title: payload.title, projectId: payload.projectId
            });
        },

        // Read-only, no payload. One card per hire, bounded by how many hires
        // exist. The renderer re-requests this on a roster:changed signal rather
        // than being pushed a card per hook event.
        'roster:snapshot': (): RosterSnapshot => deps.rosterSnapshot(),

        // Opening a card's terminal. Closes any previously open one first, so only
        // the open card streams. The coalescer batches a burst of pty output into
        // one push over session:data. Replay comes through the same path first.
        'session:open': (payload: unknown): SessionOpened => {
            if (!isSessionOpen(payload)) throw new Error('session:open requires {hireId}');
            closeOpen();
            const coalescer = new OutputCoalescer({
                sink: (data) => deps.sender()?.send('session:data', data)
            });
            const unsubscribe = deps.subscribeSession(payload.hireId, (data) => coalescer.push(data));
            open = { hireId: payload.hireId, unsubscribe, coalescer };
            return { live: deps.hasSession(payload.hireId) };
        },

        'session:close': (): void => { closeOpen(); },

        'session:resize': (payload: unknown): void => {
            if (!isSessionResize(payload)) throw new Error('session:resize requires {hireId,cols,rows}');
            deps.resizeSession(payload.hireId, payload.cols, payload.rows);
        },

        // The timeline, read-only and paginated. `before` null loads the newest
        // page; a cursor loads older rows for scroll-back. Never a read-everything.
        'channel:page': (payload: unknown): ChannelPageReply => {
            if (!isChannelPage(payload)) throw new Error('channel:page requires {before,limit}');
            return { rows: deps.channelPage(payload.before, payload.limit) };
        },

        // Rows newer than a cursor. The renderer calls this on channel:changed to
        // append the tail rather than re-reading the whole timeline.
        'channel:since': (payload: unknown): ChannelPageReply => {
            if (!isChannelSince(payload)) throw new Error('channel:since requires {after,limit}');
            return { rows: deps.channelSince(payload.after, payload.limit) };
        },

        // One colleague's own conversation, keyed by hire, so the Conversation tab
        // shows only its thread and a person's reply to another colleague never leaks in.
        'channel:conversation': (payload: unknown): ChannelPageReply => {
            if (!isChannelConversation(payload)) throw new Error('channel:conversation requires {hireId,limit}');
            return { rows: deps.channelConversation(payload.hireId, payload.limit) };
        },

        // One colleague's persisted activity history, for the Activity feed on open.
        'activity:by-hire': (payload: unknown): ActivityByHireReply => {
            if (!isActivityByHire(payload)) throw new Error('activity:by-hire requires {hireId,limit}');
            return { rows: deps.activityByHire(payload.hireId, payload.limit) };
        },

        // The saved-work notice on launch, and the acknowledgement that dismisses it.
        'checkpoints:saved': (): SavedCheckpoints | null => deps.savedCheckpoints(),
        'checkpoints:ack': (payload: unknown): void => {
            if (!isCheckpointAck(payload)) throw new Error('checkpoints:ack requires {drainId}');
            deps.ackCheckpoints(payload.drainId);
        },

        // An inline reply to a colleague. Sanitised here, at the trust boundary,
        // exactly as session:write, then routed by hire id through the lifecycle,
        // the one write path, so no second session logic is introduced.
        'channel:reply': (payload: unknown): Promise<void> => {
            if (!isChannelReply(payload)) throw new Error('channel:reply requires {hireId,text}');
            return deps.channelReply(payload.hireId, sanitiseMessage(payload.text));
        },

        // A typed message. Scoped to the open card: the renderer names the hire, and
        // main only writes to the session whose card is currently open, so a stale
        // write from a card no longer open cannot land on the previous session and
        // the renderer cannot reach a process it does not have open. The text is
        // sanitised here, at the trust boundary, before it reaches stdin.
        'session:write': (payload: unknown): Promise<void> => {
            if (!isSessionWrite(payload)) throw new Error('session:write requires {hireId,text}');
            if (!open || open.hireId !== payload.hireId) {
                throw new Error('session:write refused: that session is not the open card');
            }
            return deps.submitMessage(open.hireId, sanitiseMessage(payload.text));
        },

        'proof:spawn': (payload: unknown): { ok: boolean } => {
            if (!isProofSpawn(payload)) throw new Error('proof:spawn requires {cols,rows}');
            deps.proof.spawn(payload, {
                onData: (data) => deps.sender()?.send('proof:data', data),
                onExit: (info) => deps.sender()?.send('proof:exit', info)
            });
            return { ok: true };
        },

        'proof:write': (payload: unknown): void => {
            if (!isProofWrite(payload)) throw new Error('proof:write requires {data}');
            deps.proof.write(payload.data);
        },

        'proof:kill': (): void => { deps.proof.kill(); }
    };
}

/** Wires the handler map into electron's ipcMain, one `handle` per channel. */
export function registerHandlers(ipcMain: IpcMain, deps: HandlerDeps): void {
    const handlers = buildHandlers(deps);
    for (const channel of INVOKE_CHANNELS) {
        ipcMain.handle(channel, (_event, payload: unknown) => handlers[channel](payload));
    }
}
