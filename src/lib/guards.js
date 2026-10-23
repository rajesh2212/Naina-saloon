'use strict';
/** Route guards. Customers must be signed in; staff routes need role=admin. */
const { config } = require('../config');
const users = require('./users');
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

function localAddress(req) {
  const url = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return `${url}://${req.get('host') || `127.0.0.1:${config.http.port}`}`;
}

module.exports = { requireUser, requireAdmin, localAddress };
