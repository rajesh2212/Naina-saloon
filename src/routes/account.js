'use strict';
/** The signed-in customer's own area: profile details and booking history. */
const express = require('express');
const { config } = require('../config');
const users = require('../lib/users');
const slots = require('../lib/slots');
const captcha = require('../lib/captcha');
const v = require('../lib/validate');
const { wrap } = require('../lib/async');
const { flash } = require('../lib/flash');
const { tokenFor } = require('../lib/csrf');
const { requireUser } = require('../lib/guards');
const dates = require('../lib/dates');

const router = express.Router();
router.use(requireUser);

function decorate(bookings) {
  return bookings.map((row) => ({
    ...row,
    dayLabel: dates.formatLongDate(row.slot_date),
    timeLabel: dates.formatRange(row.start_time, row.duration_minutes),
    isPast: row.slot_date < dates.salonClock().date,
    isOpen: row.status === 'pending' || row.status === 'confirmed',
  }));
}

router.get('/', (req, res) => {
  const bookings = decorate(slots.listUserBookings(res.locals.currentUser.id));
  res.render('pages/account', {
    title: 'My account',
    bookings,
    active: bookings.filter((b) => b.isOpen && !b.isPast),
    history: bookings.filter((b) => !(b.isOpen && !b.isPast)),
    phone: config.salon.phone,
  });
});

router.get('/profile', (req, res) => {
  const user = res.locals.currentUser;
  res.render('pages/profile', {
    title: 'My details',
    user,
    values: {
      name: user.name,
      phone: user.phone || '',
      preferredTitle: user.preferred_title || '',
      notes: user.notes || '',
    },
    errors: {},
  });
});

router.post('/profile', (req, res) => {
  const user = res.locals.currentUser;
  const values = {
    name: req.body.name,
    phone: req.body.phone,
    preferredTitle: req.body.preferred_title,
    notes: req.body.notes,
  };
  const errors = {
    name: v.nameError(values.name),
    phone: v.phoneError(values.phone),
    preferredTitle: v.lengthError(v.normalizeText(values.preferredTitle, 24), 24, 'That title'),
    notes: v.lengthError(v.normalizeMultiline(values.notes, 500), 500, 'Your note'),
  };
  const clean = Object.fromEntries(Object.entries(errors).filter(([, message]) => message));

  if (Object.keys(clean).length) {
    return res.status(400).render('pages/profile', { title: 'My details', user, values, errors: clean });
  }

  users.updateProfile(user.id, values);
  flash.success(req, 'Your details were saved.');
  return res.redirect('/account');
});

router.post(
  '/password',
  wrap(async (req, res) => {
    const user = res.locals.currentUser;
    const check = await captcha.verify(req);
    const errors = {
      captcha: check.ok ? null : check.message,
      current: null,
      password: v.passwordError(req.body.password, { email: user.email, name: user.name }),
    };
    if (!errors.password && String(req.body.password || '') !== String(req.body.confirm_password || '')) {
      errors.confirm = 'The two new passwords do not match.';
    }
    if (!req.body.current_password) {
      errors.current = 'Enter your current password.';
    } else if (errors.password === null) {
      const outcome = await users.verifyCredentials(user.email, req.body.current_password);
      if (!outcome.ok) errors.current = 'That current password is not right.';
    }

    if (Object.values(errors).some(Boolean)) {
      if (!check.ok) captcha.issue(req);
      return res.status(400).render('pages/profile', {
        title: 'My details',
        user,
        values: {
          name: user.name,
          phone: user.phone || '',
          preferredTitle: user.preferred_title || '',
          notes: user.notes || '',
        },
        errors,
        passwordAttempt: true,
        captchaNext: Date.now(),
      });
    }

    await users.changePassword(user.id, req.body.password);

    // changePassword clears every session row for this account, including the
    // one we are standing on, so start a fresh id to keep this device signed in.
    return new Promise((resolve) => {
      req.session.regenerate(() => {
        req.session.userId = user.id;
        req.session.role = user.role;
        tokenFor(req, true);
        flash.success(req, 'Password updated. Your other devices will need to sign in again.');
        resolve(res.redirect('/account'));
      });
    });
  }),
);

router.post('/bookings/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).redirect('/account');
  try {
    const booking = slots.cancelBooking({ bookingId: id, userId: res.locals.currentUser.id });
    flash.success(req, `Booking for ${booking.service_name} on ${dates.formatLongDate(booking.slot_date)} was cancelled. That time is free again.`);
  } catch (error) {
    flash.error(req, error.status ? error.message : 'Could not cancel that booking. Please call the studio.');
  }
  return res.redirect('/account');
});

module.exports = router;
