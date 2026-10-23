'use strict';
/**
 * Reads for the staff portal.
 *
 * Everything here is admin-only data, so two rules hold throughout: customer
 * rows are listed column by column and never touch `password_hash`, and every
 * value that arrives from a request goes in as a bound parameter. The handful
 * of pieces of SQL that are built from strings (sort order, status filter) pick
 * from an allowlist, never from the caller's text.
 */
const db = require('../db');
const dates = require('./dates');
const slots = require('./slots');

const STATUSES = slots.BOOKING_STATUSES;
const PER_PAGE = 25;

const BOOKING_FROM = `
  FROM bookings b
  JOIN slots s ON s.id = b.slot_id
  JOIN services sv ON sv.id = b.service_id
  JOIN service_categories c ON c.id = sv.category_id
  JOIN users u ON u.id = b.user_id`;

const BOOKING_COLUMNS = `
  SELECT b.id, b.status, b.contact_name, b.contact_phone, b.preferred_title,
         b.note, b.staff_note, b.staff_action_at, b.created_at, b.updated_at,
         b.user_id, b.slot_id, b.service_id,
         s.slot_date, s.start_time, s.status AS slot_status, s.block_reason,
         sv.name AS service_name, sv.duration_minutes, sv.price_text,
         c.name AS category_name, c.slug AS category_slug,
         u.email AS user_email, u.role AS user_role${BOOKING_FROM}`;

const SORTS = {
  newest: 'ORDER BY b.created_at DESC, b.id DESC',
  oldest: 'ORDER BY b.created_at ASC, b.id ASC',
  soonest: 'ORDER BY s.slot_date ASC, s.start_time ASC',
  latest: 'ORDER BY s.slot_date DESC, s.start_time DESC',
};

