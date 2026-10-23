'use strict';
/** Sign-up, sign-in, sign-out and the forgot/reset password flow. */
const express = require('express');
const db = require('../db');
const users = require('../lib/users');
const captcha = require('../lib/captcha');
const profile = require('../lib/profile');
const { wrap } = require('../lib/async');
const { flash } = require('../lib/flash');
const v = require('../lib/validate');
const { config } = require('../config');
const { tokenFor } = require('../lib/csrf');
const { randomToken, digestToken, digestMatches } = require('../lib/password');
const { send, passwordResetMail, mailStatus } = require('../lib/mailer');
const throttle = require('../lib/auth-rate-limit');

const router = express.Router();

const RESET_TTL_MINUTES = 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const emailFromRequest = (req) => v.normalizeEmail(req.body && req.body.email);

/** Only an internal path counts as "where the customer was going". */
function isInternalPath(target) {
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//');
}

function safeReturnTo(req, fallback = '/account') {
  const target = req.session && req.session.returnTo;
  if (req.session) delete req.session.returnTo;
  return isInternalPath(target) ? target : fallback;
}

/**
 * `?next=` on the URL, or the intent already remembered in the session — so the
 * three-way account switch keeps passing it on across a failed POST too.
 */
function nextFromQuery(req) {
  const fromQuery = req.query && req.query.next;
  if (isInternalPath(fromQuery)) return fromQuery;
  const remembered = req.session && req.session.returnTo;
  return isInternalPath(remembered) ? remembered : '';
}

/**
 * Log the account in a brand-new session id (fixation guard) and carry the
 * flash message across the regenerate callback. `keepReturnTo` re-stores the
 * page the customer first asked for, because regenerating drops the old session.
 */
function signInFreshSession(req, res, next, { userId, role, message, redirectTo, keepReturnTo }) {
  const pending = (req.session && req.session._flash) || [];
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    req.session.role = role;
    req.session._flash = pending;
    if (isInternalPath(keepReturnTo)) req.session.returnTo = keepReturnTo;
    tokenFor(req, true);
    if (message) flash.success(req, message);
    return res.redirect(redirectTo);
  });
}

// ---------------------------------------------------------------------------
// Create an account
// ---------------------------------------------------------------------------
router.get('/register', (req, res) => {
  const intended = nextFromQuery(req);
  if (intended) req.session.returnTo = intended;
  res.render('auth/register', {
    title: 'Create your account',
    values: { name: '', email: '', phone: '', preferredTitle: '' },
    errors: {},
    next: intended,
    captchaNext: Date.now(),
  });
});

router.post(
  '/register',
  throttle.throttle({ name: 'register', max: 8, windowMs: 15 * 60 * 1000 }),
  wrap(async (req, res, next) => {
    const values = {
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      preferredTitle: req.body.preferred_title,
      contactOk: Boolean(req.body.contact_ok),
    };
    const fail = (errors, status = 400) =>
      res.status(status).render('auth/register', {
        title: 'Create your account',
        values,
        errors,
        next: nextFromQuery(req),
        captchaNext: Date.now(),
      });

    // Honeypot — a real browser never fills it.
    if (String(req.body.website || '') !== '') {
      return fail({ form: 'We could not create that account. Please try again.' });
    }

    const check = await captcha.verify(req);
    const errors = {
      captcha: check.ok ? null : check.message,
      name: v.nameError(values.name),
      email: v.emailError(values.email),
      phone: v.phoneError(values.phone),
      password: v.passwordError(req.body.password, {
        email: v.normalizeEmail(values.email),
        name: v.normalizeText(values.name),
      }),
    };
    if (!errors.password && String(req.body.password || '') !== String(req.body.confirm_password || '')) {
      errors.confirm = 'The two passwords do not match.';
    }
    if (!req.body.contact_ok) {
      errors.terms = 'Please confirm that the studio may contact you about your booking.';
    }

    const clean = Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
    if (Object.keys(clean).length) {
      if (!check.ok) captcha.issue(req);
      return fail(clean);
    }

    if (users.findByEmail(values.email)) {
      captcha.issue(req);
      return fail(
        {
          email: 'That email already has an account. Sign in, or use “Forgot password” to reset it.',
          form: 'Please check the details above.',
        },
        409,
      );
    }

    const user = await users.create({
      email: values.email,
      name: values.name,
      password: req.body.password,
      phone: values.phone,
      preferredTitle: values.preferredTitle,
    });
    if (!user) return fail({ form: 'We could not create that account. Please try again.' }, 500);

    throttle.clear(`register:${req.ip}`);
    const intended = safeReturnTo(req, '/book');
    const completion = profile.completeness(user);
    // A new account has a name and maybe a number, and nothing else. Sending it
    // straight at /book would only bounce it back here from the booking gate, so
    // go to the profile first and keep the booking page in the new session.
    const left = completion.steps.filter((step) => !step.done).length;
    return signInFreshSession(req, res, next, {
      userId: user.id,
      role: user.role,
      message: completion.complete
        ? 'Your account is ready — you can book an appointment now.'
        : `Your account is ready. ${left} more ${left === 1 ? 'detail' : 'details'} on the next page and the studio can hold a time for you.`,
      redirectTo: completion.complete ? intended : '/account/profile',
      keepReturnTo: completion.complete ? null : intended,
    });
  }),
);

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------
router.get('/login', (req, res) => {
  const intended = nextFromQuery(req);
  if (intended) req.session.returnTo = intended;
  if (req.query.email && typeof req.query.email === 'string' && req.query.email.length < 200) {
    req.session.loginPrefill = req.query.email;
  }
  res.render('auth/login', {
    title: 'Sign in',
    values: { email: req.session.loginPrefill || '' },
    errors: {},
    next: intended,
    captchaNext: Date.now(),
  });
});

