'use strict';
/** One-time messages stored in the server-side session. */

const KEY = '_flash';

function push(req, type, message) {
  if (!req.session) return;
  const bucket = req.session[KEY] || [];
  bucket.push({ type, message });
  req.session[KEY] = bucket.slice(-6);
}

function consume(req, res) {
  const bucket = (req.session && req.session[KEY]) || [];
  if (req.session) delete req.session[KEY];
  const grouped = { success: [], error: [], info: [] };
  for (const item of bucket) {
    if (grouped[item.type]) grouped[item.type].push(item.message);
  }
  res.locals.flash = grouped;
  res.locals.hasFlash = Boolean(grouped.success.length || grouped.error.length || grouped.info.length);
}

const api = {
  success: (req, message) => push(req, 'success', message),
  error: (req, message) => push(req, 'error', message),
  info: (req, message) => push(req, 'info', message),
};

module.exports = { consume, flash: api };