/** Percent and underscore are pattern characters; a search box means them literally. */
function likePattern(raw) {
  const escaped = String(raw).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

function digitsOf(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function decorate(row) {
  const iso = dates.slotToIso(row.slot_date, row.start_time);
  const today = dates.salonClock().date;
  return {
    ...row,
    dayLabel: dates.formatLongDate(row.slot_date),
    shortDay: dates.formatShortDate(row.slot_date),
    timeLabel: dates.formatRange(row.start_time, row.duration_minutes),
    startLabel: dates.formatTime12(row.start_time),
    whenIso: iso,
    submittedLabel: dates.formatStamp(row.created_at),
    submittedIso: dates.stampToIso(row.created_at),
    actionLabel: row.staff_action_at ? dates.formatStamp(row.staff_action_at) : null,
    actionIso: row.staff_action_at ? dates.stampToIso(row.staff_action_at) : null,
    isToday: row.slot_date === today,
    isPast: row.slot_date < today,
    isUpcoming: row.slot_date >= today,
  };
}

function whereSql(clauses) {
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * Bookings with search, status, date-range and paging. `term` matches the name
 * the client booked under, their phone (with or without spaces), the account
 * email, the service, either note, or the booking number.
 */
function searchBookings({ term = '', status = 'all', from = '', to = '', sort = 'newest', page = 1, perPage = PER_PAGE } = {}) {
  const clauses = [];
  const params = [];

  const wanted = STATUSES.includes(status) ? status : 'all';
  if (wanted !== 'all') {
    clauses.push('b.status = ?');
    params.push(wanted);
  }

  const cleanTerm = String(term || '').trim().slice(0, 120);
  if (cleanTerm) {
    const like = likePattern(cleanTerm);
    const or = [
      'b.contact_name LIKE ? ESCAPE \'\\\'',
      'u.email LIKE ? ESCAPE \'\\\'',
      'sv.name LIKE ? ESCAPE \'\\\'',
      'COALESCE(b.note, \'\') LIKE ? ESCAPE \'\\\'',
      'COALESCE(b.staff_note, \'\') LIKE ? ESCAPE \'\\\'',
      'REPLACE(REPLACE(COALESCE(b.contact_phone, \'\'), \'+\', \'\'), \' \', \'\') LIKE ? ESCAPE \'\\\'',
    ];
    params.push(like, like, like, like, like, like);
    const numeric = digitsOf(cleanTerm);
    if (numeric) {
      or.push('CAST(b.id AS TEXT) = ?');
      params.push(numeric);
    }
    clauses.push(`(${or.join(' OR ')})`);
  }

  if (dates.isValidDate(from)) {
    clauses.push('s.slot_date >= ?');
    params.push(from);
  }
  if (dates.isValidDate(to)) {
    clauses.push('s.slot_date <= ?');
    params.push(to);
  }

  const where = whereSql(clauses);
  const totalRow = db.get(`SELECT COUNT(*) AS n${BOOKING_FROM}${where}`, ...params);
  const total = Number(totalRow ? totalRow.n : 0);
  const size = Math.max(5, Math.min(100, Number(perPage) || PER_PAGE));
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);

  const rows = db.all(
    `${BOOKING_COLUMNS}${where} ${SORTS[sort] || SORTS.newest} LIMIT ? OFFSET ?`,
    ...params,
    size,
    (current - 1) * size,
  );

  return {
    rows: rows.map(decorate),
    total,
    page: current,
    pages,
    perPage: size,
    from: (current - 1) * size + 1,
    to: Math.min(total, current * size),
    status: wanted,
    term: cleanTerm,
    sort: SORTS[sort] ? sort : 'newest',
    dateFrom: dates.isValidDate(from) ? from : '',
    dateTo: dates.isValidDate(to) ? to : '',
  };
}

function bookingForStaff(id) {
  const row = db.get(`${BOOKING_COLUMNS} WHERE b.id = ?`, Number(id));
  return row ? decorate(row) : null;
}

/** One number per status, plus the total — used by tabs and the dashboard. */
function statusCounts() {
  const rows = db.all('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status');
  const counts = { all: 0 };
  for (const status of STATUSES) counts[status] = 0;
  for (const row of rows) {
    counts[row.status] = Number(row.n);
    counts.all += Number(row.n);
  }
  return counts;
}

/**
 * Numbers for the dashboard. Every figure is a real count from the live
 * database; nothing here is estimated and nothing is invented.
 */
function dashboardSnapshot() {
  const today = dates.salonClock().date;
  const weekAhead = dates.addDays(today, 6);
  const weekBehind = dates.addDays(today, -6);

  return {
    day: today,
    counts: statusCounts(),
    todayBookings: slots.dayBookings(today).map(decorate),
    upcomingConfirmed: db.all(
      `${BOOKING_COLUMNS} WHERE b.status = 'confirmed' AND s.slot_date BETWEEN ? AND ?
       ORDER BY s.slot_date, s.start_time LIMIT 12`,
      today,
      weekAhead,
    ).map(decorate),
    waiting: db.all(`${BOOKING_COLUMNS} WHERE b.status = 'pending' ORDER BY b.created_at ASC LIMIT 8`).map(decorate),
    servedThisWeek: Number(db.get(
      `SELECT COUNT(*) AS n FROM bookings b JOIN slots s ON s.id = b.slot_id
       WHERE b.status = 'completed' AND s.slot_date BETWEEN ? AND ?`,
      weekBehind, today,
    ).n),
    requestsThisWeek: Number(db.get(
      "SELECT COUNT(*) AS n FROM bookings WHERE created_at >= datetime('now', '-7 days')",
    ).n),
    signedInRecently: Number(db.get(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'customer' AND last_login_at >= datetime('now', '-30 days')",
    ).n),
    accounts: Number(db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").n),
    staffAccounts: Number(db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").n),
    oldestWait: db.get(
      "SELECT b.id, b.created_at, s.slot_date FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE b.status = 'pending' ORDER BY b.created_at ASC LIMIT 1",
    ),
  };
}

const CUSTOMER_COLUMNS = `
  SELECT u.id, u.name, u.email, u.phone, u.preferred_title, u.notes, u.role, u.is_active,
         u.created_at, u.last_login_at,
         (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id) AS booking_count,
         (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('pending','confirmed')) AS open_count,
         (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'completed') AS served_count,
         (SELECT MIN(s.slot_date) FROM bookings b JOIN slots s ON s.id = b.slot_id
           WHERE b.user_id = u.id AND b.status = 'confirmed' AND s.slot_date >= ?) AS next_day,
         (SELECT MAX(s.slot_date) FROM bookings b JOIN slots s ON s.id = b.slot_id
           WHERE b.user_id = u.id AND b.status = 'completed') AS last_served
  FROM users u`;

const CUSTOMER_SORTS = {
  recent: 'ORDER BY (u.last_login_at IS NULL), u.last_login_at DESC, u.id DESC',
  earliest: 'ORDER BY u.created_at ASC, u.id ASC',
  name: 'ORDER BY u.name COLLATE NOCASE ASC',
  bookings: 'ORDER BY booking_count DESC, (u.last_login_at IS NULL), u.last_login_at DESC',
};

/**
 * The roster of accounts. `filter` is an allowlist key, not free text; the
 * password column is not in the select list at all.
 * `today` is bound once for the next-appointment subquery.
 */
function searchCustomers({ term = '', filter = 'all', sort = 'recent', page = 1, perPage = PER_PAGE } = {}) {
  const today = dates.salonClock().date;
  const clauses = [];
  const params = [today]; // first positional belongs to the SELECT subquery

  const cleanTerm = String(term || '').trim().slice(0, 120);
  if (cleanTerm) {
    const like = likePattern(cleanTerm);
    const or = ['u.name LIKE ? ESCAPE \'\\\'', 'u.email LIKE ? ESCAPE \'\\\'',
      'REPLACE(REPLACE(COALESCE(u.phone, \'\'), \'+\', \'\'), \' \', \'\') LIKE ? ESCAPE \'\\\''];
    params.push(like, like, like);
    const numeric = digitsOf(cleanTerm);
    if (numeric) {
      or.push('CAST(u.id AS TEXT) = ?');
      params.push(numeric);
    }
    clauses.push(`(${or.join(' OR ')})`);
  }

  const filters = {
    all: null,
    signed_in: 'u.last_login_at IS NOT NULL',
    never: 'u.last_login_at IS NULL',
    open_bookings: "(SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('pending','confirmed')) > 0",
    served: "u.id IN (SELECT b.user_id FROM bookings b WHERE b.status = 'completed')",
    silent: "u.last_login_at IS NOT NULL AND u.last_login_at < datetime('now', '-180 days')",
    staff: "u.role = 'admin'",
  };
  const picked = filters[filter] ? filter : 'all';
  if (filters[picked]) clauses.push(filters[picked]);

  const where = whereSql(clauses);
  const totalRow = db.get(`SELECT COUNT(*) AS n FROM users u${where}`, ...params.slice(1));
  const total = Number(totalRow ? totalRow.n : 0);
  const size = Math.max(5, Math.min(100, Number(perPage) || PER_PAGE));
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);

  const rows = db.all(
    `${CUSTOMER_COLUMNS}${where} ${CUSTOMER_SORTS[sort] || CUSTOMER_SORTS.recent} LIMIT ? OFFSET ?`,
    ...params,
    size,
    (current - 1) * size,
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      booking_count: Number(row.booking_count),
      open_count: Number(row.open_count),
      served_count: Number(row.served_count),
      joinedLabel: dates.formatStampDate(row.created_at),
      signedInLabel: row.last_login_at ? dates.formatStamp(row.last_login_at) : null,
      signedInIso: row.last_login_at ? dates.stampToIso(row.last_login_at) : null,
      nextLabel: row.next_day ? dates.formatLongDate(row.next_day) : null,
      lastServedLabel: row.last_served ? dates.formatLongDate(row.last_served) : null,
    })),
    total,
    page: current,
    pages,
    perPage: size,
    from: (current - 1) * size + 1,
    to: Math.min(total, current * size),
    term: cleanTerm,
    filter: picked,
    sort: CUSTOMER_SORTS[sort] ? sort : 'recent',
  };
}

