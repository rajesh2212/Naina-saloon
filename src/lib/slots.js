'use strict';
/**
 * Appointment availability and booking.
 *
 * A slot row is one clock time on one date. A slot is free when nothing blocks
 * it and no booking in `pending`/`confirmed` points at it, so `bookings` stays
 * the single source of truth. `bookings.slot_id` carries a partial unique index
 * that makes a second active booking for the same slot impossible at the
 * database level, and every write here runs inside BEGIN IMMEDIATE.
 */
const db = require('../db');
const dates = require('./dates');
const studio = require('./settings');
const { HttpError } = require('./async');

const ACTIVE_STATUSES = ['pending', 'confirmed'];
const ACTIVE_SQL = ACTIVE_STATUSES.map(() => '?').join(',');

function getService(serviceId, { bookableOnly = true } = {}) {
  const row = db.get(
    `SELECT s.*, c.name AS category_name, c.slug AS category_slug
     FROM services s JOIN service_categories c ON c.id = s.category_id
     WHERE s.id = ? AND s.is_active = 1${bookableOnly ? ' AND s.is_bookable = 1' : ''}`,
    serviceId,
  );
  return row || null;
}

/** Steps between opening and closing that leave room for `durationMinutes`. */
function slotStarts({ openMinutes, closeMinutes, durationMinutes, stepMinutes, notBeforeMinutes }) {
  const starts = [];
  const lastAllowed = closeMinutes - durationMinutes;
  for (let m = Math.max(openMinutes, notBeforeMinutes ?? openMinutes); m <= lastAllowed; m += stepMinutes) {
    starts.push(dates.minutesToHm(m));
  }
  return starts;
}

/**
 * Create the slot rows for a date if they are missing. Idempotent; safe to call
 * on every availability request.
 */
function ensureDateSlots(dateStr, { force = false } = {}) {
  if (!dates.isValidDate(dateStr)) throw new HttpError(400, 'Choose a valid date.');
  const rules = studio.bookingRules();
  const today = dates.salonClock().date;
  if (dateStr < today) return { closed: false, past: true, created: 0, date: dateStr };
  const offset = dates.daysBetween(today, dateStr);
  if (offset > rules.horizonDays) {
    return { closed: false, beyondHorizon: true, created: 0, date: dateStr };
  }
  const hours = studio.dayHours(dates.weekdayOf(dateStr));
  if (!hours || hours.closed) return { closed: true, created: 0, date: dateStr, hours };

  if (!force) {
    const existing = db.get('SELECT COUNT(*) AS n FROM slots WHERE slot_date = ?', dateStr);
    if (existing && existing.n > 0) return { closed: false, created: 0, date: dateStr, hours };
  }

  const starts = slotStarts({
    openMinutes: hours.openMinutes,
    closeMinutes: hours.closeMinutes,
    durationMinutes: 0,
    stepMinutes: rules.stepMinutes,
  });

  db.transaction(() => {
    const insert = db.getDb().prepare(
      'INSERT OR IGNORE INTO slots (slot_date, start_time) VALUES (?, ?)',
    );
    for (const start of starts) insert.run(dateStr, start);
  });

  return { closed: false, created: starts.length, date: dateStr, hours };
}

/** Cutoff minute so a same-day booking still needs the configured notice. */
function notBeforeMinutesFor(dateStr, leadMinutes) {
  const today = dates.salonClock().date;
  if (dateStr !== today) return null;
  return dates.salonClock().minutes + leadMinutes;
}

/**
 * Is another live booking on this slot? `exceptBookingId` lets a booking move
 * between its own statuses (pending -> confirmed) without clashing with itself.
 */
function activeBookingExists(slotId, exceptBookingId = null) {
  return Boolean(
    db.get(
      `SELECT 1 AS hit FROM bookings
       WHERE slot_id = ? AND id IS NOT ? AND status IN (${ACTIVE_SQL})`,
      slotId,
      exceptBookingId,
      ...ACTIVE_STATUSES,
    ),
  );
}

/**
 * Slots a customer can actually take for one service on one date: inside the
 * studio's hours, long enough for the service, past the notice period, free.
 */
