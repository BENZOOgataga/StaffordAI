-- Task result isolation (docs/plans/TASKS.md).
--
-- A task's result branch was carrying whatever happened to be dirty in the working tree when
-- it finished, rather than what the task itself changed. The checkpoint deliberately never
-- resets the tree, so after one task the next one inherited its edits: measured on
-- 2026-08-22, a task that changed nothing produced a branch holding the previous task's work.
-- That makes the review surface dishonest, since approving a task could carry in changes it
-- never made.
--
-- The fix needs one remembered fact: the tracked state of the tree at the moment the task
-- started. The difference between that and the state at completion is exactly what the task
-- did, and the result is then built as HEAD plus those paths and nothing else.
--
-- Stored on the row rather than held in memory because a task outlives a turn and could
-- outlive a restart, and a baseline that vanished would silently take isolation with it.
--
-- It is a tree sha, so it names a tree object in the repository and nothing else. No ref
-- points at it, which means git collects it if the task is abandoned, and that is the right
-- behaviour for a baseline nobody will ever compare against.
ALTER TABLE tasks ADD COLUMN baseline_tree TEXT;

-- What the colleague named as new-file deliverables, and what was refused, so the review can
-- say why a file it mentioned is not on the branch. JSON text, null before a task completes.
ALTER TABLE tasks ADD COLUMN declared_outputs TEXT;
ALTER TABLE tasks ADD COLUMN refused_outputs TEXT;
