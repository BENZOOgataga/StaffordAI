/**
 * The single place domain objects turn into rows and back.
 *
 * Every repository maps through here, so row shape has one definition rather
 * than one per query. The columns are snake_case because that is the schema; the
 * domain types are camelCase; this file is the only place that translation
 * lives.
 *
 * Reads fail loud. A column that is absent, null where the type is not nullable,
 * or the wrong SQLite affinity throws rather than producing a half-populated
 * object that a caller then trusts. The alternative, a silent `undefined` in a
 * field the type says is a string, is the class of bug that surfaces three
 * layers away from the row that caused it.
 *
 * Complex fields (repos, policy, sessions, approvals, origin, before/after)
 * are JSON text columns. SQLite has no array or object type and a local
 * single-user store does not need them normalised into join tables. Round-trip
 * identity is the contract, proven per entity in the tests.
 */

import type {
    HiredAgent, Project, ProjectPolicy, ProjectRepo, Task, TaskOrigin, Approval, PolicyLogEntry,
    DrainReportEntry, DrainOutcome, ChannelMessage, ChannelKind, ChannelRefKind, ActivityRecord, ActivityStatus
} from '../../domain/models.ts';
import {
    PUSH_POLICIES, TASK_KINDS, APPROVAL_VERDICTS, DRAIN_OUTCOMES, CHANNEL_KINDS, CHANNEL_REF_KINDS, ACTIVITY_STATUSES
} from '../../domain/models.ts';
import { isAgentState } from '../../domain/agent-state.ts';

export type Row = Record<string, unknown>;

function str(row: Row, col: string): string {
    const v = row[col];
    if (typeof v !== 'string') throw fail(col, 'string', v);
    return v;
}

function nstr(row: Row, col: string): string | null {
    const v = row[col];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw fail(col, 'string or null', v);
    return v;
}

function int(row: Row, col: string): number {
    const v = row[col];
    if (typeof v !== 'number' || !Number.isInteger(v)) throw fail(col, 'integer', v);
    return v;
}

function bool(row: Row, col: string): boolean {
    const v = int(row, col);
    if (v !== 0 && v !== 1) throw new Error('column ' + col + ' is ' + v + ', not the 0 or 1 a boolean stores as');
    return v === 1;
}

function json<T>(row: Row, col: string): T {
    const raw = str(row, col);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('column ' + col + ' is not valid JSON');
    }
    return parsed as T;
}

function object<T>(row: Row, col: string): T {
    const parsed = json<unknown>(row, col);
    if (parsed === null || typeof parsed !== 'object') {
        throw fail(col, 'JSON object', parsed);
    }
    return parsed as T;
}

function oneOf<T extends string>(row: Row, col: string, allowed: readonly string[]): T {
    const v = str(row, col);
    if (!allowed.includes(v)) throw new Error('column ' + col + ' is ' + JSON.stringify(v) + ', not one of ' + allowed.join(', '));
    return v as T;
}

function fail(col: string, expected: string, got: unknown): Error {
    return new Error('column ' + col + ' expected ' + expected + ', got ' + (got === null ? 'null' : typeof got));
}

// --- hires -----------------------------------------------------------------

export function hireToRow(h: HiredAgent): Row {
    return {
        id: h.id, name: h.name, type: h.type, title: h.title, seniority: h.seniority,
        owner_id: h.ownerId, sessions: JSON.stringify(h.sessions), active_project_id: h.activeProjectId,
        state: h.state, hired_at: h.hiredAt, fired_at: h.firedAt
    };
}

export function hireFromRow(row: Row): HiredAgent {
    const state = str(row, 'state');
    if (!isAgentState(state)) throw new Error('column state is ' + JSON.stringify(state) + ', not a known AgentState');
    return {
        id: str(row, 'id'), name: str(row, 'name'), type: str(row, 'type'), title: str(row, 'title'),
        seniority: int(row, 'seniority'), ownerId: str(row, 'owner_id'),
        sessions: object<Record<string, string>>(row, 'sessions'),
        activeProjectId: nstr(row, 'active_project_id'), state,
        hiredAt: str(row, 'hired_at'), firedAt: nstr(row, 'fired_at')
    };
}

// --- projects --------------------------------------------------------------

export function projectToRow(p: Project): Row {
    return { id: p.id, name: p.name, repos: JSON.stringify(p.repos), policy: JSON.stringify(p.policy) };
}

export function projectFromRow(row: Row): Project {
    return {
        id: str(row, 'id'), name: str(row, 'name'),
        repos: object<ProjectRepo[]>(row, 'repos'),
        policy: policyFromColumn(object<ProjectPolicy>(row, 'policy'))
    };
}

/**
 * Validates a parsed policy has its required scalar fields and, deliberately, no
 * `sandbox` key. The absent field is a seam, not an oversight, so a policy that
 * arrives carrying one is a sign the decision was taken elsewhere without a
 * migration and is rejected rather than silently stored through.
 */
