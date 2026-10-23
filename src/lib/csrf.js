'use strict';
/** Double-submit CSRF token kept in the server-side session. */
const crypto = require('node:crypto');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function tokenFor(req, regenerate = false) {
  if (!req.session) throw new Error('Session middleware must run before CSRF middleware');
  if (regenerate || !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  }
  return req.session.csrfToken;
}

function matches(req, candidate) {
  const expected = req.session && req.session.csrfToken;
  if (!expected || typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function csrfMiddleware(options = {}) {
  const { onError } = options;
  return (req, res, next) => {
    const token = tokenFor(req);
    res.locals.csrfToken = token;
    res.locals.csrfField = () => `<input type="hidden" name="_csrf" value="${token}">`;
    req.csrfTokenValue = token;

    if (!UNSAFE.has(req.method)) return next();

    const candidate =
      (req.body && req.body._csrf) ||
      req.get('x-csrf-token') ||
      (req.query && typeof req.query._csrf === 'string' ? req.query._csrf : '');

    if (matches(req, candidate)) return next();

    if (onError) onError(req);
    // Fresh token so the retry after re-rendering the form can succeed.
    tokenFor(req, true);
    res.status(400);
    if (req.accepts(['html', 'json']) === 'json') {
      return res.json({ ok: false, error: 'Your session expired. Please try again.' });
    }
    return res.render('errors/csrf', { title: 'Your session expired' });
  };
}

module.exports = { csrfMiddleware, tokenFor, matches };