/** One account: the studio-visible profile plus the whole diary history. */
function customerForStaff(id) {
  const userId = Number(id);
  const user = db.get(
    `SELECT id, name, email, phone, preferred_title, notes, role, is_active, created_at, last_login_at
     FROM users WHERE id = ?`,
    userId,
  );
  if (!user) return null;

  const bookings = db.all(
    `SELECT b.id, b.status, b.contact_name, b.contact_phone, b.preferred_title, b.note, b.staff_note,
            b.created_at, b.staff_action_at, b.slot_id, b.service_id, s.slot_date, s.start_time,
            sv.name AS service_name, sv.duration_minutes, c.name AS category_name
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     JOIN services sv ON sv.id = b.service_id
     JOIN service_categories c ON c.id = sv.category_id
     WHERE b.user_id = ?
     ORDER BY s.slot_date DESC, s.start_time DESC
     LIMIT 200`,
    userId,
  ).map((row) => decorate({ ...row, slot_status: null, block_reason: null, user_email: user.email, user_role: user.role }));

  const counts = { all: bookings.length, pending: 0, confirmed: 0, completed: 0, rejected: 0, cancelled: 0 };
  for (const row of bookings) counts[row.status] = (counts[row.status] || 0) + 1;

  return {
    ...user,
    joinedLabel: dates.formatStamp(user.created_at),
    joinedIso: dates.stampToIso(user.created_at),
    signedInLabel: user.last_login_at ? dates.formatStamp(user.last_login_at) : null,
    signedInIso: user.last_login_at ? dates.stampToIso(user.last_login_at) : null,
    bookings,
    counts,
  };
}

