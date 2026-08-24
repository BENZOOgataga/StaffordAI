-- The ledger of first names ever drawn for a hire.
--
-- A hire's name is not chosen; it is drawn from the pool (data/first-names.json)
-- without replacement. This table is the permanent record of every name that has
-- ever been used, so a name is never recycled: task history keeps one owner per
-- name, and a second Marion six months later would make an old summary unreadable.
--
-- Append-only, and kept independent of the hires table on purpose. A hire row could
-- one day be removed; this record must outlive it, so the never-recycle guarantee
-- does not depend on how hires are stored.
CREATE TABLE used_names (
    name TEXT PRIMARY KEY,
    used_at TEXT NOT NULL
);

CREATE TRIGGER used_names_no_update BEFORE UPDATE ON used_names
BEGIN SELECT RAISE(ABORT, 'used_names is append-only'); END;
CREATE TRIGGER used_names_no_delete BEFORE DELETE ON used_names
BEGIN SELECT RAISE(ABORT, 'used_names is append-only'); END;
