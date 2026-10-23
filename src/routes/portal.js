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
const users = require('../lib/users');
const v = require('../lib/validate');
const ticket = require('../lib/ticket');
const { wrap } = require('../lib/async');
const { flash } = require('../lib/flash');
const { requireAdmin } = require('../lib/guards');

const router = express.Router();

const NAV = [
  { href: '/portal', label: 'Dashboard' },
  { href: '/portal/bookings', label: 'Bookings' },
  { href: '/portal/customers', label: 'Customers' },
  { href: '/portal/services', label: 'Services' },
  { href: '/portal/settings', label: 'Hours & settings' },
  { href: '/portal/details', label: 'Site details' },
  { href: '/portal/staff', label: 'Staff logins' },
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

router.post('/bookings/:id(\\d+)/status', wrap(async (req, res) => {
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
    // Only after the status has committed: a ticket that fails to write must
    // never undo the confirmation the studio just made.
    if (status === 'confirmed') {
      try {
        await ticket.issue(booking.id);
        flash.success(req, `Ticket #${booking.id} is ready for the customer to download.`);
      } catch (error) {
        flash.error(
          req,
          `Request #${booking.id} is confirmed, but its ticket could not be written (${error.message}). `
            + "The customer's download link will try again.",
        );
      }
    }
  } catch (error) {
    const expected = error.status && error.status < 500;
    flash.error(req, expected ? error.message : 'Could not update that request. Nothing was changed — try again.');
  }
  return res.redirect(back);
}));

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

// -------------------------------------------------------------- site details
/**
 * The business details a studio would otherwise edit in `.env`. A saved row wins
 * over the environment variable of the same name, and clearing a box hands that
 * value back to `.env` — which is why every field says where it is coming from.
 *
 * Secrets are deliberately not on this form. A session-signing key or an SMTP
 * password typed into a web page ends up inside a database file that gets
 * copied and backed up, so those stay in the environment.
 */
router.get('/details', (req, res) => {
  const saved = studio.savedDetailKeys();
  const current = studio.salonDetails();
  return res.render('portal/details', {
    title: 'Site details',
    view: 'details',
    fields: studio.DETAIL_FIELDS.map((field) => ({
      ...field,
      envName: field.key.toUpperCase(),
      envValue: studio.baseDetail(field.field),
      value: current[field.field],
      saved: saved.has(field.key),
    })),
    wiring: {
      sessionSecret: config.session.secret ? 'set from .env' : 'not set — using the development fallback',
      smtp: config.mail.host ? `host ${config.mail.host}` : 'no SMTP_HOST in .env',
      publicUrl: config.http.publicUrl,
      databaseFile: config.db.file,
    },
  });
});

router.post('/details', (req, res) => {
  const problems = [];
  const values = {};

  for (const field of studio.DETAIL_FIELDS) {
    const raw = req.body[field.key];
    if (raw === undefined) continue;
    const text = String(raw).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();

    if (!text) {
      // An empty box means "hand this one back to .env", which is only safe when
      // there is something to hand back to. `required` fields are rendered on
      // every page, so they may not end up blank in either layer.
      if (field.required && !studio.baseDetail(field.field)) {
        problems.push(
          `${field.label} cannot be empty — it is used in the header, the page title and every mail the studio sends, and there is no .env value to fall back on`,
        );
        continue;
      }
      values[field.key] = '';
      continue;
    }
    if (text.length > field.max) {
      problems.push(`${field.label} is ${text.length} characters; the limit is ${field.max}`);
      continue;
    }

    let error = null;
    if (field.phone) error = v.phoneError(text, { required: true });
    else if (field.email) error = v.emailError(text);
    else if (field.url && !/^https?:\/\/\S+$/i.test(text)) error = 'The Maps link has to start with http:// or https://';
    else if (field.year && !/^\d{4}$/.test(text)) error = 'Use a four-digit year, like 2018';
    else if (field.year && (Number(text) < 1900 || Number(text) > new Date().getFullYear() + 1)) {
      error = `That year is not believable — use 1900 to ${new Date().getFullYear() + 1}`;
    }
    if (error) {
      problems.push(`${field.label} — ${error}`);
      continue;
    }
    values[field.key] = v.normalizeText(text, field.max);
  }

  const written = studio.saveSalonDetails(values);
  if (!written.length) {
    flash.error(req, problems.length ? `Nothing was saved. ${problems.join(' ')}` : 'Nothing changed — every box already held that value.');
    return res.redirect('/portal/details');
  }
  const now = studio.salonDetails();
  flash.success(
    req,
    `Saved ${written.join(', ')}. The header now reads “${now.name}”, the call button dials ${now.phone},` +
      ' and the mails carry the same details. ' +
      (problems.length ? `Left as they were: ${problems.join(' ')}` : ''),
  );
  return res.redirect('/portal/details');
});

// -------------------------------------------------------------- staff logins
/**
 * Staff accounts, managed by a staff account. This replaces the terminal-only
 * rule the portal used to state: creating a login here still requires an
 * already-authenticated admin plus a valid CSRF token, so it is not a route an
 * outsider can walk up to — but the studio no longer needs shell access to hand
 * the diary to a second person.
 */
router.get('/staff', (req, res) => {
  const staff = users.listStaff().map((row) => ({
    ...row,
    joinedLabel: dates.formatStamp(row.created_at),
    signedInLabel: row.last_login_at ? dates.formatStamp(row.last_login_at) : null,
    signedInIso: row.last_login_at ? dates.stampToIso(row.last_login_at) : null,
  }));
  return res.render('portal/staff', {
    title: 'Staff logins',
    view: 'staff',
    staff,
    accountTotal: users.count(),
    activeAdmins: users.countAdmins(),
    selfId: res.locals.currentUser ? res.locals.currentUser.id : null,
  });
});

