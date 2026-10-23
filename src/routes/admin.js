'use strict';
/**
 * Salon staff area: the booking queue, the service catalogue, weekly hours and
 * per-day slot control. Only accounts with role='admin' can reach any of it.
 */
const express = require('express');
const { config } = require('../config');
const db = require('../db');
const slots = require('../lib/slots');
const studio = require('../lib/settings');
const catalogue = require('../lib/catalogue');
const dates = require('../lib/dates');
const v = require('../lib/validate');
const { flash } = require('../lib/flash');
const { requireAdmin } = require('../lib/guards');

const router = express.Router();
router.use(requireAdmin);

const today = () => dates.salonClock().date;

function withDay(bookingRows) {
  return bookingRows.map((row) => ({
    ...row,
    timeLabel: dates.formatRange(row.start_time, row.duration_minutes),
    dayLabel: dates.formatLongDate(row.slot_date),
    isToday: row.slot_date === today(),
    isPast: row.slot_date < today(),
  }));
}

router.get('/', (req, res) => {
  const pending = withDay(
    db.all(
      `SELECT b.*, s.slot_date, s.start_time, sv.name AS service_name, sv.duration_minutes,
              c.name AS category_name, u.email AS user_email
       FROM bookings b
       JOIN slots s ON s.id = b.slot_id
       JOIN services sv ON sv.id = b.service_id
       JOIN service_categories c ON c.id = sv.category_id
       JOIN users u ON u.id = b.user_id
       WHERE b.status = 'pending'
       ORDER BY s.slot_date, s.start_time`,
    ),
  );
  const confirmed = withDay(
    db.all(
      `SELECT b.*, s.slot_date, s.start_time, sv.name AS service_name, sv.duration_minutes,
              c.name AS category_name, u.email AS user_email
       FROM bookings b
       JOIN slots s ON s.id = b.slot_id
       JOIN services sv ON sv.id = b.service_id
       JOIN service_categories c ON c.id = sv.category_id
       JOIN users u ON u.id = b.user_id
       WHERE b.status = 'confirmed' AND s.slot_date >= ?
       ORDER BY s.slot_date, s.start_time
       LIMIT 60`,
      today(),
    ),
  );
  const counts = {
    pending: pending.length,
    confirmedUpcoming: confirmed.length,
    customers: Number(db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").n),
    requestsTotal: Number(db.get('SELECT COUNT(*) AS n FROM bookings').n),
  };

  return res.render('admin/dashboard', {
    title: 'Staff dashboard',
    pending,
    confirmed,
    counts,
    day: today(),
    dayBookings: withDay(slots.dayBookings(today())),
  });
});

router.get('/bookings', (req, res) => {
  const status = ['pending', 'confirmed', 'rejected', 'cancelled', 'all'].includes(req.query.status)
    ? req.query.status
    : 'pending';
  const rows =
    status === 'all'
      ? db.all(
          `SELECT b.*, s.slot_date, s.start_time, sv.name AS service_name, sv.duration_minutes,
                  c.name AS category_name, u.email AS user_email
           FROM bookings b
           JOIN slots s ON s.id = b.slot_id
           JOIN services sv ON sv.id = b.service_id
           JOIN service_categories c ON c.id = sv.category_id
           JOIN users u ON u.id = b.user_id
           ORDER BY s.slot_date DESC, s.start_time DESC
           LIMIT 300`,
        )
      : db.all(
          `SELECT b.*, s.slot_date, s.start_time, sv.name AS service_name, sv.duration_minutes,
                  c.name AS category_name, u.email AS user_email
           FROM bookings b
           JOIN slots s ON s.id = b.slot_id
           JOIN services sv ON sv.id = b.service_id
           JOIN service_categories c ON c.id = sv.category_id
           JOIN users u ON u.id = b.user_id
           WHERE b.status = ?
           ORDER BY s.slot_date, s.start_time
           LIMIT 300`,
          status,
        );

  return res.render('admin/bookings', {
    title: 'Booking requests',
    status,
    bookings: withDay(rows),
    counts: {
      pending: Number(db.get("SELECT COUNT(*) AS n FROM bookings WHERE status='pending'").n),
      confirmed: Number(db.get("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed'").n),
      other: Number(db.get("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('rejected','cancelled')").n),
    },
  });
});

router.post('/bookings/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '');
  const note = v.normalizeMultiline(req.body.staff_note, 500);
  try {
    const booking = slots.setBookingStatus({ bookingId: id, status, staffNote: note || null });
    const label = { confirmed: 'confirmed', rejected: 'marked as unavailable', cancelled: 'cancelled', pending: 'put back in the queue' }[status];
    flash.success(req, `Request #${booking.id} (${booking.service_name}, ${dates.formatLongDate(booking.slot_date)}) was ${label}.`);
  } catch (error) {
    flash.error(req, error.status && error.status < 500 ? error.message : 'Could not update that request.');
  }
  return res.redirect(req.body.back || '/admin/bookings');
});

