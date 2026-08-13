-- Channel timeline: the settled ChannelMessage shape.
--
-- Task 8 shaped channel_messages on the old narrow guess, a single nullable
-- task_id and no kind, and no repository was ever built over it, so the table is
-- empty. There is no row to preserve, so this reshapes rather than migrates data:
-- it drops the old table (and its triggers) and creates the settled one.
--
-- The settled shape carries a kind discriminator, message for human or agent text
-- and event for a colleague state change, and a typed artifact reference, ref_kind
-- of task, commit or file plus ref_value holding the id or the path. Two columns
-- rather than a join, because a reference is one small optional value read with the
-- row. The append-only triggers come across unchanged: the timeline only inserts.

DROP TABLE channel_messages;

CREATE TABLE channel_messages (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Agent id, or a sentinel for Benzoo. A string so the sender set is not fixed.
    sender_id  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('message', 'event')),
    body       TEXT NOT NULL,
    -- The typed artifact reference, or null. ref_kind constrains what ref_value is.
    ref_kind   TEXT CHECK (ref_kind IN ('task', 'commit', 'file')),
    ref_value  TEXT,
    at         TEXT NOT NULL
);

CREATE TRIGGER channel_messages_no_update BEFORE UPDATE ON channel_messages
BEGIN SELECT RAISE(ABORT, 'channel_messages is append-only'); END;

CREATE TRIGGER channel_messages_no_delete BEFORE DELETE ON channel_messages
BEGIN SELECT RAISE(ABORT, 'channel_messages is append-only'); END;
