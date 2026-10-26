'use strict';
/** Studio tunables (slot spacing, horizon, notice period) and weekly hours. */
const db = require('../db');
const { config } = require('../config');
const dates = require('./dates');
const { isValidTime, hmToMinutes } = dates;

const NOW = "to_char(now(), 'YYYY-MM-DD HH24:MI:SS')";

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
 * so the portal can still say which value came from the environment and which one
 * it is holding itself.
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

async function textSetting(key, fallback) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
  if (!row || row.value === null) return fallback;
  const value = String(row.value).trim();
  return value === '' ? fallback : value;
}

/** Every detail the site shows right now: stored override, else the environment, else shipped default. */
async function salonDetails() {
  // One round trip for all of them. A serverless instance starts with no open
  // connection, so seven separate queries spend a suspended database's cold
  // start on six connections that one SELECT does not need — and the ones that
  // queue behind it give up before the wake finishes.
  const keys = DETAIL_FIELDS.map((field) => field.key);
  const rows = await db.all(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
    ...keys,
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const merged = { ...base };
  for (const field of DETAIL_FIELDS) {
    const raw = stored.get(field.key);
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    merged[field.field] = value === '' ? base[field.field] : value;
  }
  merged.phoneHref = phoneHref(merged.phone);
  return merged;
}

/**
 * Push the stored details into `config.salon`, and pin the studio clock to the
 * stored zone, so every reader — the mail templates, the booking page, the
 * header — picks them up without a restart. Call once at boot, and again after a
 * save.
 */
async function applySalonDetails() {
  Object.assign(config.salon, await salonDetails());
  await applySalonZone();
  return config.salon;
}

async function applySalonZone() {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', dates.ZONE_KEY).catch(() => null);
  if (row && dates.isValidTimeZone(row.value)) dates.setSalonZone(row.value);
  return dates.salonZone();
}

/** Which details a save wrote; an empty submission clears the override back to the environment. */
async function savedDetailKeys() {
  const wanted = DETAIL_FIELDS.map((field) => field.key);
  const rows = await db.all(
    `SELECT key FROM settings WHERE TRIM(value) <> '' AND key IN (${wanted.map(() => '?').join(', ')})`,
    ...wanted,
  );
  return new Set(rows.map((row) => row.key));
}

async function saveSalonDetails(values) {
  const written = [];
  for (const field of DETAIL_FIELDS) {
    if (!(field.key in values)) continue;
    await setSetting(field.key, String(values[field.key] || '').trim());
    written.push(field.label);
  }
  await applySalonDetails();
  return written;
}

async function setSetting(key, value) {
  await db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ${NOW})
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    String(value),
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
async function hasSavedTimeZone() {
  return Boolean(await db.get('SELECT value FROM settings WHERE key = ?', dates.ZONE_KEY));
}

async function saveTimeZone(value) {
  const zone = String(value || '').trim();
  if (!dates.isValidTimeZone(zone)) {
    throw new Error('Choose a time zone from the list — the studio clock has to be a real zone name.');
  }
  await db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ${NOW})
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    dates.ZONE_KEY,
    zone,
  );
  return dates.setSalonZone(zone);
}

/**
 * The four booking tunables in one read. The availability engine asks for all of
 * them together on almost every request, and on a hosted database four round
 * trips per call is the difference between a fast page and a slow one.
 */
async function bookingRules() {
  const keys = Object.keys(DEFAULTS);
  const rows = await db.all(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`,
    ...keys,
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const read = (key) => {
    const fallback = DEFAULTS[key];
    if (!stored.has(key)) return fallback;
    const parsed = Number.parseInt(stored.get(key), 10);
    if (!Number.isFinite(parsed)) return fallback;
    const [min, max] = HARD_LIMITS[key] || [-Infinity, Infinity];
    return Math.max(min, Math.min(max, parsed));
  };
  return {
    stepMinutes: read('slot_step_minutes'),
    horizonDays: read('booking_horizon_days'),
    leadMinutes: read('lead_time_minutes'),
    maxActivePerUser: read('max_active_bookings_per_user'),
  };
}

function allWeekHours() {
  return db.all('SELECT weekday, is_closed, opens_at, closes_at, note FROM opening_hours ORDER BY weekday');
}

/** The row → clock shape the booking engine works in. Pure, so a batch read can reuse it. */
function hoursFromRow(row) {
  if (!row) return null;
  const openMinutes = hmToMinutes(row.opens_at);
  const closeMinutes = hmToMinutes(row.closes_at);
  if (row.is_closed || openMinutes === null || closeMinutes === null || closeMinutes <= openMinutes) {
    return { weekday: row.weekday, closed: true, opensAt: row.opens_at, closesAt: row.closes_at, note: row.note };
  }
  return {
    weekday: row.weekday,
    closed: false,
    openMinutes,
    closeMinutes,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    note: row.note,
  };
}

/** All seven days in one read; a weekday with no row is absent, which means closed. */
async function allDayHours() {
  const rows = await allWeekHours();
  return rows.map(hoursFromRow).filter(Boolean);
}

/** Hours for one weekday index (0 = Sunday), or null when not configured. */
async function dayHours(weekday) {
  const row = await db.get(
    'SELECT weekday, is_closed, opens_at, closes_at, note FROM opening_hours WHERE weekday = ?',
    weekday,
  );
  return hoursFromRow(row);
}

/** Earliest opening minute across the week — used for the public "opens at" line. */
async function earliestOpening() {
  const rows = await db.all('SELECT opens_at FROM opening_hours WHERE is_closed = 0');
  const minutes = rows.map((r) => hmToMinutes(r.opens_at)).filter((m) => m !== null);
  if (!minutes.length) return null;
  return Math.min(...minutes);
}

async function saveWeekHours(weekday, { isClosed, opensAt, closesAt, note }) {
  if (!isValidTime(opensAt) || !isValidTime(closesAt)) {
    throw new Error('Times must be in 24-hour HH:MM form, e.g. 09:00');
  }
  if (!isClosed && hmToMinutes(closesAt) <= hmToMinutes(opensAt)) {
    throw new Error('Closing time must be later than the opening time.');
  }
  await db.run(
    `INSERT INTO opening_hours (weekday, is_closed, opens_at, closes_at, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ${NOW})
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
  setSetting,
  baseDetail,
  phoneHref,
  salonDetails,
  applySalonDetails,
  applySalonZone,
  savedDetailKeys,
  saveSalonDetails,
  bookingRules,
  allWeekHours,
  allDayHours,
  dayHours,
  earliestOpening,
  saveWeekHours,
  timeZone,
  hasSavedTimeZone,
  saveTimeZone,
  timeZonePresets,
};
