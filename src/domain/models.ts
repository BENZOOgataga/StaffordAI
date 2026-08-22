/**
 * The persisted data shapes, shared by the main process and the renderer.
 *
 * These are section 13 of `docs/plans/STAFFORD-PLAN.md` turned into code, so the
 * repository layer in piece 2 and the schema in `migrations/0001_init.sql` are
 * typed and constrained against one definition rather than three that drift.
 *
 * Const objects with `as const` rather than TypeScript `enum` or bare string
 * unions for the enumerated sets: `erasableSyntaxOnly` is on, an enum emits
 * runtime code type stripping cannot generate, and a const object gives the
 * schema's `CHECK` constraint and this type one shared list of allowed values.
 *
 * `AgentState` is not redefined here; it already lives in `agent-state.ts` and
 * is imported, because two definitions of a hire's state is exactly the drift
 * this file exists to prevent.
 */

import type { AgentState } from './agent-state.ts';
import type { PermissionAction, PermissionEffect } from './permissions.ts';

/** How far an agent in a project is allowed to push. */
export const PUSH_POLICIES = {
    NONE: 'none',
    FEATURE_BRANCHES: 'feature-branches',
    INCLUDING_MAIN: 'including-main'
} as const;
export type PushPolicy = (typeof PUSH_POLICIES)[keyof typeof PUSH_POLICIES];

import type { TaskState } from './task-lifecycle.ts';

/** A chore is a one-off; only a feature can open the pipeline. */
export const TASK_KINDS = { CHORE: 'chore', FEATURE: 'feature' } as const;
export type TaskKind = (typeof TASK_KINDS)[keyof typeof TASK_KINDS];

/** An approval's verdict, pending until a gate is answered. */
export const APPROVAL_VERDICTS = {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected'
} as const;
export type ApprovalVerdict = (typeof APPROVAL_VERDICTS)[keyof typeof APPROVAL_VERDICTS];

/**
 * A per-project policy. Narrows the definitions it is applied to, never widens.
 *
 * **No `sandbox` field, deliberately.** Section 13 carries `sandbox: boolean`
 * marked owed, and that decision is open project-wide: whether it is a boolean
 * or per-path exceptions is unsettled. It is left out rather than stubbed, so
 * the type and migration 0001 agree and the seam is honest. Adding it later is a
 * migration plus a type change together.
 */
export interface ProjectPolicy {
    push: PushPolicy;
    allowedRoles: string[];
    /** Intersected with the definition's tools, never widens. null means no ceiling. */
    toolCeiling: string[] | null;
    /** null means the whole repo is writable. */
    writePaths: string[] | null;
    requirePipeline: boolean;
    allowWebFetch: boolean;
    /** Set deliberately per project, not inherited from the machine. */
    permissionMode: string;
    maxConcurrentAgents: number;
}

/** One repository inside a project. */
export interface ProjectRepo {
    path: string;
    label: string;
}

export interface Project {
    id: string;
    name: string;
    repos: ProjectRepo[];
    policy: ProjectPolicy;
}

/**
 * A hired agent. Persists across sessions, keeps one session per project it has
 * worked on, and at most one active at a time.
 */
export interface HiredAgent {
    /** Stable internal id, never reused. */
    id: string;
    /** Generated at hire, immutable. */
    name: string;
    /** Definition filename, e.g. "lead-developer". */
    type: string;
    /** Display role, read from the definition. */
    title: string;
    /** Lower number delegates to higher. */
    seniority: number;
    /** No implicit single user, for the eventual hosted plane. */
    ownerId: string;
    /** projectId to sessionId, one session per project worked. */
    sessions: Record<string, string>;
    /** At most one active at a time; null when none is. */
    activeProjectId: string | null;
    state: AgentState;
    hiredAt: string;
    firedAt: string | null;
}

export interface Approval {
    agentId: string;
    verdict: ApprovalVerdict;
    note: string | null;
    at: string | null;
}

/** Where a task came from: the user, or another agent delegating. */
export type TaskOrigin =
    | { kind: 'user' }
    | { kind: 'agent'; agentId: string };

export interface Task {
    id: string;
    agentId: string;
    projectId: string;
    text: string;
    kind: TaskKind;
    origin: TaskOrigin;
    /** Empty until a gate opens. */
    approvals: Approval[];
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    /** Where the task is in its lifecycle. See domain/task-lifecycle.ts for who may move it. */
    state: TaskState;
    /** The branch the colleague's work landed on, or null before there is any. */
    resultBranch: string | null;
    resultCommit: string | null;
    /** The colleague's own closing account of what it did, the first thing I read at review. */
    resultSummary: string | null;
    /** The Claude session the task ran under, so its transcript is findable. */
    sessionId: string | null;
    failedReason: string | null;
    updatedAt: string | null;
    /**
     * The tracked state of the working tree when the task started, as a tree sha. The result
     * is built from the difference between this and the state at completion, so the branch
     * holds what the task did rather than whatever was dirty. Null before a task starts.
     */
    baselineTree: string | null;
    /** New files the colleague named as its deliverable. Empty until it says. */
    declaredOutputs: string[];
    /** Named files that were refused, with the reason, for the review. Null when none were. */
    refusedOutputs: string | null;
}

