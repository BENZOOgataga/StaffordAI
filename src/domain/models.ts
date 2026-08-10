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

/** How far an agent in a project is allowed to push. */
export const PUSH_POLICIES = {
    NONE: 'none',
    FEATURE_BRANCHES: 'feature-branches',
    INCLUDING_MAIN: 'including-main'
} as const;
export type PushPolicy = (typeof PUSH_POLICIES)[keyof typeof PUSH_POLICIES];

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
 * One channel message, append-only history.
 *
 * **Not defined in section 13.** The plan describes the channel (section 10:
 * history kept indefinitely, append-only, a peer pulled in at events with the
 * real artifact) but never gives a field shape. This is the minimal shape that
 * carries what section 10 describes: who said it, in which project, the body,
 * when, and an optional reference to the task or artifact that pulled a peer in.
 * Recorded as an assumption to confirm rather than a settled type.
 */
export interface ChannelMessage {
    id: string;
    projectId: string;
    /** Agent id, or a sentinel for Benzoo. Kept a string so the sender set is not fixed here. */
    senderId: string;
    body: string;
    at: string;
    /** The task this message was pulled in around, if any. */
    taskId: string | null;
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
    at: string;
}