function staffOrNull(req, res, id) {
  const target = users.findById(id);
  if (!target || target.role !== 'admin') {
    flash.error(req, 'There is no staff login with that number. It may have been removed.');
    return null;
  }
  return target;
}

/** True when removing this account's access would leave the portal shut for everyone. */
function isLastActiveAdmin(target) {
  return target.role === 'admin' && target.is_active && users.countAdmins() <= 1;
}

router.post('/staff', async (req, res, next) => {
  const email = v.normalizeEmail(req.body.email);
  const name = v.normalizeText(req.body.name, 80) || 'Salon team';
  const password = String(req.body.password || '');

  const problems = [];
  if (!email) problems.push('Enter the email address this person will sign in with.');
  else if (v.emailError(email)) problems.push(v.emailError(email));
  if (password) {
    const error = v.passwordError(password, { email, name });
    if (error) problems.push(`The staff password — ${error}`);
  }
  if (problems.length) {
    flash.error(req, problems.join(' '));
    return res.redirect('/portal/staff');
  }

  const self = res.locals.currentUser;
  const existing = email ? users.findByEmail(email) : null;

  try {
    if (existing && existing.role === 'admin') {
      flash.info(req, `${email} is already a staff login. Nothing was changed.`);
      return res.redirect('/portal/staff');
    }

    if (existing && !password) {
      // Promote the account the way the terminal script does: the person keeps
      // the password they already chose, so no secret is invented here.
      const outcome = await users.promote(email, name, null);
      flash.success(
        req,
        `${outcome.user.email} is now a staff login and still signs in with the password they already had. ` +
          'Use “Set a new password” on their row if you wanted to change it.',
      );
      return res.redirect('/portal/staff');
    }

    if (existing && self && existing.id === self.id) {
      flash.error(req, 'That is your own login. Change your password from your account page, not from here.');
      return res.redirect('/portal/staff');
    }

    if (existing) {
      await users.changePassword(existing.id, password);
      const outcome = await users.promote(email, name, null);
      flash.success(
        req,
        `${outcome.user.email} is a staff login with the new password set. Every other device signed in as them ` +
          'was signed out, and their outstanding reset links were dropped.',
      );
      return res.redirect('/portal/staff');
    }

    if (!password) {
      flash.error(req, `No account exists for ${email} yet, so the new staff login needs a password ` +
        '— at least 10 characters, with a letter and a number.');
      return res.redirect('/portal/staff');
    }

    const created = await users.createStaff({ email, name, password });
    flash.success(
      req,
      `Staff login #${created.id} made for ${created.email}. They sign in at the same address as a customer ` +
        'and the portal opens for them straight away.',
    );
    return res.redirect('/portal/staff');
  } catch (error) {
    if (error && error.status && error.status < 500) {
      flash.error(req, error.message);
      return res.redirect('/portal/staff');
    }
    return next(error);
  }
});

router.post('/staff/:id(\\d+)/password', async (req, res, next) => {
  const target = staffOrNull(req, res, Number(req.params.id));
  if (!target) return res.redirect('/portal/staff');
  const self = res.locals.currentUser;
  if (self && self.id === target.id) {
    flash.error(req, 'That is your own login — change it from your account page so you stay signed in.');
    return res.redirect('/portal/staff');
  }
  const password = String(req.body.password || '');
  const error = v.passwordError(password, { email: target.email, name: target.name });
  if (error) {
    flash.error(req, `The password was not changed. ${error}`);
    return res.redirect('/portal/staff');
  }
  try {
    await users.changePassword(target.id, password);
    flash.success(req, `A new password is set for ${target.email}. Hand it over and ask them to sign in again.`);
  } catch (inner) {
    return next(inner);
  }
  return res.redirect('/portal/staff');
});

router.post('/staff/:id(\\d+)/active', (req, res) => {
  const target = staffOrNull(req, res, Number(req.params.id));
  if (!target) return res.redirect('/portal/staff');
  const self = res.locals.currentUser;
  const turningOff = target.is_active === 1;

  if (turningOff && self && self.id === target.id) {
    flash.error(req, 'You cannot deactivate the login you are using — that would close the portal on you mid-shift.');
    return res.redirect('/portal/staff');
  }
  if (turningOff && isLastActiveAdmin(target)) {
    flash.error(req, 'This is the last working staff login. Nobody would be left who can open the diary, so it stays active.');
    return res.redirect('/portal/staff');
  }

  const updated = users.setActive(target.id, !turningOff);
  flash.success(
    req,
    turningOff
      ? `${updated.email} can no longer sign in, and the sessions they had open were dropped. Their bookings and account history stay in the diary.`
      : `${updated.email} can sign in again as staff. They will need to log in afresh.`,
  );
  return res.redirect('/portal/staff');
});

router.post('/staff/:id(\\d+)/role', (req, res) => {
  const target = staffOrNull(req, res, Number(req.params.id));
  if (!target) return res.redirect('/portal/staff');
  const self = res.locals.currentUser;
  if (self && self.id === target.id) {
    flash.error(req, 'You cannot take your own staff role off — that would lock you out of this page.');
    return res.redirect('/portal/staff');
  }
  if (isLastActiveAdmin(target)) {
    flash.error(req, 'This is the last working staff login, so it cannot be turned back into a customer account.');
    return res.redirect('/portal/staff');
  }
  const updated = users.setRole(target.id, 'customer');
  flash.success(
    req,
    `${updated.email} is a customer account again and was signed out of the portal. Their bookings are still in the diary.`,
  );
  return res.redirect('/portal/staff');
});

module.exports = router;
