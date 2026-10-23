'use strict';
/** Password hashing (bcryptjs — pure JS, no native build) and token digests. */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const ROUNDS = 12;
const PREHASH = (password) => crypto.createHash('sha256').update(String(password)).digest('base64');

async function hashPassword(password) {
  return bcrypt.hash(PREHASH(password), ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(PREHASH(password), hash);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function digestToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time compare of two hex digests. */
function digestMatches(token, storedDigest) {
  const a = crypto.createHash('sha256').update(String(token)).digest();
  const b = Buffer.from(String(storedDigest || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Short stable hash of an IP, used only so staff can see repeat-request patterns. */
function anonymiseIp(ip) {
  return crypto.createHash('sha256').update(`naina:${ip || 'unknown'}`).digest('hex').slice(0, 16);
}

module.exports = { hashPassword, verifyPassword, randomToken, digestToken, digestMatches, anonymiseIp, ROUNDS };