function availableSlots(serviceId, dateStr) {
  const service = getService(serviceId);
  if (!service) throw new HttpError(404, 'That service is not available for booking.');

  const rules = studio.bookingRules();
  const prepared = ensureDateSlots(dateStr);
  if (prepared.past) return { service, date: dateStr, slots: [], notice: 'That date has already passed.' };
  if (prepared.beyondHorizon) {
    return { service, date: dateStr, slots: [], notice: `The studio publishes dates ${rules.horizonDays} days ahead.` };
  }
  if (prepared.closed) {
    return { service, date: dateStr, slots: [], notice: 'The studio is closed on that day.' };
  }

  const hours = prepared.hours;
  const notBefore = notBeforeMinutesFor(dateStr, rules.leadMinutes);
  const rows = db.all(
    `SELECT s.id, s.start_time, s.status
     FROM slots s
     WHERE s.slot_date = ? AND s.status = 'open'
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.slot_id = s.id AND b.status IN (${ACTIVE_SQL})
       )
     ORDER BY s.start_time`,
    dateStr,
    ...ACTIVE_STATUSES,
  );

  const minStart = notBefore === null ? hours.openMinutes : notBefore;
  const maxStart = hours.closeMinutes - service.duration_minutes;
  const slots = rows
    .filter((row) => {
      const m = dates.hmToMinutes(row.start_time);
      return m !== null && m >= minStart && m <= maxStart;
    })
    .map((row) => ({
      id: row.id,
      startTime: row.start_time,
      endTime: dates.minutesToHm(dates.hmToMinutes(row.start_time) + service.duration_minutes),
      label: dates.formatTime12(row.start_time),
      endLabel: dates.formatTime12(dates.minutesToHm(dates.hmToMinutes(row.start_time) + service.duration_minutes)),
      range: dates.formatRange(row.start_time, service.duration_minutes),
    }));

  return {
    service,
    date: dateStr,
    slots,
    hours,
    notice: slots.length
      ? null
      : notBefore !== null && maxStart < notBefore
        ? 'No slots left for today with the notice period the studio asks for. Please try another date.'
        : 'Fully booked for this service on that day. Try another date or a shorter service.',
    durationMinutes: service.duration_minutes,
  };
}

/** Slot counts per date, used by the date strip. */
function availabilityCalendar(serviceId, { days = null, from = null } = {}) {
  const service = getService(serviceId);
  if (!service) throw new HttpError(404, 'Service not found.');
  const rules = studio.bookingRules();
  const horizon = days || rules.horizonDays;
  const start = from || dates.salonClock().date;
  const out = [];
  for (let i = 0; i < horizon; i += 1) {
    const date = dates.addDays(start, i);
    const { slots, notice } = availableSlots(serviceId, date);
    out.push({ date, count: slots.length, first: slots[0] || null, notice });
  }
  return out;
}

function activeBookingCount(userId) {
  return Number(
    db.get(
      `SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status IN (${ACTIVE_SQL})`,
      userId,
      ...ACTIVE_STATUSES,
    ).n || 0,
  );
}

/**
 * Book a slot. Runs in one immediate transaction; the unique index is the last
 * line of defence if two requests race past the readability checks.
 */
function createBooking({ userId, serviceId, slotId, contactName, contactPhone, preferredTitle, note }) {
  const rules = studio.bookingRules();

  return db.transaction(() => {
    const service = getService(serviceId);
    if (!service) throw new HttpError(400, 'Please choose a service.');

    const user = db.get('SELECT id, name, phone, preferred_title FROM users WHERE id = ? AND is_active = 1', userId);
    if (!user) throw new HttpError(401, 'Please sign in again.');

    if (activeBookingCount(userId) >= rules.maxActivePerUser) {
      throw new HttpError(409, `You already have ${rules.maxActivePerUser} open bookings. Please let the studio confirm one first.`);
    }

    const slot = db.get('SELECT id, slot_date, start_time, status FROM slots WHERE id = ?', slotId);
    if (!slot) throw new HttpError(400, 'That appointment time is no longer listed. Please choose again.');

    const hours = studio.dayHours(dates.weekdayOf(slot.slot_date));
    if (!hours || hours.closed) throw new HttpError(409, 'The studio has closed that day. Please choose another date.');

    const startMinutes = dates.hmToMinutes(slot.start_time);
    const today = dates.salonClock().date;
    if (slot.slot_date < today || (slot.slot_date === today && startMinutes <= dates.salonClock().minutes)) {
      throw new HttpError(409, 'That time has already passed. Please choose another slot.');
    }
    const notBefore = notBeforeMinutesFor(slot.slot_date, rules.leadMinutes);
    if (notBefore !== null && startMinutes < notBefore) {
      throw new HttpError(409, `The studio needs at least ${rules.leadMinutes} minutes' notice for same-day appointments.`);
    }
    if (startMinutes + service.duration_minutes > hours.closeMinutes) {
      throw new HttpError(
        409,
        `${service.name} needs ${service.duration_minutes} minutes and would run past the studio's time for that day. Please choose an earlier slot.`,
      );
    }

    if (slot.status !== 'open') throw new HttpError(409, 'That slot is blocked by the studio. Please choose another time.');
    if (activeBookingExists(slot.id)) {
      throw new HttpError(409, 'Someone has just taken that slot. Please pick another time.');
    }

    const insert = db.run(
      `INSERT INTO bookings
        (slot_id, user_id, service_id, status, contact_name, contact_phone, preferred_title, note)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      slot.id,
      userId,
      service.id,
      contactName || user.name,
      contactPhone || user.phone || null,
      preferredTitle || user.preferred_title || null,
      note || null,
    );

    const booking = bookingById(insert.lastInsertRowid);
    if (!booking) throw new HttpError(500, 'Could not read back the booking.');
    return booking;
  });
}

function bookingById(id) {
  return db.get(
    `SELECT b.*, s.slot_date, s.start_time, u.name AS user_name, u.email AS user_email,
            sv.name AS service_name, sv.duration_minutes, sv.price_text,
            c.name AS category_name, c.id AS category_id
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     JOIN users u ON u.id = b.user_id
     JOIN services sv ON sv.id = b.service_id
     JOIN service_categories c ON c.id = sv.category_id
     WHERE b.id = ?`,
    id,
  );
}

function listUserBookings(userId) {
  return db.all(
    `SELECT b.id, b.status, b.created_at, b.staff_note, b.note, b.staff_action_at,
            s.slot_date, s.start_time, sv.name AS service_name, sv.duration_minutes,
            c.name AS category_name
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     JOIN services sv ON sv.id = b.service_id
     JOIN service_categories c ON c.id = sv.category_id
     WHERE b.user_id = ?
     ORDER BY (b.status IN ('pending', 'confirmed')) DESC, s.slot_date DESC, s.start_time DESC
     LIMIT 200`,
    userId,
  );
}

function cancelBooking({ bookingId, userId }) {
  return db.transaction(() => {
    const booking = db.get('SELECT id, user_id, status, slot_id FROM bookings WHERE id = ?', bookingId);
    if (!booking) throw new HttpError(404, 'Booking not found.');
    if (userId !== null && booking.user_id !== userId) throw new HttpError(403, 'That booking belongs to another account.');
    if (!ACTIVE_STATUSES.includes(booking.status)) {
      throw new HttpError(409, `This request is already ${booking.status}.`);
    }
    db.run(
      `UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
      bookingId,
    );
    return bookingById(bookingId);
  });
}

