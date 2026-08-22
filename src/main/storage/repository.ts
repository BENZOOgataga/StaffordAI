/**
 * The typed read and write layer over the settled tables.
 *
 * One repository per table, each thin: it prepares its statements once and maps
 * rows through `mapping.ts`, which is the single definition of row shape. The
 * repositories hold no domain logic beyond persistence.
 *
 * **Every growing read is paginated, from the first version, not as a later
 * optimisation.** better-sqlite3 is synchronous and runs in the Electron main
 * process, so a query that returns an unbounded result set blocks the event loop
 * for as long as it takes, and while it runs the tray does not paint and no
 * agent's IPC is serviced. Tasks and the policy log grow without a ceiling, so
 * their reads take a limit and an offset and never offer a read-everything
 * method. Hires and projects are bounded by how many a person creates by hand,
 * so a full read is offered there deliberately, said here rather than left to
 * inference.
 *
 * **No channel repository.** `ChannelMessage`'s shape is an unconfirmed
 * assumption (see `models.ts`) and the channel feature is not being built, so a
 * repository over it now would harden a guess. The table and the type stay; the
 * repository is deferred until the channel feature settles the shape.
 *
 * Append-only tables (the policy log) get no update or delete method. That is
 * the repository half of the guarantee; the schema triggers from migration 0001
 * are the database half, so a raw statement is refused even if a method were
 * ever added.
 */

import type {
    HiredAgent, Project, Task, PolicyLogEntry, DrainReportEntry, ChannelMessage, ActivityRecord,
    PermissionRuleRecord
} from '../../domain/models.ts';
import type { ChannelCursor } from '../../shared/ipc.ts';
import type { StorageDatabase, Statement } from './database.ts';
import {
    hireToRow, hireFromRow, projectToRow, projectFromRow, taskToRow, taskFromRow,
    policyLogToRow, policyLogFromRow, drainReportToRow, drainReportFromRow,
    channelMessageToRow, channelMessageFromRow, activityRecordToRow, activityRecordFromRow,
    permissionRuleToRow, permissionRuleFromRow, type Row
} from './mapping.ts';

/** A page of a growing table. Both are required: there is no read-everything. */
export interface Page {
    readonly limit: number;
    readonly offset: number;
}

function rowsOf(statement: Statement, ...params: unknown[]): Row[] {
    return statement.all(...params) as Row[];
}

function rowOf(statement: Statement, ...params: unknown[]): Row | null {
    const row = statement.get(...params);
    return row === undefined ? null : (row as Row);
}

/** Hires. Bounded by how many the user creates, so a full read is offered. */
export class HireRepository {
    readonly #insert: Statement;
    readonly #update: Statement;
    readonly #get: Statement;
    readonly #all: Statement;