router.post(
  '/login',
  throttle.throttle({ name: 'login-ip', max: 20, windowMs: 15 * 60 * 1000 }),
  throttle.throttle({ name: 'login-email', max: 6, windowMs: 15 * 60 * 1000, keyFn: (req) => emailFromRequest(req) }),
  wrap(async (req, res, next) => {
    const email = emailFromRequest(req);
    const fail = (errors, status = 400) =>
      res.status(status).render('auth/login', {
        title: 'Sign in',
        values: { email },
        errors,
        next: nextFromQuery(req),
        captchaNext: Date.now(),
      });

    const check = await captcha.verify(req);
    const errors = {
      captcha: check.ok ? null : check.message,
      email: v.emailError(email),
      password: req.body.password ? null : 'Enter your password.',
    };
    if (Object.values(errors).some(Boolean)) {
      if (!check.ok) captcha.issue(req);
      return fail(errors);
    }

    const outcome = await users.verifyCredentials(email, req.body.password);
    if (!outcome.ok) {
      captcha.issue(req);
      return fail({ form: 'We could not match that email and password. Try again, or reset your password.' }, 401);
    }

    throttle.clear(`login-email:${email}`);
    users.recordLogin(outcome.user.id);
    const firstName = v.normalizeText(outcome.user.name, 40).split(' ')[0];
    const intended = safeReturnTo(req, outcome.user.role === 'admin' ? '/portal' : '/account');
    // Heading for a booking with an incomplete profile: the gate would send them
    // to the profile anyway, so take them there directly and keep the booking
    // page in the new session for when the details are in.
    const wantsToBook = /^\/book(\/|$)/.test(intended);
    const incomplete = outcome.user.role !== 'admin' && !profile.isProfileComplete(outcome.user);
    return signInFreshSession(req, res, next, {
      userId: outcome.user.id,
      role: outcome.user.role,
      message: `Welcome back, ${firstName}.`,
      redirectTo: wantsToBook && incomplete ? '/account/profile' : intended,
      keepReturnTo: wantsToBook && incomplete ? intended : null,
    });
  }),
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(config.session.name, { path: '/' });
    res.redirect('/?signed_out=1');
  });
});

// ---------------------------------------------------------------------------
// Forgot password
// ---------------------------------------------------------------------------
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot', {
    title: 'Forgot your password',
    next: nextFromQuery(req),
    mail: mailStatus(),
    notice: null,
    values: { email: '' },
    errors: {},
    captchaNext: Date.now(),
  });
});

