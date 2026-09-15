-- A synthetic channel message is a CLI or system response, not a colleague talking: the output of a
-- slash command like /model or /compact, which the CLI answers itself and marks with model
-- "<synthetic>" and num_turns 0 on the wire. Stored so the Conversation renders it as a system line
-- rather than a colleague reply, and so that distinction survives a reopen rather than folding back
-- into a colleague bubble. Default 0, since every existing row and every ordinary message is real.
--
-- An added column rather than a new kind, the same shape as 0005 adding target_hire_id: the kind
-- CHECK stays message and event, and this flag rides alongside. The append-only triggers block row
-- updates and deletes, not this schema change.
ALTER TABLE channel_messages ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0;
