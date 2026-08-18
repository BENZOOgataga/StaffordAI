-- Per-colleague activity: the rich feed's store.
--
-- One row per completed action, already coalesced from the transcript's use and
-- result halves before it lands here, so a row is "edited f.ts (ok)", not two rows
-- to re-join in the view. Keyed by hire, with the session it happened in, so
-- reopening a colleague reads back what it did in order.
--
-- Only the accomplishment set is written (edits, writes, commands, subagent
-- dispatch); pure reads and searches are live-only and never reach this table. The
-- stored fields are the typed ones only: the tool, its target (a path or a command,
-- never file contents or a tool_response body), a status, and when. status is
-- constrained to the three the coalescer produces: ok, error, or incomplete for an
-- action whose session ended before its result arrived.
--
-- Append-only, the same discipline as channel_messages, policy_log, and
-- drain_report: an activity row is a fact that happened, never edited or deleted.

CREATE TABLE activity_events (
    id         TEXT PRIMARY KEY,
    hire_id    TEXT NOT NULL,
    session_id TEXT,
    tool       TEXT NOT NULL,
    target     TEXT,
    status     TEXT NOT NULL CHECK (status IN ('ok', 'error', 'incomplete')),
    at         TEXT NOT NULL
);

-- The read is always one colleague's actions in time order, so index that.
CREATE INDEX activity_events_by_hire ON activity_events (hire_id, at, id);

CREATE TRIGGER activity_events_no_update BEFORE UPDATE ON activity_events
BEGIN SELECT RAISE(ABORT, 'activity_events is append-only'); END;

CREATE TRIGGER activity_events_no_delete BEFORE DELETE ON activity_events
BEGIN SELECT RAISE(ABORT, 'activity_events is append-only'); END;
