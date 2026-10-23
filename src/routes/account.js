'use strict';
/** The signed-in customer's own area: profile details and booking history. */
const express = require('express');
const { config } = require('../config');
const users = require('../lib/users');
const slots = require('../lib/slots');
const captcha = require('../lib/captcha');
const v = require('../lib/validate');
const profile = require('../lib/profile');
const ticket = require('../lib/ticket');
const uploads = require('../lib/uploads');
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
    hasTicket: ticket.TICKET_STATUSES.includes(row.status),
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

// ---------------------------------------------------------------------------
// Profile: the five details, the completion bar, and the avatar
// ---------------------------------------------------------------------------

/** What the form shows back: the posted values when there are any, the stored ones otherwise. */
function profileValues(user) {
  return {
    name: user.name || '',
    phone: user.phone || '',
    preferredTitle: user.preferred_title || '',
    notes: user.notes || '',
    age: user.age === null || user.age === undefined ? '' : String(user.age),
    address: user.address || '',
    block: user.block || '',
  };
}

// completeness() only asks whether a photo exists, so this stands in for a
// posted picture that has cleared validation but is not on disk yet.
const PENDING_PHOTO = 'awaiting-disk-write';

/**
 * The three render sites for this page share one locals object so the bar, the
 * Block dropdown and the photo never go missing from a re-rendered form.
 */
function profileLocals(user, values, errors, completion = profile.completeness(user)) {
  return {
    title: 'My details',
    user,
    values,
    errors,
    blocks: profile.BLOCKS,
    completion,
    addressMax: profile.ADDRESS_MAX,
  };
}

/**
 * The profile page posts one form with all five details. Validation is only
 * about shape — an age that is not a number, a Block that is not on the list —
 * so a customer can save a half-finished profile and come back. Whether the
 * profile is *complete* is what src/lib/profile.js decides, and what the
 * booking gate in src/lib/guards.js enforces.
 */
router.get('/profile', (req, res) => {
  res.render('pages/profile', profileLocals(res.locals.currentUser, profileValues(res.locals.currentUser), {}));
});

router.post('/profile', (req, res) => {
  const user = res.locals.currentUser;
  const values = {
    name: req.body.name,
    phone: req.body.phone,
    preferredTitle: req.body.preferred_title,
    notes: req.body.notes,
    age: req.body.age,
    address: req.body.address,
    block: req.body.block,
  };
  const removePhoto = Boolean(req.body.remove_photo);
  const photoData = String(req.body.photo_data || '');

  // A posted picture only counts toward completion once its bytes check out,
  // so decode before anything reaches the disk.
  const pending = photoData && !removePhoto ? uploads.decodeImage(photoData) : null;
  const draft = {
    ...user,
    name: values.name,
    phone: values.phone,
    age: values.age,
    address: values.address,
    block: values.block,
    photo_path: removePhoto
      ? null
      : pending && pending.ok
        ? PENDING_PHOTO
        : user.photo_path,
  };

  const errors = {
    name: v.nameError(values.name),
    phone: v.phoneError(values.phone),
    preferredTitle: v.lengthError(v.normalizeText(values.preferredTitle, 24), 24, 'That title'),
    notes: v.lengthError(v.normalizeMultiline(values.notes, 500), 500, 'Your note'),
    age: profile.ageError(values.age),
    address: profile.addressError(values.address),
    block: profile.blockError(values.block),
    photo: pending && !pending.ok ? pending.error : null,
  };
  const clean = Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
  const shown = { ...profileValues(user), ...values, preferredTitle: values.preferredTitle, removePhoto };

  if (Object.keys(clean).length) {
    return res.status(400).render('pages/profile', profileLocals(user, shown, clean, profile.completeness(draft)));
  }

  users.updateProfile(user.id, {
    ...values,
    block: profile.isBlock(values.block) ? v.normalizeText(values.block, 40) : '',
  });

  if (removePhoto) {
    uploads.removeAvatar(user.photo_path);
    users.setPhoto(user.id, null);
  } else if (pending) {
    const saved = uploads.saveAvatar(user.id, photoData, user.photo_path);
    if (!saved.ok) {
      flash.error(req, saved.error);
      return res.redirect('/account/profile');
    }
    users.setPhoto(user.id, saved.path);
  }

  const after = users.findById(user.id);
  const completion = profile.completeness(after);
  flash.success(
    req,
    completion.complete
      ? 'Your details are saved — and everything the studio needs is there, so you can book a chair time.'
      : `Saved. Your profile is ${completion.percent}% complete — still to add: ${completion.missing.join(', ')}.`,
  );
  return res.redirect(afterProfileRedirect(req, completion));
});

/**
 * Save progress, then carry on. While details are missing the profile stays
 * open; once it is complete the customer goes back to whatever they first asked
 * for — but only the booking flow or their bookings list, never an arbitrary
 * absolute address or a staff URL.
 */
function afterProfileRedirect(req, completion) {
  const remembered = String((req.session && req.session.returnTo) || '');
  if (req.session) delete req.session.returnTo;
  if (!completion.complete) return '/account/profile';
  if (/^\/book(\/|$)/.test(remembered) || remembered === '/account') return remembered;
  return '/account';
}

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
      return res
        .status(400)
        .render(
          'pages/profile',
          { ...profileLocals(user, profileValues(user), errors), passwordAttempt: true, captchaNext: Date.now() },
        );
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

/**
 * The ticket PDF for one of this account's own bookings.
 *
 * Two doors, both answering 404 rather than explaining themselves: a booking
 * that belongs to somebody else, and a request the studio has not accepted. A
 * pending request has no ticket to show, so there is no page that could offer
 * one. The file itself is made on demand by src/lib/ticket.js and kept in
 * public/uploads/tickets, so the same link works on every visit afterwards.
 */
router.get(
  '/ticket/:id(\\d+)',
  wrap(async (req, res) => {
    const owned = slots.bookingById(Number(req.params.id));
    if (!owned || owned.user_id !== res.locals.currentUser.id) return renderNoTicket(res);
    const result = await ticket.ensure(owned.id);
    if (!result.ok) return renderNoTicket(res);
    res.download(result.file, `naina-beauty-parlour-ticket-${owned.id}.pdf`);
  }),
);

function renderNoTicket(res) {
  res.status(404);
  return res.render('errors/404', { title: 'No ticket for that booking' });
}

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