    constructor(db: StorageDatabase) {
        this.#insert = db.prepare(
            'INSERT INTO hires (id, name, type, title, seniority, owner_id, sessions, active_project_id, state, hired_at, fired_at) ' +
            'VALUES (@id, @name, @type, @title, @seniority, @owner_id, @sessions, @active_project_id, @state, @hired_at, @fired_at)');
        this.#update = db.prepare(
            'UPDATE hires SET name=@name, type=@type, title=@title, seniority=@seniority, owner_id=@owner_id, ' +
            'sessions=@sessions, active_project_id=@active_project_id, state=@state, hired_at=@hired_at, fired_at=@fired_at WHERE id=@id');
        this.#get = db.prepare('SELECT * FROM hires WHERE id = ?');
        this.#all = db.prepare('SELECT * FROM hires ORDER BY hired_at');
    }

    insert(hire: HiredAgent): void { this.#insert.run(hireToRow(hire)); }
    update(hire: HiredAgent): void { this.#update.run(hireToRow(hire)); }
    get(id: string): HiredAgent | null {
        const row = rowOf(this.#get, id);
        return row === null ? null : hireFromRow(row);
    }
    /** All hires. Bounded by user creation, so no pagination. */
    all(): HiredAgent[] { return rowsOf(this.#all).map(hireFromRow); }
}

/** Projects. Bounded by how many the user creates, so a full read is offered. */
export class ProjectRepository {
    readonly #insert: Statement;
    readonly #update: Statement;
    readonly #get: Statement;
    readonly #all: Statement;

    constructor(db: StorageDatabase) {
        this.#insert = db.prepare('INSERT INTO projects (id, name, repos, policy) VALUES (@id, @name, @repos, @policy)');
        this.#update = db.prepare('UPDATE projects SET name=@name, repos=@repos, policy=@policy WHERE id=@id');
        this.#get = db.prepare('SELECT * FROM projects WHERE id = ?');
        this.#all = db.prepare('SELECT * FROM projects ORDER BY name');
    }

    insert(project: Project): void { this.#insert.run(projectToRow(project)); }
    update(project: Project): void { this.#update.run(projectToRow(project)); }
    get(id: string): Project | null {
        const row = rowOf(this.#get, id);
        return row === null ? null : projectFromRow(row);
    }
    /** All projects. Bounded by user creation, so no pagination. */
    all(): Project[] { return rowsOf(this.#all).map(projectFromRow); }
}

/** Tasks. Grow without a ceiling, so reads are paginated. */
export class TaskRepository {
    readonly #insert: Statement;
    readonly #update: Statement;
    readonly #get: Statement;
    readonly #page: Statement;
    readonly #pageByProject: Statement;
    readonly #byHire: Statement;

    constructor(db: StorageDatabase) {
        this.#insert = db.prepare(
            'INSERT INTO tasks (id, agent_id, project_id, text, kind, origin, approvals, created_at, started_at, completed_at, ' +
            'state, result_branch, result_commit, result_summary, session_id, failed_reason, updated_at) ' +
            'VALUES (@id, @agent_id, @project_id, @text, @kind, @origin, @approvals, @created_at, @started_at, @completed_at, ' +
            '@state, @result_branch, @result_commit, @result_summary, @session_id, @failed_reason, @updated_at)');
        this.#update = db.prepare(
            'UPDATE tasks SET agent_id=@agent_id, project_id=@project_id, text=@text, kind=@kind, origin=@origin, ' +
            'approvals=@approvals, created_at=@created_at, started_at=@started_at, completed_at=@completed_at, ' +
            'state=@state, result_branch=@result_branch, result_commit=@result_commit, ' +
            'result_summary=@result_summary, session_id=@session_id, failed_reason=@failed_reason, ' +
            'updated_at=@updated_at WHERE id=@id');
        this.#get = db.prepare('SELECT * FROM tasks WHERE id = ?');
        this.#page = db.prepare('SELECT * FROM tasks ORDER BY created_at, id LIMIT ? OFFSET ?');
        this.#pageByProject = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?');
        // Newest first, because a task view is about what needs me now and what just moved,
        // not about the archive. Backed by the tasks_agent_state index from migration 0007.
        this.#byHire = db.prepare(
            'SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    }

    insert(task: Task): void { this.#insert.run(taskToRow(task)); }
    update(task: Task): void { this.#update.run(taskToRow(task)); }
    get(id: string): Task | null {
        const row = rowOf(this.#get, id);
        return row === null ? null : taskFromRow(row);
    }
    page(page: Page): Task[] { return rowsOf(this.#page, page.limit, page.offset).map(taskFromRow); }
    pageByProject(projectId: string, page: Page): Task[] {
        return rowsOf(this.#pageByProject, projectId, page.limit, page.offset).map(taskFromRow);
    }
    /** One colleague's tasks, newest first, capped by the caller. */
    byHire(agentId: string, limit: number): Task[] {
        return rowsOf(this.#byHire, agentId, limit).map(taskFromRow);
    }
}

/**
 * The append-only policy log. Append and paginated read only, by design.
 *
 * There is no update or delete method here, and there is no way to add one that
 * would work: migration 0001's triggers raise on UPDATE and DELETE, so the
 * database refuses them even by raw statement. Only Benzoo is ever the actor,
 * which the caller sets on the entry; the repository does not police that, the
 * product does.
 */
export class PolicyLogRepository {
    readonly #append: Statement;
    readonly #page: Statement;
    readonly #pageByProject: Statement;

    constructor(db: StorageDatabase) {
        this.#append = db.prepare(
            'INSERT INTO policy_log (at, actor, project_id, before, after) VALUES (@at, @actor, @project_id, @before, @after)');
        this.#page = db.prepare('SELECT * FROM policy_log ORDER BY id LIMIT ? OFFSET ?');
        this.#pageByProject = db.prepare('SELECT * FROM policy_log WHERE project_id = ? ORDER BY id LIMIT ? OFFSET ?');
    }

    append(entry: PolicyLogEntry): void { this.#append.run(policyLogToRow(entry)); }
    page(page: Page): PolicyLogEntry[] { return rowsOf(this.#page, page.limit, page.offset).map(policyLogFromRow); }
    pageByProject(projectId: string, page: Page): PolicyLogEntry[] {
        return rowsOf(this.#pageByProject, projectId, page.limit, page.offset).map(policyLogFromRow);
    }
}

/**
 * The append-only drain report. Append and grouped read only, by design.
 *
 * One quit writes one report: a row per active agent, grouped by `drain_id`. The
 * drain only ever inserts, as each agent's outcome becomes known, so a drain
 * interrupted partway still leaves the resolved agents' rows on disk. There is no
 * update or delete method here and no way to add one that would work: migration
 * 0001's triggers raise on UPDATE and DELETE, so the database refuses them even
 * by raw statement.
 *
 * The read is bounded by `drain_id`: one shutdown's rows, which is one row per
 * live agent, so it is not a growing scan and needs no pagination.
 */
export class DrainReportRepository {
    readonly #append: Statement;
    readonly #byDrain: Statement;
    readonly #latestCommittedId: Statement;
    readonly #committedForDrain: Statement;

    constructor(db: StorageDatabase) {
        this.#append = db.prepare(
            'INSERT INTO drain_report (drain_id, agent_id, outcome, committed, branch, commit_id, reason, at) ' +
            'VALUES (@drain_id, @agent_id, @outcome, @committed, @branch, @commit_id, @reason, @at)');
        this.#byDrain = db.prepare('SELECT * FROM drain_report WHERE drain_id = ? ORDER BY id');
        // The most recent shutdown that saved anything, by write time.
        this.#latestCommittedId = db.prepare(
            'SELECT drain_id FROM drain_report WHERE committed = 1 ORDER BY at DESC, id DESC LIMIT 1');
        this.#committedForDrain = db.prepare(
            'SELECT * FROM drain_report WHERE drain_id = ? AND committed = 1 ORDER BY id');
    }

    append(entry: DrainReportEntry): void { this.#append.run(drainReportToRow(entry)); }
    /** Every row for one shutdown, in write order. */
    byDrain(drainId: string): DrainReportEntry[] {
        return rowsOf(this.#byDrain, drainId).map(drainReportFromRow);
    }

    /**
     * The committed rows of the most recent shutdown that saved anything, for the
     * launch notice. Empty when no drain has ever committed. Read-only: this reads
     * what the drain wrote, it never re-derives from git.
     */
    latestCommittedDrain(): DrainReportEntry[] {
        const row = this.#latestCommittedId.get() as { drain_id: string } | undefined;
        if (!row) return [];
        return rowsOf(this.#committedForDrain, row.drain_id).map(drainReportFromRow);
    }
}

/**
 * The channel timeline. Append and paginated read only, by design.
 *
 * Messages and events share one stream, ordered by time, with `id` as a stable
 * tiebreak so a page is deterministic when two rows share a timestamp. It grows
 * without a ceiling, so the read is paginated and there is no read-everything
 * method. There is no update or delete method, and none that would work:
 * migration 0002's triggers raise on UPDATE and DELETE, so the database refuses
 * them even by raw statement.
 */
export class ChannelRepository {
    readonly #append: Statement;
    readonly #page: Statement;
    readonly #pageByProject: Statement;
    readonly #newest: Statement;
    readonly #before: Statement;
    readonly #after: Statement;
    readonly #conversation: Statement;

    constructor(db: StorageDatabase) {
        this.#append = db.prepare(
            'INSERT INTO channel_messages (id, project_id, sender_id, target_hire_id, kind, body, ref_kind, ref_value, at) ' +
            'VALUES (@id, @project_id, @sender_id, @target_hire_id, @kind, @body, @ref_kind, @ref_value, @at)');
        this.#page = db.prepare('SELECT * FROM channel_messages ORDER BY at, id LIMIT ? OFFSET ?');
        // One colleague's own conversation: the rows it sent or that were addressed to
        // it. A colleague's own messages and its events carry sender_id = the hire; a
        // person's replies to it carry target_hire_id = the hire. Newest first for the
        // cap, reversed to oldest-first by the caller.
        this.#conversation = db.prepare(
            'SELECT * FROM channel_messages WHERE sender_id = @hireId OR target_hire_id = @hireId ' +
            'ORDER BY at DESC, id DESC LIMIT @limit');
        this.#pageByProject = db.prepare(
            'SELECT * FROM channel_messages WHERE project_id = ? ORDER BY at, id LIMIT ? OFFSET ?');
        // The newest page: the tail, for the initial load. Read descending, then
        // reversed to oldest-first so the timeline is one ascending order.
        this.#newest = db.prepare('SELECT * FROM channel_messages ORDER BY at DESC, id DESC LIMIT @limit');
        // Older than a cursor, for scroll-back. Row-value comparison on (at, id).
        this.#before = db.prepare(
            'SELECT * FROM channel_messages WHERE at < @at OR (at = @at AND id < @id) ' +
            'ORDER BY at DESC, id DESC LIMIT @limit');
        // Newer than a cursor, for the tail append when a row lands. Already ascending.
        this.#after = db.prepare(
            'SELECT * FROM channel_messages WHERE at > @at OR (at = @at AND id > @id) ' +
            'ORDER BY at ASC, id ASC LIMIT @limit');
    }

    append(message: ChannelMessage): void { this.#append.run(channelMessageToRow(message)); }

    /** A page of the whole timeline, messages and events interleaved by time. */
    page(page: Page): ChannelMessage[] {
        return rowsOf(this.#page, page.limit, page.offset).map(channelMessageFromRow);
    }

    /** The newest `limit` rows, oldest-first, for the initial timeline load. */
    newest(limit: number): ChannelMessage[] {
        return (this.#newest.all({ limit }) as Row[]).map(channelMessageFromRow).reverse();
    }

    /** Up to `limit` rows older than the cursor, oldest-first, for scroll-back. */
    before(cursor: ChannelCursor, limit: number): ChannelMessage[] {
        return (this.#before.all({ at: cursor.at, id: cursor.id, limit }) as Row[])
            .map(channelMessageFromRow).reverse();
    }

    /** Rows newer than the cursor, oldest-first, for appending the tail. */
    after(cursor: ChannelCursor, limit: number): ChannelMessage[] {
        return (this.#after.all({ at: cursor.at, id: cursor.id, limit }) as Row[]).map(channelMessageFromRow);
    }

    /** A page of one project's timeline. */
    pageByProject(projectId: string, page: Page): ChannelMessage[] {
        return rowsOf(this.#pageByProject, projectId, page.limit, page.offset).map(channelMessageFromRow);
    }

    /**
     * One colleague's own conversation, oldest-first: the rows it sent or that were
     * addressed to it, capped to the newest `limit`. This is the per-hire key the
     * Conversation tab reads, so a person's reply to one colleague does not appear in
     * another's. Events for the hire come along, since they share the sender_id key.
     */
    conversationFor(hireId: string, limit: number): ChannelMessage[] {
        return (this.#conversation.all({ hireId, limit }) as Row[]).map(channelMessageFromRow).reverse();
    }
}

/**
 * The append-only activity store: one coalesced row per action a colleague took.
 * Append and read-by-hire only, the same shape the policy log and drain report use.
 * The read is one colleague's actions oldest-first, for the reopen history.
 */
export class ActivityRepository {
    readonly #append: Statement;
    readonly #byHire: Statement;

    constructor(db: StorageDatabase) {
        this.#append = db.prepare(
            'INSERT INTO activity_events (id, hire_id, session_id, tool, target, status, at) ' +
            'VALUES (@id, @hire_id, @session_id, @tool, @target, @status, @at)');
        this.#byHire = db.prepare(
            'SELECT * FROM activity_events WHERE hire_id = ? ORDER BY at, id LIMIT ?');
    }

    append(record: ActivityRecord): void { this.#append.run(activityRecordToRow(record)); }

    /** One colleague's actions, oldest-first, up to `limit`, for the reopen history. */
    byHire(hireId: string, limit: number): ActivityRecord[] {
        return (this.#byHire.all(hireId, limit) as Row[]).map(activityRecordFromRow);
    }
}

/**
 * Permission rules. Bounded by how many the user writes by hand per project, so a full
 * read per project is offered. forProject returns the baseline (hire_id null) and every
 * colleague override in one read, so a session loads a project's rules once and the pure
 * resolver splits them. Only the user writes this table, through Stafford's own IPC.
 */
export class PermissionRuleRepository {
    readonly #insert: Statement;
    readonly #forProject: Statement;
    readonly #deleteForProject: Statement;
    readonly #get: Statement;
    readonly #update: Statement;
    readonly #deleteById: Statement;

    constructor(db: StorageDatabase) {
        this.#insert = db.prepare(
            'INSERT INTO permission_rules (id, project_id, hire_id, action, path_scope, command_pattern, effect, created_at, created_by) ' +
            'VALUES (@id, @project_id, @hire_id, @action, @path_scope, @command_pattern, @effect, @created_at, @created_by)');
        this.#forProject = db.prepare('SELECT * FROM permission_rules WHERE project_id = ? ORDER BY created_at, id');
        this.#deleteForProject = db.prepare('DELETE FROM permission_rules WHERE project_id = ?');
        this.#get = db.prepare('SELECT * FROM permission_rules WHERE id = ?');
        // The scope-defining columns only. A rule's project, its colleague and its author are
        // its identity, so an edit that could move a rule to another project or silently
        // reassign who wrote it is not an edit, it is a different rule.
        this.#update = db.prepare(
            'UPDATE permission_rules SET action = @action, path_scope = @path_scope, ' +
            'command_pattern = @command_pattern, effect = @effect WHERE id = @id');
        this.#deleteById = db.prepare('DELETE FROM permission_rules WHERE id = ?');
    }

    insert(rule: PermissionRuleRecord): void {
        this.#insert.run(permissionRuleToRow(rule));
    }

    /** Every rule for a project: the baseline (hire_id null) and all colleague overrides. */
    forProject(projectId: string): PermissionRuleRecord[] {
        return rowsOf(this.#forProject, projectId).map(permissionRuleFromRow);
    }

    /** One rule by id, or null. Lets a write check what it is about to change. */
    get(id: string): PermissionRuleRecord | null {
        const row = this.#get.get(id) as Record<string, unknown> | undefined;
        return row ? permissionRuleFromRow(row) : null;
    }

    /**
     * Edits a rule's action, scope, pattern and effect in place. The project, the colleague
     * and the author are not editable, so an edit can never move a rule onto another project
     * or another colleague. Returns false when no such rule exists.
     */
    update(id: string, fields: Pick<PermissionRuleRecord, 'action' | 'pathScope' | 'commandPattern' | 'effect'>): boolean {
        const result = this.#update.run({
            id,
            action: fields.action,
            path_scope: fields.pathScope,
            command_pattern: fields.commandPattern,
            effect: fields.effect
        });
        return result.changes > 0;
    }

    /** Removes one rule. Returns false when it was already gone. */
    deleteById(id: string): boolean {
        return this.#deleteById.run(id).changes > 0;
    }

    /** Removes every rule for a project. Used when replacing a project's rules wholesale. */
    deleteForProject(projectId: string): void {
        this.#deleteForProject.run(projectId);
    }
}

/** Every repository, built once over one open database. */
export interface Repositories {
    readonly hires: HireRepository;
    readonly projects: ProjectRepository;
    readonly tasks: TaskRepository;
    readonly policyLog: PolicyLogRepository;
    readonly drainReports: DrainReportRepository;
    readonly channel: ChannelRepository;
    readonly activity: ActivityRepository;
    readonly permissionRules: PermissionRuleRepository;
}

export function createRepositories(db: StorageDatabase): Repositories {
    return {
        hires: new HireRepository(db),
        projects: new ProjectRepository(db),
        tasks: new TaskRepository(db),
        policyLog: new PolicyLogRepository(db),
        drainReports: new DrainReportRepository(db),
        channel: new ChannelRepository(db),
        activity: new ActivityRepository(db),
        permissionRules: new PermissionRuleRepository(db)
    };
}