router.get('/day/:date', (req, res) => {
  const date = String(req.params.date);
  if (!dates.isValidDate(date)) return res.redirect('/admin');
  const prepared = slots.ensureDateSlots(date, { force: true });
  const hours = studio.dayHours(dates.weekdayOf(date));
  const dayRows = db.all(
    `SELECT s.id, s.start_time, s.status, s.block_reason,
            b.id AS booking_id, b.status AS booking_status, b.contact_name, b.contact_phone,
            b.preferred_title, b.note, b.staff_note, u.email AS user_email,
            sv.name AS service_name, sv.duration_minutes
     FROM slots s
     LEFT JOIN bookings b ON b.slot_id = s.id AND b.status IN ('pending','confirmed')
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN services sv ON sv.id = b.service_id
     WHERE s.slot_date = ?
     ORDER BY s.start_time`,
    date,
  );

  return res.render('admin/day', {
    title: `Day sheet — ${dates.formatLongDate(date)}`,
    date,
    hours,
    closed: prepared.closed || !hours || hours.closed,
    rows: dayRows.map((row) => ({
      ...row,
      timeLabel: dates.formatTime12(row.start_time),
      endLabel: dates.formatTime12(dates.minutesToHm(dates.hmToMinutes(row.start_time) + (row.duration_minutes || 0))),
      taken: Boolean(row.booking_id),
    })),
    bookings: withDay(slots.dayBookings(date)),
  });
});

router.post('/day/:date/slot', (req, res) => {
  const date = String(req.params.date);
  const time = String(req.body.start_time || '');
  const blocked = req.body.action === 'block';
  try {
    slots.blockSlot({ date, time, blocked, reason: v.normalizeText(req.body.reason, 120) });
    flash.success(req, `${dates.formatTime12(time)} on ${dates.formatLongDate(date)} is now ${blocked ? 'blocked' : 'open again'}.`);
  } catch (error) {
    flash.error(req, error.status && error.status < 500 ? error.message : 'Could not change that slot.');
  }
  return res.redirect(`/admin/day/${date}`);
});

router.get('/services', (req, res) => {
  return res.render('admin/services', {
    title: 'Service list',
    categories: catalogue.categories({ activeOnly: false, bookableOnly: false }),
    rules: studio.bookingRules(),
  });
});

router.post('/services/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.get('SELECT id, is_active FROM services WHERE id = ?', id);
  if (row) {
    db.run("UPDATE services SET is_active = 1 - is_active, updated_at = datetime('now') WHERE id = ?", id);
    flash.success(req, `“${db.get('SELECT name FROM services WHERE id = ?', id).name}” is now ${row.is_active ? 'hidden' : 'listed'}.`);
  }
  return res.redirect('/admin/services');
});

