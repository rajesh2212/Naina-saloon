-- 002_staff_portal.sql
-- Two things the staff portal needs that 001 did not have:
--   1. a `completed` booking status, so the diary can record work that happened;
--   2. room for the salon's operating time zone, which the portal stores in the
--      `settings` table under `salon_timezone` (no row = the shipped default).
--
-- SQLite cannot widen a CHECK constraint in place, so `bookings` is rebuilt.
-- The partial unique index is recreated to cover 'completed' as well: an
-- appointment that was served still owns its slot, so the same clock time can
-- never be handed to a second client even if staff close a request early.

CREATE TABLE bookings__new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id         INTEGER NOT NULL REFERENCES slots (id) ON DELETE RESTRICT,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  service_id      INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'completed', 'rejected', 'cancelled')),
  contact_name    TEXT    NOT NULL,
  contact_phone   TEXT,
  preferred_title TEXT,
  note            TEXT,
  staff_note      TEXT,
  staff_action_at TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT
);

INSERT INTO bookings__new
  (id, slot_id, user_id, service_id, status, contact_name, contact_phone,
   preferred_title, note, staff_note, staff_action_at, created_at, updated_at)
SELECT id, slot_id, user_id, service_id, status, contact_name, contact_phone,
       preferred_title, note, staff_note, staff_action_at, created_at, updated_at
FROM bookings;

DROP TABLE bookings;
ALTER TABLE bookings__new RENAME TO bookings;

CREATE UNIQUE INDEX bookings_one_active_per_slot_key
  ON bookings (slot_id) WHERE status IN ('pending', 'confirmed', 'completed');
CREATE INDEX bookings_user_key ON bookings (user_id, status);
CREATE INDEX bookings_status_key ON bookings (status, created_at);
-- The day sheet joins bookings onto every slot of a date; the partial unique
-- index above cannot serve that because it only covers three statuses.
CREATE INDEX bookings_slot_key ON bookings (slot_id);
