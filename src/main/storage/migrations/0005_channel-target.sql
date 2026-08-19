-- Per-colleague conversation: give a channel message a target hire.
--
-- The Conversation tab is one colleague's own thread, but the person's own
-- replies were stored with sender_id set to the Benzoo sentinel and no record of
-- which colleague they were sent to, so every "You" message fanned out into every
-- colleague's Conversation. This adds the missing target: the hire a person's
-- message was addressed to. A colleague's own message and an event carry null here
-- (their sender_id is already the hire), so only a person's reply sets it.
--
-- Nullable and forward-only. Existing rows keep null: an old person's message has
-- no recoverable target, so it stops fanning out rather than being misattributed;
-- an old colleague message still keys by sender_id and is unaffected. ADD COLUMN is
-- DDL, so the append-only UPDATE trigger does not fire.

ALTER TABLE channel_messages ADD COLUMN target_hire_id TEXT;
