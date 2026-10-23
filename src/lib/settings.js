'use strict';
/** Studio tunables (slot spacing, horizon, notice period) and weekly hours. */
const db = require('../db');
const { config } = require('../config');
const { isValidTime, hmToMinutes } = require('./dates');

const DEFAULTS = {
  slot_step_minutes: 30,
  booking_horizon_days: 30,
  lead_time_minutes: 120,
  max_active_bookings_per_user: 3,
};

const HARD_LIMITS = {
  slot_step_minutes: [15, 120],
  booking_horizon_days: [1, config.limits.bookingHorizonDays],
  lead_time_minutes: [0, 24 * 60],
  max_active_bookings_per_user: [1, 20],
};

function getSetting(key, fallback = DEFAULTS[key]) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  const parsed = Number.parseInt(row.value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const [min, max] = HARD_LIMITS[key] || [-Infinity, Infinity];
  return Math.max(min, Math.min(max, parsed));
}

function setSetting(key, value) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    String(value),
    now,
  );
}

function bookingRules() {
  return {
    stepMinutes: getSetting('slot_step_minutes'),
    horizonDays: getSetting('booking_horizon_days'),
    leadMinutes: getSetting('lead_time_minutes'),
    maxActivePerUser: getSetting('max_active_bookings_per_user'),
  };
}

function allWeekHours() {
  return db.all('SELECT weekday, is_closed, opens_at, closes_at, note FROM opening_hours ORDER BY weekday');
}

/** Hours for one weekday index (0 = Sunday), or null when not configured. */
function dayHours(weekday) {
  const row = db.get(
    'SELECT weekday, is_closed, opens_at, closes_at, note FROM opening_hours WHERE weekday = ?',
    weekday,
  );
  if (!row) return null;
  const openMinutes = hmToMinutes(row.opens_at);
  const closeMinutes = hmToMinutes(row.closes_at);
  if (row.is_closed || openMinutes === null || closeMinutes === null || closeMinutes <= openMinutes) {
    return { closed: true, opensAt: row.opens_at, closesAt: row.closes_at, note: row.note };
  }
  return {
    closed: false,
    openMinutes,
    closeMinutes,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    note: row.note,
  };
}

/** Earliest opening minute across the week — used for the public "opens at" line. */
function earliestOpening() {
  const rows = db.all('SELECT opens_at FROM opening_hours WHERE is_closed = 0');
  const minutes = rows.map((r) => hmToMinutes(r.opens_at)).filter((m) => m !== null);
  if (!minutes.length) return null;
  return Math.min(...minutes);
}

function saveWeekHours(weekday, { isClosed, opensAt, closesAt, note }) {
  if (!isValidTime(opensAt) || !isValidTime(closesAt)) {
    throw new Error('Times must be in 24-hour HH:MM form, e.g. 09:00');
  }
  if (!isClosed && hmToMinutes(closesAt) <= hmToMinutes(opensAt)) {
    throw new Error('Closing time must be later than the opening time.');
  }
  db.run(
    `INSERT INTO opening_hours (weekday, is_closed, opens_at, closes_at, note, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (weekday) DO UPDATE SET
       is_closed = excluded.is_closed,
       opens_at = excluded.opens_at,
       closes_at = excluded.closes_at,
       note = excluded.note,
       updated_at = excluded.updated_at`,
    weekday,
    isClosed ? 1 : 0,
    opensAt,
    closesAt,
    note || null,
  );
}

module.exports = {
  DEFAULTS,
  getSetting,
  setSetting,
  bookingRules,
  allWeekHours,
  dayHours,
  earliestOpening,
  saveWeekHours,
};
