-- Reviewable-after rich turns: the persisted block snapshot of a colleague's turn.
--
-- Phases 1-6 render a colleague's turn live (thinking, tool calls, shell output, diffs,
-- todos, reply text). This table lets a finished turn re-render that same rich content
-- after the fact, when the colleague is reopened, rather than only its final text.
--
-- One row per colleague reply, keyed by the channel_messages id of that reply, so a
-- message and its rich blocks pair one to one. blocks is the assembled snapshot the live
-- renderer already consumes (a JSON array of blocks in order), NOT the raw stream deltas,
-- which are redundant once reassembled. The array preserves order, so no separate index is
-- needed. Measured at about 1.8 KB for a heavy real turn (a long file read is a one-liner,
-- not a body; shell output and diffs are already capped at capture), so in-DB is comfortable
-- at any realistic turn count and no per-turn file is warranted.
--
-- Append-only, the same discipline as channel_messages and activity_events: a persisted
-- turn is a fact that happened, never edited or deleted.

CREATE TABLE turn_events (
    message_id TEXT PRIMARY KEY,
    hire_id    TEXT NOT NULL,
    blocks     TEXT NOT NULL,
    at         TEXT NOT NULL
);

-- The read is one colleague's persisted turns, joined to its messages by id.
CREATE INDEX turn_events_by_hire ON turn_events (hire_id, at, message_id);

CREATE TRIGGER turn_events_no_update BEFORE UPDATE ON turn_events
BEGIN SELECT RAISE(ABORT, 'turn_events is append-only'); END;

CREATE TRIGGER turn_events_no_delete BEFORE DELETE ON turn_events
BEGIN SELECT RAISE(ABORT, 'turn_events is append-only'); END;
