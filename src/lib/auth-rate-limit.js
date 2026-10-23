'use strict';
/**
 * Per-account throttling that sits on top of the IP-wide express-rate-limit
 * window, so one person cannot hammer a single address with guesses.
 * Counts live in this process; run one instance (or set TRUST_PROXY behind a
 * shared cache layer) — see README.
 */
const { config } = require('../config');
const { flash } = require('./flash');

const store = new Map();
const MAX_KEYS = 50_000;

function pruneExpired(now) {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

function hit(key, max, windowMs, now) {
  if (store.size > MAX_KEYS) pruneExpired(now);
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, retryAfterMs: 0 };
  }
  entry.count += 1;
  if (entry.count > max) return { limited: true, retryAfterMs: entry.resetAt - now };
  return { limited: false, retryAfterMs: 0 };
}

function clear(keyPrefix) {
  for (const key of store.keys()) {
    if (key.startsWith(keyPrefix)) store.delete(key);
  }
}

function throttle({ name, max, windowMs = 15 * 60 * 1000, keyFn }) {
  return (req, res, next) => {
    const now = Date.now();
    const identity = keyFn ? keyFn(req) : req.ip || 'unknown';
    const key = `${name}:${String(identity).slice(0, 120)}`;
    const result = hit(key, max, windowMs, now);
    if (!result.limited) return next();

    const minutes = Math.max(1, Math.ceil(result.retryAfterMs / 60000));
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(429).json({ ok: false, error: `Too many tries. Please wait about ${minutes} minute(s).` });
    }
    flash.error(
      req,
      `Too many tries for that address. Please wait about ${minutes} minute(s), or call the studio on ${config.salon.phone}.`,
    );
    const back = req.get('referer');
    return res.redirect(back && back.startsWith(config.http.publicUrl) ? back : '/auth/login');
  };
}

module.exports = { throttle, clear, store };
