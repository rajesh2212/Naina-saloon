'use strict';
/**
 * Every clock and calendar value in this app is interpreted in the salon's own
 * timezone (Asia/Kolkata), regardless of where the server runs.
 */
const SALON_TZ = 'Asia/Kolkata';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: SALON_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SALON_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 'YYYY-MM-DD' and 'HH:MM' for the salon's local clock right now. */
function salonClock(now = new Date()) {
  const date = dateFmt.format(now);
  const start = timeFmt.format(now);
  return { date, time: start, minutes: hmToMinutes(start) };
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

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * SQLite's datetime('now') is UTC; clients read the site in the salon's zone.
 * '2026-10-22 17:14:47' -> 'Thu 22 Oct 2026, 10:44 pm'
 */
function formatStamp(value) {
  const parts = typeof value === 'string' ? value.trim().match(STAMP_RE) : null;
  if (!parts) return value || '';
  const when = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6] || 0)),
  );
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: SALON_TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(when);
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: SALON_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(when).replace(/\s*([AP])m/i, ' $1m').toLowerCase();
  return `${date}, ${clock}`;
}

/** Date-only half of formatStamp, e.g. for 'Member since'. */
function formatStampDate(value) {
  const parts = typeof value === 'string' ? value.trim().match(STAMP_RE) : null;
  if (!parts) return value || '';
  const when = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5])),
  );
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SALON_TZ, day: 'numeric', month: 'short', year: 'numeric',
  }).format(when);
}

module.exports = {
  SALON_TZ,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  DATE_RE,
  TIME_RE,
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
  formatStamp,
  formatStampDate,
};