/**
 * An append-only record of a policy change. Only Benzoo is ever the actor;
 * agents cannot apply policy changes.
 */
export interface PolicyLogEntry {
    at: string;
    actor: string;
    projectId: string;
    before: Partial<ProjectPolicy>;
    after: Partial<ProjectPolicy>;
}

/**
 * One stored permission rule (docs/plans/PERMISSION-SYSTEM.md). A null hireId is a project
 * baseline rule; a set hireId is a colleague override on that project. The action, scope,
 * pattern, and effect are the resolution shape from ./permissions.ts. Only the user writes
 * these, through Stafford's own UI; a colleague session has no path to this table.
 */
export interface PermissionRuleRecord {
    id: string;
    projectId: string;
    /** null means a project baseline rule; a value means a colleague override. */
    hireId: string | null;
    action: PermissionAction;
    pathScope: string | null;
    commandPattern: string | null;
    effect: PermissionEffect;
    createdAt: string;
    createdBy: string;
}

/**
 * One channel message, append-only history.
 *
 * **Not defined in section 13.** The plan describes the channel (section 10:
 * history kept indefinitely, append-only, a peer pulled in at events with the
 * real artifact) but never gives a field shape. This is the minimal shape that
 * carries what section 10 describes: who said it, in which project, the body,
 * when, and an optional reference to the task or artifact that pulled a peer in.
 * Recorded as an assumption to confirm rather than a settled type.
 */
/** The kind of a channel row: conversation text, or a colleague state event. */
export const CHANNEL_KINDS = { MESSAGE: 'message', EVENT: 'event' } as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[keyof typeof CHANNEL_KINDS];

/** What a channel message can reference: a task, a commit, or a file. */
export const CHANNEL_REF_KINDS = { TASK: 'task', COMMIT: 'commit', FILE: 'file' } as const;
export type ChannelRefKind = (typeof CHANNEL_REF_KINDS)[keyof typeof CHANNEL_REF_KINDS];

/** A typed artifact reference: a kind plus the id or path it points at. */
export interface ChannelRef {
    kind: ChannelRefKind;
    /** The task or commit id, or the file path. */
    value: string;
}

/**
 * One row on the channel timeline, append-only.
 *
 * Messages and events share one ordered stream, so `kind` discriminates human or
 * agent text from a colleague state change. The reference is typed, a kind plus an
 * id or path, replacing the old single nullable `taskId`, so a message or an event
 * can point at a task, a commit, or a file.
 */
export interface ChannelMessage {
    id: string;
    projectId: string;
    /** Agent id, or a sentinel for Benzoo. Kept a string so the sender set is not fixed here. */
    senderId: string;
    /**
     * The colleague a person's message is addressed to, so the per-colleague
     * Conversation can be keyed by hire. Set to the hire id on a person's reply
     * (whose senderId is the Benzoo sentinel and so carries no hire on its own), and
     * null on a colleague's own message or an event (there the senderId is the hire).
     */
    targetHireId: string | null;
    kind: ChannelKind;
    /** The message text, or the rendered summary of an event. */
    body: string;
    reference: ChannelRef | null;
    at: string;
}

/** The outcome of a coalesced activity action. `incomplete` is a use whose session ended first. */
export const ACTIVITY_STATUSES = { OK: 'ok', ERROR: 'error', INCOMPLETE: 'incomplete' } as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[keyof typeof ACTIVITY_STATUSES];

/**
 * One completed action a colleague took, append-only. Coalesced from a transcript
 * use and its result before it is stored, so a row already carries its outcome: the
 * tool, its target (a path or command, never file contents), a status, and when.
 * Keyed by hire, with the session it happened in.
 */
export interface ActivityRecord {
    id: string;
    hireId: string;
    sessionId: string | null;
    tool: string;
    target: string | null;
    status: ActivityStatus;
    at: string;
}

/**
 * The outcome of one agent at drain time, append-only.
 *
 * **Shaped now, filled in Task 9.** The drain is Task 9, but the plan requires
 * its report written to disk before the app quits, so the table has to exist
 * before then. Task 8 shapes the row; Task 9 writes it. The teardown outcome
 * column carries the three states the drain distinguishes, one of which,
 * `force-killed`, is the `killWithTree` path.
 */
export const DRAIN_OUTCOMES = {
    CHECKPOINTED: 'checkpointed',
    COMMITTED: 'committed',
    FORCE_KILLED: 'force-killed'
} as const;
export type DrainOutcome = (typeof DRAIN_OUTCOMES)[keyof typeof DRAIN_OUTCOMES];

export interface DrainReportEntry {
    /** The drain run this row belongs to, so one quit writes one grouped report. */
    drainId: string;
    agentId: string;
    outcome: DrainOutcome;
    /** Whether the checkpoint commit actually succeeded, distinct from being attempted. */
    committed: boolean;
    branch: string | null;
    commitId: string | null;
    /** Why a checkpoint did not commit (clean, an error summary, timed-out), or null. */
    reason: string | null;
    at: string;
}
