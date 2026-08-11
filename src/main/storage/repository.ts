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

import type { HiredAgent, Project, Task, PolicyLogEntry, DrainReportEntry } from '../../domain/models.ts';
import type { StorageDatabase, Statement } from './database.ts';
import {
    hireToRow, hireFromRow, projectToRow, projectFromRow, taskToRow, taskFromRow,
    policyLogToRow, policyLogFromRow, drainReportToRow, drainReportFromRow, type Row
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

    constructor(db: StorageDatabase) {
        this.#insert = db.prepare(
            'INSERT INTO tasks (id, agent_id, project_id, text, kind, origin, approvals, created_at, started_at, completed_at) ' +
            'VALUES (@id, @agent_id, @project_id, @text, @kind, @origin, @approvals, @created_at, @started_at, @completed_at)');
        this.#update = db.prepare(
            'UPDATE tasks SET agent_id=@agent_id, project_id=@project_id, text=@text, kind=@kind, origin=@origin, ' +
            'approvals=@approvals, created_at=@created_at, started_at=@started_at, completed_at=@completed_at WHERE id=@id');
        this.#get = db.prepare('SELECT * FROM tasks WHERE id = ?');
        this.#page = db.prepare('SELECT * FROM tasks ORDER BY created_at, id LIMIT ? OFFSET ?');
        this.#pageByProject = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?');
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

    constructor(db: StorageDatabase) {
        this.#append = db.prepare(
            'INSERT INTO drain_report (drain_id, agent_id, outcome, committed, branch, commit_id, at) ' +
            'VALUES (@drain_id, @agent_id, @outcome, @committed, @branch, @commit_id, @at)');
        this.#byDrain = db.prepare('SELECT * FROM drain_report WHERE drain_id = ? ORDER BY id');
    }

    append(entry: DrainReportEntry): void { this.#append.run(drainReportToRow(entry)); }
    /** Every row for one shutdown, in write order. */
    byDrain(drainId: string): DrainReportEntry[] {
        return rowsOf(this.#byDrain, drainId).map(drainReportFromRow);
    }
}

/** Every repository, built once over one open database. */
export interface Repositories {
    readonly hires: HireRepository;
    readonly projects: ProjectRepository;
    readonly tasks: TaskRepository;
    readonly policyLog: PolicyLogRepository;
    readonly drainReports: DrainReportRepository;
}

export function createRepositories(db: StorageDatabase): Repositories {
    return {
        hires: new HireRepository(db),
        projects: new ProjectRepository(db),
        tasks: new TaskRepository(db),
        policyLog: new PolicyLogRepository(db),
        drainReports: new DrainReportRepository(db)
    };
}
