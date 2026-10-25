'use strict';
/**
 * Customer avatar files.
 *
 * The form posts the picture as a base64 data URL, because this project has no
 * multipart parser in its dependencies and the browser-side canvas in
 * public/main.js already shrinks the pick to a small square before it is sent.
 * Nothing about that is trusted: the bytes are decoded here, checked against
 * the JPEG / PNG / WebP signatures, size-capped, and written under a filename
 * this module generates. The database only ever stores the URL path.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');

const AVATAR_DIR = path.join(config.uploads.dir, 'avatars');
const URL_PREFIX = '/uploads/avatars';
const MAX_BYTES = 400 * 1024;
// base64 is 4 characters per 3 bytes, plus slack for the data-URL prefix.
const MAX_ENCODED_CHARS = Math.ceil(MAX_BYTES * 1.4) + 64;

const DATA_URL_RE = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i;

const SIGNATURES = [
  { ext: '.png', label: 'PNG', test: (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 8).toString('latin1') === 'PNG\r\n\x1a\n' },
  { ext: '.jpg', label: 'JPEG', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.webp', label: 'WebP', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

function signatureMismatch() {
  return 'That file is not a picture we can use. Choose a JPEG, PNG or WebP image.';
}

/**
 * Decode and inspect one posted data URL. Returns { ok, buffer, ext } or
 * { ok: false, error } — the caller writes nothing until this says ok.
 */
function decodeImage(value) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: false, skipped: true };
  if (text.length > MAX_ENCODED_CHARS) {
    return { ok: false, error: 'That picture is too large. Pick a smaller one, or let the page resize it.' };
  }
  const match = DATA_URL_RE.exec(text);
  if (!match) {
    return { ok: false, error: 'That did not arrive as an image. Try choosing the photo again.' };
  }

  const bytes = Buffer.from(match[1], 'base64');
  // Buffer.from is forgiving about junk; re-encoding catches anything that was
  // not really base64 to begin with, and an empty decode is never an image.
  if (!bytes.length || bytes.toString('base64') !== match[1]) {
    return { ok: false, error: 'That image could not be read. Try choosing the photo again.' };
  }
  if (bytes.length > MAX_BYTES) {
    return { ok: false, error: 'That picture is too large. Pick a smaller one, or let the page resize it.' };
  }

  const kind = SIGNATURES.find((entry) => entry.test(bytes));
  if (!kind) return { ok: false, error: signatureMismatch() };
  return { ok: true, buffer: bytes, ext: kind.ext, label: kind.label };
}

/**
 * Write an avatar for `userId` and return the public URL path to store.
 * `previousPath` is the photo the account had before, so replacing a picture
 * can clean up the file it made obsolete.
 */
function saveAvatar(userId, value, previousPath = null) {
  const decoded = decodeImage(value);
  if (!decoded.ok) return decoded.skipped ? { ok: true, path: null } : decoded;

  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const name = `${Math.trunc(Number(userId)) || 0}-${crypto.randomBytes(6).toString('hex')}${decoded.ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, name), decoded.buffer, { mode: 0o644 });

  const saved = `${URL_PREFIX}/${name}`;
  const old = safeRelativePath(previousPath);
  if (old && old !== saved) removeAvatar(old);
  return { ok: true, path: saved };
}

/**
 * Resolve a stored photo URL to its file on disk. Returns null for anything this
 * module did not write, so no caller has to re-derive the folder layout — and a
 * damaged row can never point a read outside the avatars directory.
 */
function absoluteFor(photoPath) {
  const relative = safeRelativePath(photoPath);
  return relative ? path.join(AVATAR_DIR, path.basename(relative)) : null;
}

/**
 * Delete a stored avatar, but only when the path is one this module wrote.
 * Anything else — a stray edit, a path traversal, an asset the studio supplied
 * — is left alone.
 */
function removeAvatar(photoPath) {
  const file = absoluteFor(photoPath);
  if (!file) return false;
  if (!fs.existsSync(file)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function safeRelativePath(photoPath) {
  const value = String(photoPath ?? '');
  if (!value.startsWith(`${URL_PREFIX}/`)) return null;
  // Everything after the prefix must be a single bare filename: no subdirectory,
  // no `..`, no query string, nothing that could resolve outside the avatars dir.
  const name = value.slice(URL_PREFIX.length + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name.includes('..')) return null;
  return `${URL_PREFIX}/${name}`;
}

module.exports = {
  AVATAR_DIR,
  URL_PREFIX,
  MAX_BYTES,
  decodeImage,
  saveAvatar,
  removeAvatar,
  safeRelativePath,
  absoluteFor,
};
