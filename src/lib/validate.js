'use strict';
/** Input normalisation and validation. Everything here runs on the server. */
const { config } = require('../config');
const { isValidDate, isValidTime, hmToMinutes } = require('./dates');

const EMAIL_RE =
  /^[^\s@,;:"'<>\\]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function normalizeText(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeMultiline(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.trim().slice(0, 200))
    .join('\n')
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return normalizeText(value, 254).toLowerCase();
}

function normalizePhone(value) {
  const raw = normalizeText(value, 20);
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.slice(0, 20);
}

function emailError(value) {
  const email = normalizeEmail(value);
  if (!email) return 'Enter your email address.';
  if (!EMAIL_RE.test(email)) return 'That email address does not look right. Check the spelling.';
  return null;
}

function nameError(value) {
  const name = normalizeText(value, config.limits.nameMaxLength);
  if (!name) return 'Enter your name.';
  if (name.length < 2) return 'Please give a name of at least 2 characters.';
  if (/^[\d\W_]+$/.test(name)) return 'Please enter a real name using letters.';
  return null;
}

/**
 * Password policy: length plus letter and digit, and not the email or name.
 * Bcrypt cost 12 keeps a leaked database expensive to crack.
 */
function passwordError(password, { email = '', name = '' } = {}) {
  const value = String(password ?? '');
  if (!value) return 'Enter a password.';
  if (value.length < config.limits.passwordMinLength) {
    return `Use at least ${config.limits.passwordMinLength} characters.`;
  }
  if (value.length > 200) return 'That password is too long.';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Include at least one letter and one number.';
  if (/^(.)\1+$/.test(value)) return 'Do not repeat a single character.';
  if (email && value.toLowerCase().includes(email.split('@')[0])) return 'Do not reuse your email address in the password.';
  if (name && value.toLowerCase() === normalizeText(name).toLowerCase()) return 'Choose a password that is not your name.';
  return null;
}

function phoneError(value, { required = false } = {}) {
  const phone = normalizePhone(value);
  if (!phone) return required ? 'Enter a contact number so the studio can reach you.' : null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) return 'Enter a reachable phone number (6–14 digits).';
  return null;
}

function captchaIdError(value) {
  const id = normalizeText(value, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return 'The verification image expired. Load a new one and try again.';
  return null;
}

function dateError(value, { min = null, max = null } = {}) {
  if (!isValidDate(value)) return 'Choose a valid date.';
  if (min && value < min) return `Booking opens from ${min} onwards.`;
  if (max && value > max) return 'That date is too far ahead.';
  return null;
}

function timeError(value) {
  if (!isValidTime(value)) return 'Choose an appointment time.';
  return null;
}

function lengthError(value, max, label = 'That field') {
  if (String(value ?? '').length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

/** True when a value fails an equality check without leaking which part matched. */
function safeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa.length !== sb.length) return false;
  let mismatch = 0;
  for (let i = 0; i < sa.length; i += 1) mismatch |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return mismatch === 0;
}

module.exports = {
  EMAIL_RE,
  normalizeText,
  normalizeMultiline,
  normalizeEmail,
  normalizePhone,
  emailError,
  nameError,
  passwordError,
  phoneError,
  captchaIdError,
  dateError,
  timeError,
  lengthError,
  safeEqual,
  hmToMinutes,
};