function policyFromColumn(policy: ProjectPolicy): ProjectPolicy {
    if ('sandbox' in (policy as object)) {
        throw new Error('policy carries a sandbox field, which the schema and the type deliberately omit; ' +
            'add it with a migration and a type change together, not through the JSON column');
    }
    const push = policy.push;
    if (!Object.values(PUSH_POLICIES).includes(push)) {
        throw new Error('policy.push is ' + JSON.stringify(push) + ', not a known PushPolicy');
    }
    return policy;
}

// --- tasks -----------------------------------------------------------------

export function taskToRow(t: Task): Row {
    return {
        id: t.id, agent_id: t.agentId, project_id: t.projectId, text: t.text, kind: t.kind,
        origin: JSON.stringify(t.origin), approvals: JSON.stringify(t.approvals),
        created_at: t.createdAt, started_at: t.startedAt, completed_at: t.completedAt
    };
}

export function taskFromRow(row: Row): Task {
    const approvals = json<Approval[]>(row, 'approvals');
    for (const a of approvals) {
        if (!Object.values(APPROVAL_VERDICTS).includes(a.verdict)) {
            throw new Error('an approval verdict is ' + JSON.stringify(a.verdict) + ', not a known ApprovalVerdict');
        }
    }
    return {
        id: str(row, 'id'), agentId: str(row, 'agent_id'), projectId: str(row, 'project_id'),
        text: str(row, 'text'), kind: oneOf(row, 'kind', Object.values(TASK_KINDS)),
        origin: object<TaskOrigin>(row, 'origin'), approvals,
        createdAt: str(row, 'created_at'), startedAt: nstr(row, 'started_at'), completedAt: nstr(row, 'completed_at')
    };
}

// --- policy log (append-only) ----------------------------------------------

export function policyLogToRow(e: PolicyLogEntry): Row {
    return {
        at: e.at, actor: e.actor, project_id: e.projectId,
        before: JSON.stringify(e.before), after: JSON.stringify(e.after)
    };
}

export function policyLogFromRow(row: Row): PolicyLogEntry {
    return {
        at: str(row, 'at'), actor: str(row, 'actor'), projectId: str(row, 'project_id'),
        before: object<Partial<ProjectPolicy>>(row, 'before'), after: object<Partial<ProjectPolicy>>(row, 'after')
    };
}

// --- drain report (append-only) --------------------------------------------

export function drainReportToRow(e: DrainReportEntry): Row {
    return {
        drain_id: e.drainId, agent_id: e.agentId, outcome: e.outcome,
        // The schema stores the flag as 0 or 1; the domain carries a boolean.
        committed: e.committed ? 1 : 0, branch: e.branch, commit_id: e.commitId, reason: e.reason, at: e.at
    };
}

export function drainReportFromRow(row: Row): DrainReportEntry {
    return {
        drainId: str(row, 'drain_id'), agentId: str(row, 'agent_id'),
        outcome: oneOf<DrainOutcome>(row, 'outcome', Object.values(DRAIN_OUTCOMES)),
        committed: bool(row, 'committed'), branch: nstr(row, 'branch'),
        commitId: nstr(row, 'commit_id'), reason: nstr(row, 'reason'), at: str(row, 'at')
    };
}

// --- activity (append-only) ------------------------------------------------

export function activityRecordToRow(a: ActivityRecord): Row {
    return {
        id: a.id, hire_id: a.hireId, session_id: a.sessionId,
        tool: a.tool, target: a.target, status: a.status, at: a.at
    };
}

export function activityRecordFromRow(row: Row): ActivityRecord {
    return {
        id: str(row, 'id'), hireId: str(row, 'hire_id'), sessionId: nstr(row, 'session_id'),
        tool: str(row, 'tool'), target: nstr(row, 'target'),
        status: oneOf<ActivityStatus>(row, 'status', Object.values(ACTIVITY_STATUSES)),
        at: str(row, 'at')
    };
}

// --- channel (append-only) -------------------------------------------------

export function channelMessageToRow(m: ChannelMessage): Row {
    return {
        id: m.id, project_id: m.projectId, sender_id: m.senderId, target_hire_id: m.targetHireId, kind: m.kind, body: m.body,
        // The typed reference is two columns; both null when there is none, so the
        // ref_kind CHECK never sees a value it does not allow.
        ref_kind: m.reference ? m.reference.kind : null,
        ref_value: m.reference ? m.reference.value : null,
        at: m.at
    };
}

export function channelMessageFromRow(row: Row): ChannelMessage {
    const refKind = nstr(row, 'ref_kind');
    return {
        id: str(row, 'id'), projectId: str(row, 'project_id'), senderId: str(row, 'sender_id'),
        targetHireId: nstr(row, 'target_hire_id'),
        kind: oneOf<ChannelKind>(row, 'kind', Object.values(CHANNEL_KINDS)),
        body: str(row, 'body'),
        // A reference is present only when ref_kind is; then ref_value must be too.
        reference: refKind === null
            ? null
            : { kind: oneOf<ChannelRefKind>(row, 'ref_kind', Object.values(CHANNEL_REF_KINDS)), value: str(row, 'ref_value') },
        at: str(row, 'at')
    };
}