router.post('/services/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.get('SELECT id FROM services WHERE id = ?', id);
  if (!row) return res.redirect('/admin/services');

  const errors = {
    name: v.nameError(req.body.name),
    duration: null,
  };
  const minutes = Number(req.body.duration_minutes);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) {
    errors.duration = 'Duration must be between 15 and 480 minutes.';
  }
  const clean = Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
  if (Object.keys(clean).length) {
    flash.error(req, Object.values(clean).join(' '));
    return res.redirect('/admin/services');
  }

  db.run(
    `UPDATE services
     SET name = ?, description = ?, duration_minutes = ?, price_text = ?, is_bookable = ?, updated_at = datetime('now')
     WHERE id = ?`,
    v.normalizeText(req.body.name, 80),
    v.normalizeMultiline(req.body.description, 400) || null,
    minutes,
    v.normalizeText(req.body.price_text, 60) || null,
    req.body.is_bookable ? 1 : 0,
    id,
  );
  flash.success(req, 'Service updated.');
  return res.redirect('/admin/services');
});

router.post('/categories/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.get('SELECT id, is_active, name FROM service_categories WHERE id = ?', id);
  if (row) {
    db.run('UPDATE service_categories SET is_active = 1 - is_active WHERE id = ?', id);
    flash.success(req, `“${row.name}” is now ${row.is_active ? 'hidden' : 'listed'}.`);
  }
  return res.redirect('/admin/services');
});

router.get('/hours', (req, res) => {
  return res.render('admin/hours', {
    title: 'Studio hours',
    week: studio.allWeekHours().map((row) => ({ ...row, label: dates.WEEKDAY_LABELS[row.weekday] })),
    settings: [
      { key: 'slot_step_minutes', label: 'Minutes between slots', hint: 'How far apart two appointment start times are.' },
      { key: 'booking_horizon_days', label: 'Days ahead that can be booked', hint: 'Customers cannot see dates beyond this.' },
      { key: 'lead_time_minutes', label: 'Minimum notice in minutes', hint: 'Blocks same-day booking closer than this.' },
      { key: 'max_active_bookings_per_user', label: 'Open bookings per account', hint: 'Keeps one person from holding many slots.' },
    ].map((item) => ({ ...item, value: studio.getSetting(item.key) })),
  });
});

router.post('/hours', (req, res) => {
  const weekday = Number(req.body.weekday);
  if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
    try {
      studio.saveWeekHours(weekday, {
        isClosed: req.body.is_closed === '1',
        opensAt: v.normalizeText(req.body.opens_at, 5),
        closesAt: v.normalizeText(req.body.closes_at, 5),
        note: v.normalizeText(req.body.note, 120),
      });
      flash.success(req, `${dates.WEEKDAY_LABELS[weekday]} timings saved.`);
    } catch (error) {
      flash.error(req, error.message);
    }
  }
  return res.redirect('/admin/hours');
});

router.post('/settings', (req, res) => {
  const allowed = ['slot_step_minutes', 'booking_horizon_days', 'lead_time_minutes', 'max_active_bookings_per_user'];
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    const parsed = Number.parseInt(req.body[key], 10);
    if (!Number.isFinite(parsed)) {
      flash.error(req, `“${key}” needs a whole number.`);
      continue;
    }
    studio.setSetting(key, parsed);
  }
  flash.success(req, 'Booking settings saved.');
  return res.redirect('/admin/hours');
});

router.get('/customers/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.get(
    `SELECT id, name, email, phone, preferred_title, notes, created_at, last_login_at, role FROM users WHERE id = ?`,
    id,
  );
  if (!user) {
    res.status(404);
    return res.render('errors/404', { title: 'No such customer' });
  }
  const bookings = slots.listUserBookings(id);
  return res.render('admin/customer', {
    title: `Customer — ${user.name}`,
    customer: user,
    bookings: bookings.map((row) => ({
      ...row,
      dayLabel: dates.formatLongDate(row.slot_date),
      timeLabel: dates.formatRange(row.start_time, row.duration_minutes),
    })),
    phone: config.salon.phone,
  });
});

module.exports = router;