/** Staff decision: confirm, reject or cancel a request. */
function setBookingStatus({ bookingId, status, staffNote }) {
  if (!['confirmed', 'rejected', 'cancelled', 'pending'].includes(status)) {
    throw new HttpError(400, 'Unknown booking status.');
  }
  return db.transaction(() => {
    const booking = db.get('SELECT id, status, slot_id FROM bookings WHERE id = ?', bookingId);
    if (!booking) throw new HttpError(404, 'Booking not found.');

    if (ACTIVE_STATUSES.includes(status)) {
      if (activeBookingExists(booking.slot_id, booking.id)) {
        throw new HttpError(409, 'Another active booking already holds that slot.');
      }
    }
    db.run(
      `UPDATE bookings
       SET status = ?, staff_note = COALESCE(?, staff_note), staff_action_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`,
      status,
      staffNote ?? null,
      bookingId,
    );
    return bookingById(bookingId);
  });
}

function blockSlot({ date, time, blocked, reason }) {
  if (!dates.isValidDate(date) || !dates.isValidTime(time)) throw new HttpError(400, 'Pick a valid day and time first.');
  return db.transaction(() => {
    ensureDateSlots(date, { force: true });
    const slot = db.get('SELECT id, status FROM slots WHERE slot_date = ? AND start_time = ?', date, time);
    if (!slot) throw new HttpError(404, 'That slot does not exist on this date.');
    if (blocked && activeBookingExists(slot.id)) {
      throw new HttpError(409, 'That slot already has an active booking. Cancel or move it first.');
    }
    db.run('UPDATE slots SET status = ?, block_reason = ? WHERE id = ?', blocked ? 'blocked' : 'open', blocked ? reason || 'Blocked by the studio' : null, slot.id);
    return slot.id;
  });
}

function dayBookings(dateStr) {
  return db.all(
    `SELECT b.id, b.status, b.contact_name, b.contact_phone, b.preferred_title, b.note, b.staff_note,
            s.start_time, sv.name AS service_name, sv.duration_minutes, u.email AS user_email
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     JOIN services sv ON sv.id = b.service_id
     JOIN users u ON u.id = b.user_id
     WHERE s.slot_date = ? AND b.status IN ('pending','confirmed','rejected','cancelled')
     ORDER BY s.start_time`,
    dateStr,
  );
}

module.exports = {
  ACTIVE_STATUSES,
  getService,
  ensureDateSlots,
  availableSlots,
  availabilityCalendar,
  createBooking,
  bookingById,
  listUserBookings,
  cancelBooking,
  setBookingStatus,
  blockSlot,
  dayBookings,
  activeBookingCount,
  slotStarts,
};
