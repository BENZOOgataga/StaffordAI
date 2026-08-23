-- Send-back (docs/plans/TASKS.md, phase 2).
--
-- Approve and fail end a task. Send-back does not: it returns the task to working with my
-- note as the next turn's instruction, so the colleague continues from what it already did
-- rather than starting again. That makes a task iterative instead of one-shot, and it means a
-- task can now have several attempts rather than exactly one.
--
-- Two things have to survive that, and neither did.
--
-- The notes. Every send-back is a thing I said about the work, and the next review has to
-- show it: without the note, the panel shows a diff that changed for no visible reason.
-- Append-only in practice, stored as a JSON array of {at, note} in order, because the value
-- is the sequence and not just the last one.
--
-- The attempt count. A task on its third attempt reads differently from one on its first, and
-- the count is not derivable from the notes alone once a send-back can fail before it runs.
ALTER TABLE tasks ADD COLUMN send_backs TEXT;
ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
