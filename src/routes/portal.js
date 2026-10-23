'use strict';
/**
 * The salon's staff portal.
 *
 * Separate from the customer site on purpose: its own chrome, its own
 * stylesheet, and no link a customer is offered. The separation is cosmetic —
 * the access control is not. `requireAdmin` runs before every route below, and
 * it re-reads the account from the database on each request, so a session that
 * belonged to a staff member who has since been demoted or deactivated cannot
 * open a single booking record. Nothing here trusts a browser-side role.
 *
 * Data is live: bookings, customers, hours and the studio clock all come from
 * the same SQLite database the public booking flow writes to.
 */
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

const { config } = require('../config');
const db = require('../db');
const dates = require('../lib/dates');
const studio = require('../lib/settings');
const slots = require('../lib/slots');
const records = require('../lib/records');
const v = require('../lib/validate');
const { flash } = require('../lib/flash');
const { requireAdmin } = require('../lib/guards');

const router = express.Router();

const NAV = [
  { href: '/portal', label: 'Dashboard' },
  { href: '/portal/bookings', label: 'Bookings' },
  { href: '/portal/customers', label: 'Customers' },
  { href: '/portal/settings', label: 'Hours & settings' },
  { href: '/portal/services', label: 'Services' },
];

const STATUS_LABELS = {
  pending: 'put back in the queue',
  confirmed: 'confirmed',
  completed: 'marked as served',
  rejected: 'declined',
  cancelled: 'cancelled',
};

/**
 * Guard every route, including the POSTs. A hidden button is not access
 * control; this is the only thing standing between a customer session and the
 * diary of every other client.
 */
router.use((req, res, next) => {
  requireAdmin(req, res, () => {
    res.locals.portalNav = NAV;
    res.locals.portalZone = dates.zoneLabel();
    res.locals.portalZoneTag = dates.zoneTag();
    res.locals.portalClock = dates.salonClock();
    res.locals.portalStatusCounts = records.statusCounts();
    res.locals.portalCssVersion = portalAssetVersion();
    next();
  });
});

function portalAssetVersion() {
  try {
    return String(Math.floor(fs.statSync(path.join(config.root, 'public', 'portal.css')).mtimeMs));
  } catch {
    return String(Date.now());
  }
}

/** Only ever redirect back into the portal, and never through a control character. */
function safeBack(value, fallback) {
  const target = String(value || '').replace(/[\r\n\0]/g, '');
  if (target === '/portal' || target.startsWith('/portal/')) return target;
  return fallback;
}