/**
 * The catalogue as staff see it, hidden rows included. `catalogue.categories()`
 * is the customer read — it filters on `is_active` and never returns it — so
 * the services page needs its own.
 */
function serviceBoard() {
  const cats = db.all(
    'SELECT id, slug, name, summary, sort_order, is_active FROM service_categories ORDER BY sort_order, name',
  );
  const services = db.all(
    `SELECT id, category_id, slug, name, description, duration_minutes, price_text,
            is_bookable, is_active, sort_order,
            (SELECT COUNT(*) FROM bookings b WHERE b.service_id = services.id) AS booking_count
     FROM services
     ORDER BY sort_order, name`,
  );
  return cats.map((cat) => ({
    ...cat,
    services: services.filter((row) => row.category_id === cat.id),
  }));
}

/** Every slot on a date with who holds it, for the day sheet. */
function dayRows(date) {
  return db.all(
    `SELECT s.id, s.start_time, s.status AS slot_status, s.block_reason,
            b.id AS booking_id, b.status AS booking_status, b.contact_name, b.contact_phone,
            b.preferred_title, b.note, b.staff_note, b.created_at, b.user_id,
            sv.name AS service_name, sv.duration_minutes, u.email AS user_email
     FROM slots s
     LEFT JOIN bookings b ON b.slot_id = s.id
       AND b.status IN ('pending','confirmed','completed')
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN services sv ON sv.id = b.service_id
     WHERE s.slot_date = ?
     ORDER BY s.start_time`,
    date,
  ).map((row) => ({
    ...row,
    timeLabel: dates.formatTime12(row.start_time),
    endLabel: row.duration_minutes
      ? dates.formatTime12(dates.minutesToHm(dates.hmToMinutes(row.start_time) + row.duration_minutes))
      : null,
    taken: Boolean(row.booking_id),
    submittedLabel: row.created_at ? dates.formatStamp(row.created_at) : null,
  }));
}

module.exports = {
  STATUSES,
  PER_PAGE,
  decorate,
  searchBookings,
  bookingForStaff,
  statusCounts,
  dashboardSnapshot,
  searchCustomers,
  customerForStaff,
  serviceBoard,
  dayRows,
};
