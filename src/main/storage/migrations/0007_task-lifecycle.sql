-- Task lifecycle (docs/plans/TASKS.md, phase 1).
--
-- The tasks table already existed from migration 0001 with the instruction, the colleague,
-- the project, the origin and the approvals. What it had no notion of was a lifecycle, so a
-- task could be created and worked but never tracked through assigned, working, needs-you,
-- done and failed. That is what this adds, plus somewhere to put the result.
--
-- state is the lifecycle, constrained here so a bad value cannot reach the store even by raw
-- statement, the same belt as the permission_rules CHECKs. It defaults to 'assigned' because
-- that is what an existing row is: created, given to a colleague, never started.
--
-- The state column is deliberately a flat column on the task row rather than a separate
-- events table. The board in Model B is one select grouped by this column and ordered by
-- updated_at, which is why updated_at is here now rather than being added later when the
-- board needs it.
--
-- result_branch and result_commit are where the work landed, both NULL until there is any.
-- The branch is stafford/task/<hire>/<task id>, deliberately not the drain's
-- stafford/checkpoint/<hire>/<timestamp>, so a colleague that both works tasks and gets
-- drained does not accumulate branches under one prefix with nothing saying which is the
-- result to review.
--
-- session_id is the Claude session the task ran under, so its transcript is findable rather
-- than mixed in with everything else the colleague ever said.
--
-- Not append-only. A task moves through states and the row is updated in place, which is why
-- this table has no insert-only trigger, unlike channel and activity.

ALTER TABLE tasks ADD COLUMN state TEXT NOT NULL DEFAULT 'assigned'
    CHECK (state IN ('assigned', 'working', 'needs-you', 'done', 'failed'));

ALTER TABLE tasks ADD COLUMN result_branch  TEXT;
ALTER TABLE tasks ADD COLUMN result_commit  TEXT;
ALTER TABLE tasks ADD COLUMN result_summary TEXT;
ALTER TABLE tasks ADD COLUMN session_id     TEXT;
ALTER TABLE tasks ADD COLUMN failed_reason  TEXT;
ALTER TABLE tasks ADD COLUMN updated_at     TEXT;

-- The board's query, and the roster's "what is waiting on me" count, both read by state.
CREATE INDEX tasks_state ON tasks (state, updated_at);
CREATE INDEX tasks_agent_state ON tasks (agent_id, state);