router.post(
  '/forgot-password',
  throttle.throttle({ name: 'forgot', max: 6, windowMs: 30 * 60 * 1000 }),
  wrap(async (req, res) => {
    const email = emailFromRequest(req);
    const check = await captcha.verify(req);
    const errors = { email: v.emailError(email), captcha: check.ok ? null : check.message };

    if (Object.values(errors).some(Boolean)) {
      if (!check.ok) captcha.issue(req);
      return res.status(400).render('auth/forgot', {
        title: 'Forgot your password',
        next: nextFromQuery(req),
        mail: mailStatus(),
        notice: null,
        values: { email },
        errors,
        captchaNext: Date.now(),
      });
    }

    const status = mailStatus();
    const user = users.findForAuth(email);

    if (user && status.enabled) {
      const token = randomToken();
      const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString().replace('T', ' ').slice(0, 19);
      const inserted = db.run(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
        user.id,
        digestToken(token),
        expiresAt,
      );
      // Only the newest link for an account stays live.
      db.run(
        'DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL AND id <> ?',
        user.id,
        inserted.lastInsertRowid,
      );

      const template = passwordResetMail({
        name: user.name,
        link: `${config.http.publicUrl}/auth/reset/${token}`,
        minutes: RESET_TTL_MINUTES,
      });
      const result = await send({ to: user.email, ...template });

      if (result.ok) {
        return res.render('auth/forgot-sent', {
          title: 'Check your email',
          email,
          via: status.mode,
          minutes: RESET_TTL_MINUTES,
        });
      }

      console.error('[mail] reset send failed:', result.error);
      db.run('DELETE FROM password_resets WHERE id = ?', inserted.lastInsertRowid);
      return res.status(502).render('auth/forgot', {
        title: 'Forgot your password',
        next: nextFromQuery(req),
        mail: status,
        notice: 'The mail server rejected the message. Please try again in a few minutes, or call the studio and we will sort it out at the counter.',
        values: { email },
        errors: {},
        captchaNext: Date.now(),
      });
    }

    if (user && !status.enabled) {
      // No credentials configured: say so plainly rather than pretending.
      return res.render('auth/forgot', {
        title: 'Forgot your password',
        next: nextFromQuery(req),
        mail: { ...status, attempted: true, unconfigured: true },
        notice: null,
        values: { email },
        errors: {},
        captchaNext: Date.now(),
      });
    }

    // Unknown address: same shape of response, no account disclosure.
    return res.render('auth/forgot-sent', {
      title: 'Check your email',
      email,
      via: status.mode,
      minutes: RESET_TTL_MINUTES,
      unknownRecipient: true,
    });
  }),
);

// ---------------------------------------------------------------------------
// Reset password with the emailed link
// ---------------------------------------------------------------------------
function findResetRow(token) {
  return db.get(
    `SELECT pr.id, pr.user_id, pr.token_hash, pr.expires_at, pr.used_at, u.email, u.name, u.role
     FROM password_resets pr JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash = ?`,
    digestToken(token),
  );
}

function renderInvalid(res) {
  return res.status(410).render('auth/reset-invalid', { title: 'That reset link has expired' });
}

router.get('/reset/:token', (req, res) => {
  const row = TOKEN_RE.test(req.params.token) ? findResetRow(req.params.token) : null;
  if (!row || row.used_at || row.expires_at <= nowSql()) return renderInvalid(res);
  res.render('auth/reset', {
    title: 'Choose a new password',
    token: req.params.token,
    email: row.email,
    errors: {},
    captchaNext: Date.now(),
  });
});

router.post(
  '/reset/:token',
  throttle.throttle({ name: 'reset', max: 8, windowMs: 30 * 60 * 1000 }),
  wrap(async (req, res, next) => {
    const rawToken = req.params.token;
    if (!TOKEN_RE.test(rawToken)) return renderInvalid(res);
    const row = findResetRow(rawToken);
    if (!row || row.used_at || row.expires_at <= nowSql() || !digestMatches(rawToken, row.token_hash)) {
      return renderInvalid(res);
    }

    const check = await captcha.verify(req);
    const errors = {
      captcha: check.ok ? null : check.message,
      password: v.passwordError(req.body.password, { email: row.email, name: row.name }),
    };
    if (!errors.password && String(req.body.password || '') !== String(req.body.confirm_password || '')) {
      errors.confirm = 'The two passwords do not match.';
    }
    if (Object.values(errors).some(Boolean)) {
      if (!check.ok) captcha.issue(req);
      return res.status(400).render('auth/reset', {
        title: 'Choose a new password',
        token: rawToken,
        email: row.email,
        errors,
        captchaNext: Date.now(),
      });
    }

    // Hash before touching the session so the new password is certainly saved.
    await users.changePassword(row.user_id, req.body.password);
    db.run("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?", row.id);
    throttle.clear(`reset:${req.ip}`);

    return signInFreshSession(req, res, next, {
      userId: row.user_id,
      role: row.role,
      message: 'Your password has been updated and you are signed in.',
      redirectTo: '/account',
    });
  }),
);

module.exports = router;
