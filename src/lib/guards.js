'use strict';
/** Route guards. Customers must be signed in; staff routes need role=admin. */
const { config } = require('../config');
const users = require('./users');
const profile = require('./profile');
const { flash } = require('./flash');

function requireUser(req, res, next) {
  const id = req.session && req.session.userId;
  const user = id ? users.findById(id) : null;
  if (user) {
    res.locals.currentUser = user;
    res.locals.isAdmin = user.role === 'admin';
    return next();
  }
  if (req.session) delete req.session.userId;

  if (req.method === 'GET') {
    const target = req.originalUrl;
    if (target.startsWith('/') && !target.startsWith('//')) req.session.returnTo = target;
  }
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ ok: false, error: 'Please sign in first.' });
  }
  flash.error(req, 'Please sign in to continue.');
  return res.redirect('/auth/login');
}

function requireAdmin(req, res, next) {
  const id = req.session && req.session.userId;
  const user = id ? users.findById(id) : null;
  if (user && user.role === 'admin' && user.is_active) {
    res.locals.currentUser = user;
    res.locals.isAdmin = true;
    return next();
  }
  res.status(403);
  if (req.accepts(['html', 'json']) === 'json') {
    return res.json({ ok: false, error: 'Salon staff access only.' });
  }
  return res.render('errors/403', {
    title: 'Staff area only',
    message: user
      ? 'Your account can book appointments, but this page is for the salon team.'
      : 'Please sign in with a salon staff account.',
    isAdminSignIn: Boolean(user),
  });
}

/**
 * Chair time is only released to a profile that has all five details, Block
 * included. Mount after requireUser: the account is re-read from the database on
 * every request, so completeness is decided here and not by anything the browser
 * sends. Staff logins are exempt — they book at the counter.
 */
function requireProfile(req, res, next) {
  const user = res.locals.currentUser;
  if (!user) return requireUser(req, res, next);
  if (user.role === 'admin') return next();

  const completion = profile.completeness(user);
  if (completion.complete) return next();

  const target = req.originalUrl;
  if (req.method === 'GET' && target.startsWith('/') && !target.startsWith('//')) req.session.returnTo = target;

  const missing = listMissing(completion.missing);
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(403).json({
      ok: false,
      error: `Your profile is ${completion.percent}% complete. Please add ${missing} before requesting a time.`,
      profileIncomplete: true,
      redirectTo: '/account/profile',
    });
  }
  flash.error(
    req,
    `Your profile is ${completion.percent}% complete. Please add ${missing} — the studio needs all of it before it can hold a chair time for you.`,
  );
  return res.redirect('/account/profile');
}

/** "name, phone number and age" — the wording the flash message needs. */
function listMissing(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 1) return list[0] || 'a few more details';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function localAddress(req) {
  const url = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return `${url}://${req.get('host') || `127.0.0.1:${config.http.port}`}`;
}

module.exports = { requireUser, requireProfile, requireAdmin, localAddress };
