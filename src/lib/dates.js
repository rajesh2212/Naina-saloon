'use strict';
/**
 * Clocks and calendars.
 *
 * Every wall-clock value in this app — `slots.start_time`, `slots.slot_date`,
 * `opening_hours` — is the salon's own clock, not the server's and not the
 * visitor's. Which clock that is has been a setting since the staff portal:
 * the `salon_timezone` row in `settings` wins, then `SALON_TIMEZONE`, then
 * Asia/Kolkata, which is what the studio actually runs on.
 *
 * Changing the zone re-labels the diary, it does not move it: a 10:30 slot is
 * 10:30 on whatever clock is in force. Timestamps written by SQLite's
 * `datetime('now')` are UTC and are converted on the way out.
 */
const db = require('../db');
const { config } = require('../config');

const DEFAULT_ZONE = 'Asia/Kolkata';
const ZONE_KEY = 'salon_timezone';

let pinnedZone = null; // set by setSalonZone() so a write is live in this process
const formatters = {}; // zone -> built Intl formatters

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value.trim() }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** The zone in force. Reads the setting once per process unless it is pinned. */
function salonZone() {
  if (pinnedZone) return pinnedZone;
  try {
    const row = db.get('SELECT value FROM settings WHERE key = ?', ZONE_KEY);
    if (row && isValidTimeZone(row.value)) return row.value.trim();
  } catch {
    // The settings table may not exist yet on a fresh database.
  }
  return isValidTimeZone(config.salon.timezone) ? config.salon.timezone : DEFAULT_ZONE;
}

/** Point every clock in this process at `zone`. Throws on a name the runtime rejects. */
function setSalonZone(zone) {
  const value = String(zone || '').trim();
  if (!isValidTimeZone(value)) throw new Error('That is not a time zone this build recognises.');
  pinnedZone = value;
  return value;
}

/** Drop the in-process pin so the next read goes back to the database. */
function reloadSalonZone() {
  pinnedZone = null;
}

function formsFor(zone) {
  if (!formatters[zone]) {
    formatters[zone] = {
      date: new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
      time: new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }),
      stampDate: new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      }),
      stampClock: new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true,
      }),
      offset: new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' }),
      short: new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }),
    };
  }
  return formatters[zone];
}

/** 'YYYY-MM-DD' and 'HH:MM' for the salon's local clock right now. */
function salonClock(now = new Date()) {
  const forms = formsFor(salonZone());
  const start = forms.time.format(now);
  return { date: forms.date.format(now), time: start, minutes: hmToMinutes(start), zone: salonZone() };
}

function hmToMinutes(value) {
  if (!TIME_RE.test(value || '')) return null;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHm(total) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.trunc(total)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const stamp = Date.UTC(y, m - 1, d);
  const back = new Date(stamp);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** Weekday index (0 = Sunday) for a 'YYYY-MM-DD' string, no timezone drift. */
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(dateStr, amount) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const stamp = new Date(Date.UTC(y, m - 1, d));
  stamp.setUTCDate(stamp.getUTCDate() + amount);
  return stamp.toISOString().slice(0, 10);
}

function toUtcStamp(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
function daysBetween(from, to) {
  return Math.round((toUtcStamp(to) - toUtcStamp(from)) / 86400000);
}

function formatTime12(value) {
  const minutes = hmToMinutes(value);
  if (minutes === null) return value || '';
  const h24 = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, '0');
  const suffix = h24 >= 12 ? 'pm' : 'am';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${suffix}`;
}

/** 'Wednesday, 22 October 2026' */
function formatLongDate(dateStr) {
  if (!isValidDate(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAY_LABELS[weekdayOf(dateStr)]}, ${d} ${MONTH_LABELS[m - 1]} ${y}`;
}

