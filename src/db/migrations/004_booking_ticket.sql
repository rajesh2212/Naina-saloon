-- 004_booking_ticket.sql
-- Where a confirmed booking's ticket PDF lives. The file itself is written to
-- public/uploads/tickets (gitignored, like the customer avatars); the row only
-- ever holds the URL path plus the moment it was issued, so a download can be
-- answered from storage and re-made from live data if the disk was ever wiped.
--
-- Both columns stay NULL until staff move a request to Confirmed — a pending
-- request has no ticket, and nothing in the app offers one.

ALTER TABLE bookings ADD COLUMN ticket_path TEXT;
ALTER TABLE bookings ADD COLUMN ticket_issued_at TEXT;