function page(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

// ---------------------------------------------------------------- dashboard
router.get('/', (req, res) => {
  return res.render('portal/dashboard', {
    title: 'Dashboard',
    view: 'dashboard',
    snap: records.dashboardSnapshot(),
    day: dates.salonClock().date,
  });
});

// ----------------------------------------------------------------- bookings
router.get('/bookings', (req, res) => {
  const result = records.searchBookings({
    term: req.query.q,
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    sort: req.query.sort,
    page: page(req.query.page),
  });
  return res.render('portal/bookings', {
    title: 'Bookings',
    view: 'bookings',
    result,
    statuses: records.STATUSES,
  });
});

router.get('/bookings/:id(\\d+)', (req, res) => {
  const booking = records.bookingForStaff(req.params.id);
  if (!booking) {
    res.status(404);
    return res.render('portal/not-found', { title: 'No such booking', view: 'bookings', back: '/portal/bookings' });
  }
  const account = records.customerForStaff(booking.user_id);
  return res.render('portal/booking', {
    title: `Booking #${booking.id}`,
    view: 'bookings',
    booking,
    statuses: records.STATUSES,
    account,
    history: account ? account.bookings.filter((row) => row.id !== booking.id) : [],
  });
});

router.post('/bookings/:id(\\d+)/status', (req, res) => {
  const back = safeBack(req.body.back, '/portal/bookings');
  const status = String(req.body.status || '');
  if (!records.STATUSES.includes(status)) {
    flash.error(req, 'That is not a status the diary keeps. Choose one of the buttons.');
    return res.redirect(back);
  }
  try {
    const booking = slots.setBookingStatus({
      bookingId: Number(req.params.id),
      status,
      staffNote: v.normalizeMultiline(req.body.staff_note, 500) || null,
    });
    flash.success(
      req,
      `Request #${booking.id} — ${booking.contact_name}, ${booking.service_name}, ` +
        `${dates.formatLongDate(booking.slot_date)} ${dates.formatTime12(booking.start_time)} — ${STATUS_LABELS[status]}.`,
    );
  } catch (error) {
    const expected = error.status && error.status < 500;
    flash.error(req, expected ? error.message : 'Could not update that request. Nothing was changed — try again.');
  }
  return res.redirect(back);
});

// ---------------------------------------------------------------- customers
router.get('/customers', (req, res) => {
  const result = records.searchCustomers({
    term: req.query.q,
    filter: req.query.filter,
    sort: req.query.sort,
    page: page(req.query.page),
  });
  return res.render('portal/customers', { title: 'Customers', view: 'customers', result });
});

router.get('/customers/:id(\\d+)', (req, res) => {
  const customer = records.customerForStaff(req.params.id);
  if (!customer) {
    res.status(404);
    return res.render('portal/not-found', { title: 'No such account', view: 'customers', back: '/portal/customers' });
  }
  return res.render('portal/customer', { title: customer.name, view: 'customers', customer });
});

// ---------------------------------------------------------------- day sheet
router.get('/day/:date', (req, res) => {
  const date = String(req.params.date);
  if (!dates.isValidDate(date)) return res.redirect('/portal');
  const prepared = slots.ensureDateSlots(date, { force: true });
  const hours = studio.dayHours(dates.weekdayOf(date));
  return res.render('portal/day', {
    title: 'Day sheet',
    view: 'day',
    date,
    hours,
    closed: prepared.closed || !hours || hours.closed,
    rows: records.dayRows(date),
    agenda: slots.dayBookings(date).map(records.decorate),
    statuses: records.STATUSES,
    week: dates.addDays(date, -3),
  });
});

router.post('/day/:date(\\d{4}-\\d{2}-\\d{2})/slot', (req, res) => {
  const date = String(req.params.date);
  const time = String(req.body.start_time || '');
  const blocked = req.body.action === 'block';
  try {
    slots.blockSlot({ date, time, blocked, reason: v.normalizeText(req.body.reason, 120) });
    flash.success(
      req,
      `${dates.formatTime12(time)} on ${dates.formatLongDate(date)} is now ${blocked ? 'blocked — customers cannot pick it' : 'open again'}.`,
    );
  } catch (error) {
    const expected = error.status && error.status < 500;
    flash.error(req, expected ? error.message : 'Could not change that time. Nothing was blocked.');
  }
  return res.redirect(safeBack(req.body.back, `/portal/day/${date}`));
});

// ----------------------------------------------------------------- services
router.get('/services', (req, res) => {
  return res.render('portal/services', {
    title: 'Services',
    view: 'services',
    groups: records.serviceBoard(),
    rules: studio.bookingRules(),
  });
});

router.post('/services/:id(\\d+)/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.get('SELECT id, is_active, name FROM services WHERE id = ?', id);
  if (row) {
    db.run("UPDATE services SET is_active = 1 - is_active, updated_at = datetime('now') WHERE id = ?", id);
    flash.success(req, `“${row.name}” is now ${row.is_active ? 'hidden from the website' : 'listed on the website'}.`);
  } else {
    flash.error(req, 'That service no longer exists.');
  }
  return res.redirect('/portal/services');
});

router.post('/services/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  if (!db.get('SELECT id FROM services WHERE id = ?', id)) {
    flash.error(req, 'That service no longer exists.');
    return res.redirect('/portal/services');
  }
  const errors = [v.nameError(req.body.name)];
  const minutes = Number(req.body.duration_minutes);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) {
    errors.push('Chair time has to be a whole number of minutes between 15 and 480.');
  }
  const problems = errors.filter(Boolean);
  if (problems.length) {
    flash.error(req, problems.join(' '));
    return res.redirect('/portal/services');
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
  flash.success(req, `“${v.normalizeText(req.body.name, 80)}” saved.`);
  return res.redirect('/portal/services');
});

router.post('/categories/:id(\\d+)/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.get('SELECT id, is_active, name FROM service_categories WHERE id = ?', id);
  if (row) {
    db.run('UPDATE service_categories SET is_active = 1 - is_active WHERE id = ?', id);
    flash.success(req, `“${row.name}” is now ${row.is_active ? 'hidden' : 'shown'} on the website.`);
  } else {
    flash.error(req, 'That group no longer exists.');
  }
  return res.redirect('/portal/services');
});

