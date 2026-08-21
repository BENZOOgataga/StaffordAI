-- Permission rules (docs/plans/PERMISSION-SYSTEM.md, phase 1).
--
-- One row per rule. A NULL hire_id is a project baseline rule; a set hire_id is a
-- colleague override on that project, which is why baseline and override share one shape
-- and resolution stays uniform. A rule carries a path_scope (for path-bearing tools) or a
-- command_pattern (for shell destructive rules), never both meaningfully; either may be
-- NULL for a category-wide rule. The CHECK constraints mirror the domain enums so a bad
-- value cannot reach the store.
--
-- Not append-only: the config UI edits and removes rules, so unlike the channel and
-- activity tables this one has no insert-only trigger. Only the user writes it, through
-- Stafford's own IPC; a colleague session has no handle to the database.

CREATE TABLE permission_rules (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    hire_id         TEXT,
    action          TEXT NOT NULL CHECK (action IN ('read', 'write', 'shell', 'fetch', 'delegate', 'other')),
    path_scope      TEXT,
    command_pattern TEXT,
    effect          TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'ask')),
    created_at      TEXT NOT NULL,
    created_by      TEXT NOT NULL
);

CREATE INDEX permission_rules_project ON permission_rules (project_id, hire_id);
