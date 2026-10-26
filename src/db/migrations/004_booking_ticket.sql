-- 004_booking_ticket.sql
-- Where a confirmed booking's ticket PDF lives. The bytes go to the private
-- Blob store under the tickets prefix — never a public bucket, and never a path
-- the static mount can hand out — and the row only ever holds the URL path plus
-- the moment it was issued, so a download can be answered from storage and
-- re-made from live data if the object was ever lost.
--
-- Both columns stay NULL until staff move a request to Confirmed — a pending
-- request has no ticket, and nothing in the app offers one.

ALTER TABLE bookings ADD COLUMN ticket_path TEXT;
ALTER TABLE bookings ADD COLUMN ticket_issued_at TEXT;