// --------------------------------------------------------- hours and clocks
/**
 * The booking tunables, with the bounds studio/HARD_LIMITS enforces on read.
 * One list feeds the form and the POST, so the range a staff member is told is
 * the range the server actually accepts.
 */
const RULE_FIELDS = [
  { key: 'slot_step_minutes', valueKey: 'stepMinutes', label: 'Minutes between slots', hint: 'How far apart two appointment start times are.' },
  { key: 'booking_horizon_days', valueKey: 'horizonDays', label: 'Days ahead that can be booked', hint: 'Customers cannot see dates beyond this.' },
  { key: 'lead_time_minutes', valueKey: 'leadMinutes', label: 'Minimum notice in minutes', hint: 'Blocks a same-day booking closer than this.' },
  { key: 'max_active_bookings_per_user', valueKey: 'maxActivePerUser', label: 'Open bookings per account', hint: 'Stops one person holding several slots.' },
].map((field) => ({ ...field, min: studio.HARD_LIMITS[field.key][0], max: studio.HARD_LIMITS[field.key][1] }));

router.get('/settings', (req, res) => {
  const rules = studio.bookingRules();
  return res.render('portal/settings', {
    title: 'Hours & settings',
    view: 'settings',
    week: studio.allWeekHours().map((row) => ({ ...row, label: dates.WEEKDAY_LABELS[row.weekday] })),
    rules,
    zone: {
      current: studio.timeZone(),
      saved: studio.hasSavedTimeZone(),
      tag: dates.zoneTag(),
      offset: dates.zoneOffset(),
      abbreviation: dates.zoneAbbreviation(),
      presets: studio.timeZonePresets(),
      envDefault: config.salon.timezone,
      clock: dates.salonClock(),
      utcNow: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    },
    ruleFields: RULE_FIELDS.map((field) => ({ ...field, value: rules[field.valueKey] })),
  });
});

router.post('/settings/timezone', (req, res) => {
  const wanted = v.normalizeText(req.body.time_zone, 64);
  try {
    studio.saveTimeZone(wanted);
    flash.success(req, `The salon clock now runs on ${wanted} — ${dates.zoneTag()}. Every time in the portal and on the website is read on it.`);
  } catch (error) {
    flash.error(req, `${error.message} “${wanted || '(empty)'}” was not saved; the clock is still ${studio.timeZone()}.`);
  }
  return res.redirect('/portal/settings');
});

router.post('/settings/rules', (req, res) => {
  const rejected = [];
  for (const field of RULE_FIELDS) {
    if (req.body[field.key] === undefined) continue;
    const text = String(req.body[field.key]).trim();
    if (!/^\d+$/.test(text)) {
      rejected.push(`${field.label} — “${text || '(blank)'}” is not a whole number`);
      continue;
    }
    const parsed = Number.parseInt(text, 10);
    if (parsed < field.min || parsed > field.max) {
      rejected.push(`${field.label} — use ${field.min} to ${field.max}`);
      continue;
    }
    studio.setSetting(field.key, parsed);
  }
  if (rejected.length) {
    flash.error(req, `Left alone because they are out of range: ${rejected.join('; ')}.`);
  } else {
    const rules = studio.bookingRules();
    flash.success(
      req,
      `Booking rules saved: slots every ${rules.stepMinutes} min, ` +
        `${rules.horizonDays} days ahead, ${rules.leadMinutes} min notice.`,
    );
  }
  return res.redirect('/portal/settings');
});

router.post('/settings/hours', (req, res) => {
  const weekday = Number(req.body.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    flash.error(req, 'That day of the week is not on the calendar.');
    return res.redirect('/portal/settings');
  }
  try {
    studio.saveWeekHours(weekday, {
      isClosed: req.body.is_closed === '1',
      opensAt: v.normalizeText(req.body.opens_at, 5),
      closesAt: v.normalizeText(req.body.closes_at, 5),
      note: v.normalizeText(req.body.note, 120),
    });
    flash.success(req, `${dates.WEEKDAY_LABELS[weekday]} timings saved. New bookings follow them from now on.`);
  } catch (error) {
    flash.error(req, `${error.message} ${dates.WEEKDAY_LABELS[weekday]} was left as it was.`);
  }
  return res.redirect('/portal/settings');
});

module.exports = router;
