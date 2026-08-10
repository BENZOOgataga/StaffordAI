-- Migration 0001: the initial schema.
--
-- Mirrors section 13 of docs/plans/STAFFORD-PLAN.md and the domain types in
-- src/domain/models.ts. The enumerated columns carry CHECK constraints whose
-- allowed values match the const objects there; the two are meant to be read
-- side by side.
--
-- Structured fields that section 13 models as arrays or objects (repos,
-- sessions, toolCeiling, writePaths, approvals, origin, policy diffs) are stored
-- as JSON text. SQLite has no array type, and a local single-user store does not
-- need those normalised into join tables; the repository layer serialises them.
--
-- Append-only tables (policy_log, channel_messages, drain_report) are enforced
-- here by triggers that raise on UPDATE and DELETE, so append-only is a property
-- of the database rather than a promise the repository has to keep. The mutable
-- tables (hires, projects, tasks) are left updatable.

-- Projects. The policy is stored as one JSON blob rather than a column per
-- field: it is read and written whole, and its shape (ProjectPolicy) is the
-- contract, checked in the domain layer on the way in and out.
CREATE TABLE projects (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    repos TEXT NOT NULL,   -- JSON: ProjectRepo[]
    policy TEXT NOT NULL   -- JSON: ProjectPolicy, no sandbox field
);

-- Hires. sessions is projectId -> sessionId as JSON. active_project_id is a
-- soft reference: a hire can be active in a project row that has been removed,
-- so it is not a foreign key.
CREATE TABLE hires (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    type              TEXT NOT NULL,
    title             TEXT NOT NULL,
    seniority         INTEGER NOT NULL,
    owner_id          TEXT NOT NULL,
    sessions          TEXT NOT NULL,   -- JSON: Record<projectId, sessionId>
    active_project_id TEXT,
    state             TEXT NOT NULL,
    hired_at          TEXT NOT NULL,
    fired_at          TEXT
);

-- Tasks. origin and approvals are JSON. kind is constrained to the TaskKind set.
CREATE TABLE tasks (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    text         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('chore', 'feature')),
    origin       TEXT NOT NULL,   -- JSON: TaskOrigin
    approvals    TEXT NOT NULL,   -- JSON: Approval[]
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    completed_at TEXT
);

-- The append-only policy log: who changed what, when. actor is always Benzoo;
-- agents cannot apply policy changes, which the repository enforces on write and
-- the trigger enforces against edits after the fact.
CREATE TABLE policy_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    project_id TEXT NOT NULL,
    before     TEXT NOT NULL,   -- JSON: Partial<ProjectPolicy>
    after      TEXT NOT NULL    -- JSON: Partial<ProjectPolicy>
);
CREATE TRIGGER policy_log_no_update BEFORE UPDATE ON policy_log
BEGIN SELECT RAISE(ABORT, 'policy_log is append-only'); END;
CREATE TRIGGER policy_log_no_delete BEFORE DELETE ON policy_log
BEGIN SELECT RAISE(ABORT, 'policy_log is append-only'); END;

-- The append-only channel history. Shape is an assumption pending section 13,
-- see src/domain/models.ts. task_id is nullable: not every message is pulled in
-- around a task.
CREATE TABLE channel_messages (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    sender_id  TEXT NOT NULL,
    body       TEXT NOT NULL,
    at         TEXT NOT NULL,
    task_id    TEXT
);
CREATE TRIGGER channel_messages_no_update BEFORE UPDATE ON channel_messages
BEGIN SELECT RAISE(ABORT, 'channel_messages is append-only'); END;
CREATE TRIGGER channel_messages_no_delete BEFORE DELETE ON channel_messages
BEGIN SELECT RAISE(ABORT, 'channel_messages is append-only'); END;

-- The append-only drain report. Shaped now, filled by the drain in Task 9. One
-- drain run writes one grouped report keyed by drain_id. outcome is constrained
-- to the DrainOutcome set; force-killed is the killWithTree teardown path.
CREATE TABLE drain_report (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    drain_id  TEXT NOT NULL,
    agent_id  TEXT NOT NULL,
    outcome   TEXT NOT NULL CHECK (outcome IN ('checkpointed', 'committed', 'force-killed')),
    committed INTEGER NOT NULL CHECK (committed IN (0, 1)),
    branch    TEXT,
    commit_id TEXT,
    at        TEXT NOT NULL
);
CREATE TRIGGER drain_report_no_update BEFORE UPDATE ON drain_report
BEGIN SELECT RAISE(ABORT, 'drain_report is append-only'); END;
CREATE TRIGGER drain_report_no_delete BEFORE DELETE ON drain_report
BEGIN SELECT RAISE(ABORT, 'drain_report is append-only'); END;
