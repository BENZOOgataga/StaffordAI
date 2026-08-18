-- The drain report gains a reason.
--
-- The git executor now turns a checkpoint into a real commit, and a checkpoint that
-- did not commit has a reason worth keeping: nothing to commit (clean), a git error,
-- or the executor timing out. The three existing fields (committed, branch,
-- commit_id) cannot tell a clean tree from a failed commit, they read the same, so
-- this adds the one column that distinguishes them.
--
-- Nullable, because a success has no reason to record (committed carries that) and a
-- force-killed row is about the agent process, not a checkpoint. Existing rows get
-- NULL. Adding a column is a schema change, not a row edit, so the append-only
-- triggers on this table are unaffected.

ALTER TABLE drain_report ADD COLUMN reason TEXT;
