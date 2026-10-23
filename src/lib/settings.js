'use strict';
/** Studio tunables (slot spacing, horizon, notice period) and weekly hours. */
const db = require('../db');
const { config } = require('../config');
const dates = require('./dates');
const { isValidTime, hmToMinutes } = dates;

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

/**
 * The business details that ship as SALON_* environment variables, mapped to the
 * `settings` key that overrides each one. A staff member edits these at
 * /portal/details; the precedence is the same one the studio clock already uses,
 * where a saved row beats the environment.
 *
 * `base` is the environment's answer, captured before anything is overwritten,
 * so the portal can still say which value came from `.env` and which one it is
 * holding itself.
 */
const DETAIL_FIELDS = [
  { key: 'salon_name', field: 'name', label: 'Salon name', max: 80, required: true },
  { key: 'salon_tagline', field: 'tagline', label: 'Tagline under the name', max: 60 },
  { key: 'salon_phone', field: 'phone', label: 'Phone number', max: 30, phone: true },
  { key: 'salon_address', field: 'address', label: 'Address', max: 240 },
  { key: 'salon_since', field: 'since', label: 'Serving since (year)', max: 4, year: true },
  { key: 'salon_maps_url', field: 'mapsUrl', label: 'Google Maps link', max: 500, url: true },
  { key: 'salon_notify_email', field: 'notifyEmail', label: 'Copy each booking to', max: 160, email: true },
];

const base = { ...config.salon };

/** The environment/default answer for one detail, never the stored override. */
function baseDetail(field) {
  return base[field];
}

/**
 * `tel:` links are built from the phone the studio actually answers. A 10-digit
 * Indian number gets the +91 it is missing; anything already international is
 * kept as written.
 */
function phoneHref(phone) {
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) return raw.replace(/[^\d+]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return digits ? `+${digits}` : raw;
}

function textSetting(key, fallback) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', key);
  if (!row || row.value === null) return fallback;
  const value = String(row.value).trim();
  return value === '' ? fallback : value;
}

/** Every detail the site shows right now: stored override, else `.env`, else shipped default. */
function salonDetails() {
  const merged = { ...base };
  for (const field of DETAIL_FIELDS) merged[field.field] = textSetting(field.key, base[field.field]);
  merged.phoneHref = phoneHref(merged.phone);
  return merged;
}

/**
 * Push the stored details into `config.salon` so every reader — the mail
 * templates, the booking page, the header — picks them up without a restart.
 * Call once at boot, and again after a save.
 */
function applySalonDetails() {
  Object.assign(config.salon, salonDetails());
  return config.salon;
}

/** Keys with a real stored override, so the portal can mark what `.env` no longer decides. */
function savedDetailKeys() {
  const wanted = DETAIL_FIELDS.map((field) => field.key);
  const rows = db.all(
    `SELECT key FROM settings WHERE TRIM(value) <> '' AND key IN (${wanted.map(() => '?').join(', ')})`,
    ...wanted,
  );
  return new Set(rows.map((row) => row.key));
}

/** Which details a save wrote; an empty submission clears the override back to `.env`. */
function saveSalonDetails(values) {
  const written = [];
  for (const field of DETAIL_FIELDS) {
    if (!(field.key in values)) continue;
    setSetting(field.key, String(values[field.key] || '').trim());
    written.push(field.label);
  }
  applySalonDetails();
  return written;
}

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

/**
 * The salon's operating time zone: an IANA name such as 'Asia/Kolkata'.
 * Stored in the same `settings` table, but read by lib/dates, which owns the
 * clock. Saving pins the value for this process so the change is immediate.
 */
function timeZone() {
  return dates.salonZone();
}

/** True when the studio has actually chosen one, vs. the shipped default. */
function hasSavedTimeZone() {
  return Boolean(db.get('SELECT value FROM settings WHERE key = ?', dates.ZONE_KEY));
}

function saveTimeZone(value) {
  const zone = String(value || '').trim();
  if (!dates.isValidTimeZone(zone)) {
    throw new Error('Choose a time zone from the list — the studio clock has to be a real zone name.');
  }
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    dates.ZONE_KEY,
    zone,
  );
  return dates.setSalonZone(zone);
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

/**
 * Zones offered in the portal's time zone picker. Any valid IANA name works —
 * the field is a datalist, so staff can type one not listed here — but these
 * are the ones a studio in this region is most likely to want.
 */
const TIMEZONE_PRESETS = [
  'Asia/Kolkata',
  'Asia/Calcutta',
  'Asia/Dhaka',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Tashkent',
  'Asia/Bangkok',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

function timeZonePresets() {
  return TIMEZONE_PRESETS.filter(dates.isValidTimeZone);
}

module.exports = {
  DEFAULTS,
  HARD_LIMITS,
  DETAIL_FIELDS,
  getSetting,
  setSetting,
  baseDetail,
  phoneHref,
  salonDetails,
  applySalonDetails,
  savedDetailKeys,
  saveSalonDetails,
  bookingRules,
  allWeekHours,
  dayHours,
  earliestOpening,
  saveWeekHours,
  timeZone,
  hasSavedTimeZone,
  saveTimeZone,
  timeZonePresets,
};