/** '22 October' — compact form for date pickers. */
function formatShortDate(dateStr) {
  if (!isValidDate(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAY_SHORT[weekdayOf(dateStr)]} ${d} ${MONTH_LABELS[m - 1].slice(0, 3)}`;
}

/** Human range for a booking: '10:30 am – 12:00 pm'. */
function formatRange(start, durationMinutes) {
  const s = hmToMinutes(start);
  if (s === null) return formatTime12(start);
  return `${formatTime12(start)} – ${formatTime12(minutesToHm(s + (durationMinutes || 0)))}`;
}

/**
 * A salon wall-clock appointment as an instant, for `<time datetime>`: the
 * browser can then show it in the reader's own zone next to the salon's.
 */
function slotToIso(dateStr, timeStr) {
  if (!isValidDate(dateStr) || !isValidTime(timeStr)) return null;
  const wanted = toWallMs(`${dateStr} ${timeStr}`);
  const read = new Intl.DateTimeFormat('en-GB', {
    timeZone: salonZone(), hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  // Start by pretending the wall time is UTC, then correct by the zone's offset.
  // Twice is enough to land exactly, including across a daylight-saving step.
  let guess = wanted;
  for (let i = 0; i < 3; i += 1) {
    const parts = read.formatToParts(new Date(guess));
    const pick = (type) => {
      const raw = (parts.find((p) => p.type === type) || {}).value || '00';
      return raw === '24' ? '00' : raw;
    };
    const drift = wanted - toWallMs(`${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`);
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 'YYYY-MM-DD HH:MM' read as a naive wall-clock value, in ms. */
function toWallMs(value) {
  return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)),
    Number(value.slice(11, 13)), Number(value.slice(14, 16)));
}

/** 'Thu, 22 Oct 2026, 10:44 pm' in the salon's zone from a UTC stamp. */
function formatStamp(value) {
  const when = stampToDate(value);
  if (!when) return value || '';
  const forms = formsFor(salonZone());
  const clock = forms.stampClock.format(when).replace(/\s*([AP])m/i, ' $1m').toLowerCase();
  return `${forms.stampDate.format(when)}, ${clock}`;
}

/** Date-only half of formatStamp, e.g. for 'Member since'. */
function formatStampDate(value) {
  const when = stampToDate(value);
  if (!when) return value || '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: salonZone(), day: 'numeric', month: 'short', year: 'numeric',
  }).format(when);
}

/** SQLite's UTC 'YYYY-MM-DD HH:MM:SS' (or ISO) as a Date; null when unparseable. */
function stampToDate(value) {
  const parts = typeof value === 'string' ? value.trim().match(STAMP_RE) : null;
  if (!parts) return null;
  return new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6] || 0)),
  );
}

/** A UTC stamp as an ISO instant so the browser can localise it. */
function stampToIso(value) {
  const when = stampToDate(value);
  return when ? when.toISOString() : null;
}

/**
 * 'IST' where the runtime has a real abbreviation for the zone. Null when it
 * only falls back to printing the offset — that is what Asia/Kolkata does on
 * V8, and showing it as an abbreviation would be a lie.
 */
function zoneAbbreviation(now = new Date()) {
  const zone = salonZone();
  try {
    const part = formsFor(zone).short.formatToParts(now).find((p) => p.type === 'timeZoneName');
    const value = part ? part.value : '';
    if (value && value !== zone && !value.startsWith('GMT')) return value;
  } catch {
    /* no abbreviation */
  }
  return null;
}

/** 'GMT+05:30' — unambiguous even where no abbreviation exists. */
function zoneOffset(now = new Date()) {
  const zone = salonZone();
  try {
    const part = formsFor(zone).offset.formatToParts(now).find((p) => p.type === 'timeZoneName');
    if (part && part.value) return part.value;
  } catch {
    /* fall back to the IANA name */
  }
  return zone;
}

/** Compact tag for a column of salon times: 'IST · GMT+05:30', or just the offset. */
function zoneTag(now = new Date()) {
  const abbr = zoneAbbreviation(now);
  return abbr ? `${abbr} · ${zoneOffset(now)}` : zoneOffset(now);
}

/** The full, unambiguous label the portal puts above every salon clock. */
function zoneLabel(now = new Date()) {
  const abbr = zoneAbbreviation(now);
  const parts = [abbr, zoneOffset(now), salonZone()].filter(Boolean);
  return `Salon time (${parts.join(' · ')})`;
}

module.exports = {
  DEFAULT_ZONE,
  ZONE_KEY,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  DATE_RE,
  TIME_RE,
  salonZone,
  setSalonZone,
  reloadSalonZone,
  isValidTimeZone,
  salonClock,
  hmToMinutes,
  minutesToHm,
  isValidDate,
  isValidTime,
  weekdayOf,
  addDays,
  daysBetween,
  formatTime12,
  formatLongDate,
  formatShortDate,
  formatRange,
  slotToIso,
  formatStamp,
  formatStampDate,
  stampToDate,
  stampToIso,
  zoneAbbreviation,
  zoneOffset,
  zoneTag,
  zoneLabel,
};
