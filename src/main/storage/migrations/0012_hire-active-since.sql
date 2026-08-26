-- A colleague's current-binding epoch, for the Projects tab's rebind.
--
-- A rebind points a parked colleague at a new project as a fresh start: a new Claude session (an
-- empty sessions slot) and a clean conversation. But the per-colleague history tables
-- (channel_messages, activity_events, turn_events) are keyed by hire id alone and are append-only, so
-- a rebound colleague would otherwise still show the old project's messages, activity, and rich turns.
--
-- This adds the epoch the reads filter by: a colleague's conversation, activity, and turn history are
-- shown only from active_since forward. It is set to the hire time at creation and moved to now on a
-- rebind, so a rebind reads as clean as a fresh hire without deleting any append-only row. Existing
-- colleagues are backfilled to their hire time, so nothing they already show disappears.
--
-- Nullable and forward-only. ADD COLUMN is DDL, and hires is a mutable table (no append-only trigger),
-- so both the column add and the backfill are ordinary writes.

ALTER TABLE hires ADD COLUMN active_since TEXT;
UPDATE hires SET active_since = hired_at WHERE active_since IS NULL;
