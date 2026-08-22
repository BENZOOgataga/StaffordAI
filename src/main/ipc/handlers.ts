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
    type ChannelCursor, type ChannelMessageRow, type ChannelPageReply,
    type ProjectCreated, type HireCreated, type ActivityRow, type ActivityByHireReply,
    type SavedCheckpoints, type PendingApprovals,
    type PermissionRulesReply, type PermissionEffectiveReply, type PermissionWriteReply,
    type PermissionAdd, type PermissionUpdate,
    type TasksReply, type TaskWriteReply, type TaskAssign, type TaskReview, type TaskDiffReply
} from '../../shared/ipc.ts';
import {
    isChannelPage, isChannelSince, isChannelConversation, isChannelReply, isProjectCreate, isHireCreate, isActivityByHire, isCheckpointAck,
    isApprovalAnswer,
    isPermissionRulesRequest, isPermissionEffectiveRequest, isPermissionAdd, isPermissionUpdate, isPermissionRemove,
    isTasksByHire, isTaskAssign, isTaskStart, isTaskReview, isTaskDiff
} from '../../domain/guards.ts';
import { sanitiseMessage } from '../../domain/message-input.ts';

export interface HandlerDeps {
    readonly startedAt: string;
    readonly platformId: string;
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
    /** A project's stored rules, split into baseline and colleague overrides. */
    readonly permissionRules: (projectId: string) => PermissionRulesReply;
    /** A colleague's resolved policy on a project, each row tagged with where it came from. */
    readonly effectivePolicy: (projectId: string, hireId: string) => PermissionEffectiveReply;
    /**
     * The three writes. They return a reply rather than throwing on a widening edit, because
     * a warning is advisory: it is Benzoo protecting himself from a careless click, not a
     * security boundary, and the boundary is the gate.
     */
    readonly addPermissionRule: (payload: PermissionAdd) => PermissionWriteReply;
    readonly updatePermissionRule: (payload: PermissionUpdate) => PermissionWriteReply;
    readonly removePermissionRule: (id: string) => PermissionWriteReply;
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
    /** The permission asks currently waiting on the person (phase 2). */
    readonly pendingApprovals: () => PendingApprovals;
    /** The person's answer to a pending ask, which resolves that turn's paused seam. */
    readonly answerApproval: (id: string, approve: boolean, note: string | null) => void;
    /** One colleague's tasks, newest first, capped. */
    readonly tasksByHire: (hireId: string, limit: number) => TasksReply;
    /** Creates a task for a colleague, in assigned. Does not start it. */
    readonly assignTask: (payload: TaskAssign) => TaskWriteReply;
    /**
     * Starts an assigned task. Returns as soon as the run is under way rather than when it
     * finishes, because the whole point of a task is that I walk away from it, and an invoke
     * that waited for the colleague would hold the renderer for minutes.
     */
    readonly startTask: (id: string) => TaskWriteReply;
    /**
     * My decision at review. This is the only route to done in the entire application, and
     * it is reachable only from Stafford's own window.
     */
    readonly reviewTask: (payload: TaskReview) => TaskWriteReply;
    /**
     * The changed files on a task's result branch. Paths and counts, never diff content: the
     * branch is in git for when I want to read the change properly.
     */
    readonly taskDiff: (id: string) => Promise<TaskDiffReply>;
}

/**
 * The handler for each invoke channel, as a map so a test can assert the keys
 * are exactly the allowlist without electron. Each returns a value or throws;
 * a throw becomes a rejected invoke on the renderer side.
 */
export function buildHandlers(deps: HandlerDeps): Record<InvokeChannel, (payload: unknown) => unknown> {
    return {
        health: (): HealthReport => ({
            ok: true,
            platform: deps.platformId,
            startedAt: deps.startedAt
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

        // The pending permission approvals, read-only, and the person's answer. The answer
        // resolves exactly the pending ask named by its id, so the right turn continues.
        'approvals:pending': (): PendingApprovals => deps.pendingApprovals(),
        'approval:answer': (payload: unknown): void => {
            if (!isApprovalAnswer(payload)) throw new Error('approval:answer requires {id,approve,note}');
            deps.answerApproval(payload.id, payload.approve, payload.note);
        },

        // Permission configuration (phase 3). Reads are bounded and carry no filesystem path
        // the renderer did not already store; writes go to the user-data database, which no
        // colleague can reach: a colleague has no IPC bridge at all, and the gate denies a
        // tool call against userData.
        'permissions:rules': (payload: unknown): PermissionRulesReply => {
            if (!isPermissionRulesRequest(payload)) throw new Error('permissions:rules requires {projectId}');
            return deps.permissionRules(payload.projectId);
        },
        'permissions:effective': (payload: unknown): PermissionEffectiveReply => {
            if (!isPermissionEffectiveRequest(payload)) throw new Error('permissions:effective requires {projectId,hireId}');
            return deps.effectivePolicy(payload.projectId, payload.hireId);
        },
        'permissions:add': (payload: unknown): PermissionWriteReply => {
            if (!isPermissionAdd(payload)) throw new Error('permissions:add requires {projectId,hireId,action,pathScope,effect}');
            return deps.addPermissionRule(payload);
        },
        'permissions:update': (payload: unknown): PermissionWriteReply => {
            if (!isPermissionUpdate(payload)) throw new Error('permissions:update requires {id,action,pathScope,effect}');
            return deps.updatePermissionRule(payload);
        },
        'permissions:remove': (payload: unknown): PermissionWriteReply => {
            if (!isPermissionRemove(payload)) throw new Error('permissions:remove requires {id}');
            return deps.removePermissionRule(payload.id);
        },

        // Tasks. Read is per colleague and capped; the three writes each name their own
        // actor inside the service, so nothing on the wire chooses who is acting.
        'tasks:by-hire': (payload: unknown): TasksReply => {
            if (!isTasksByHire(payload)) throw new Error('tasks:by-hire requires {hireId,limit}');
            return deps.tasksByHire(payload.hireId, payload.limit);
        },
        'tasks:assign': (payload: unknown): TaskWriteReply => {
            if (!isTaskAssign(payload)) throw new Error('tasks:assign requires {hireId,text}');
            return deps.assignTask(payload);
        },
        'tasks:start': (payload: unknown): TaskWriteReply => {
            if (!isTaskStart(payload)) throw new Error('tasks:start requires {id}');
            return deps.startTask(payload.id);
        },
        // The only route to done. Renderer-to-main, like every channel here.
        'tasks:review': (payload: unknown): TaskWriteReply => {
            if (!isTaskReview(payload)) throw new Error('tasks:review requires {id,decision,note}');
            return deps.reviewTask(payload);
        },
        'tasks:diff': (payload: unknown): Promise<TaskDiffReply> => {
            if (!isTaskDiff(payload)) throw new Error('tasks:diff requires {id}');
            return deps.taskDiff(payload.id);
        }
    };
}

/** Wires the handler map into electron's ipcMain, one `handle` per channel. */
export function registerHandlers(ipcMain: IpcMain, deps: HandlerDeps): void {
    const handlers = buildHandlers(deps);
    for (const channel of INVOKE_CHANNELS) {
        ipcMain.handle(channel, (_event, payload: unknown) => handlers[channel](payload));
    }
}
