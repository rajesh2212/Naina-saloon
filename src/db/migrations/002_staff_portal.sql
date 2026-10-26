-- 002_staff_portal.sql
-- Two things the staff portal needs that 001 did not have:
--   1. a `completed` booking status, so the diary can record work that happened;
--   2. room for the salon's operating time zone, which the portal stores in the
--      `settings` table under `salon_timezone` (no row = the shipped default).
--
-- Postgres can widen its own CHECK constraint in place, so this is the two
-- statements SQLite had to fake by rebuilding the table. The partial unique
-- index is recreated to cover 'completed' as well: an appointment that was
-- served still owns its slot, so the same clock time can never be handed to a
-- second client even if staff close a request early.

ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'completed', 'rejected', 'cancelled'));

DROP INDEX bookings_one_active_per_slot_key;
CREATE UNIQUE INDEX bookings_one_active_per_slot_key
  ON bookings (slot_id) WHERE status IN ('pending', 'confirmed', 'completed');

-- The day sheet joins bookings onto every slot of a date; the partial unique
-- index above cannot serve that because it only covers three statuses.
CREATE INDEX bookings_slot_key ON bookings (slot_id);
