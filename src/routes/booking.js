'use strict';
/**
 * Booking flow: pick a service → pick a date → see the slots that are genuinely
 * free in the database → request one. Availability and the write itself are
 * both server-side.
 */
const express = require('express');
const { config } = require('../config');
const catalogue = require('../lib/catalogue');
const slots = require('../lib/slots');
const studio = require('../lib/settings');
const dates = require('../lib/dates');
const v = require('../lib/validate');
const { flash } = require('../lib/flash');
const throttle = require('../lib/auth-rate-limit');
const { requireUser, requireProfile } = require('../lib/guards');

const router = express.Router();

// Signing in and a complete profile are checked here, on every request, before
// any slot list or booking write runs. Hiding the button in the page is a
// courtesy; this is the rule. Staff logins pass straight through.
router.use(requireUser, requireProfile);

const today = () => dates.salonClock().date;

function buildDateStrip(serviceId, selected) {
  const rules = studio.bookingRules();
  const calendar = slots.availabilityCalendar(serviceId, { days: Math.min(rules.horizonDays, 14) });
  return calendar.map((entry) => ({
    ...entry,
    label: dates.formatShortDate(entry.date),
    selected: entry.date === selected,
    isToday: entry.date === today(),
  }));
}

router.get('/', (req, res) => {
  const groups = catalogue.bookableServicesGrouped();
  const services = groups.flatMap((group) => group.services);
  const preselect = Number(req.query.service) || null;
  const chosen = preselect ? services.find((s) => s.id === preselect) || null : null;

  if (!services.length) {
    return res.render('pages/book-unavailable', { title: 'Booking opens soon' });
  }

  if (!chosen) {
    return res.render('pages/book', {
      title: 'Book an appointment',
      groups,
      step: 1,
      chosen: null,
      date: null,
      availability: null,
      values: { note: '', contactPhone: (res.locals.currentUser && res.locals.currentUser.phone) || '' },
      errors: {},
    });
  }

  return res.redirect(`/book/${chosen.id}`);
});

router.get('/:serviceId(\\d+)', (req, res) => {
  const service = catalogue.allBookableServices().find((row) => row.id === Number(req.params.serviceId));
  if (!service) {
    res.status(404);
    return res.render('errors/404', { title: 'Service not found' });
  }

  const rules = studio.bookingRules();
  const min = dates.addDays(today(), 0);
  const max = dates.addDays(today(), rules.horizonDays);
  let date = String(req.query.date || '');
  if (!dates.isValidDate(date) || date < min || date > max) date = min;

  const availability = slots.availableSlots(service.id, date);
  return res.render('pages/book', {
    title: `Book ${service.name}`,
    groups: catalogue.bookableServicesGrouped(),
    step: 2,
    chosen: service,
    date,
    minDate: min,
    maxDate: max,
    dateStrip: buildDateStrip(service.id, date),
    availability,
    values: {
      note: '',
      contactPhone: (res.locals.currentUser && res.locals.currentUser.phone) || '',
      preferredTitle: (res.locals.currentUser && res.locals.currentUser.preferred_title) || '',
    },
    errors: {},
    rules,
    requiresSignIn: !res.locals.currentUser,
    phone: config.salon.phone,
  });
});

/** Server-rendered fallback and the JSON the page's JS both use this. */
router.get('/:serviceId(\\d+)/slots', (req, res) => {
  const serviceId = Number(req.params.serviceId);
  const date = String(req.query.date || '');
  if (!dates.isValidDate(date)) return res.status(400).json({ ok: false, error: 'Choose a valid date.' });
  try {
    const result = slots.availableSlots(serviceId, date);
    return res.json({
      ok: true,
      date,
      durationMinutes: result.durationMinutes,
      slots: result.slots,
      notice: result.notice,
      dayLabel: dates.formatLongDate(date),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: error.message || 'Availability is unavailable.' });
  }
});

router.post(
  '/',
  throttle.throttle({ name: 'booking', max: 12, windowMs: 60 * 60 * 1000 }),
  (req, res) => {
    const serviceId = Number(req.body.service_id);
    const slotId = Number(req.body.slot_id);
    const values = {
      contactPhone: req.body.contact_phone,
      preferredTitle: req.body.preferred_title,
      note: req.body.note,
    };
    const service = serviceId ? catalogue.allBookableServices().find((row) => row.id === serviceId) : null;

    const errors = {
      service: service ? null : 'Please choose a service.',
      slot: Number.isInteger(slotId) && slotId > 0 ? null : 'Please choose an appointment time.',
      phone: v.phoneError(values.contactPhone, { required: true }),
      title: v.lengthError(v.normalizeText(values.preferredTitle, 24), 24, 'That title'),
      note: v.lengthError(v.normalizeMultiline(values.note, 500), 500, 'Your note'),
    };
    const clean = Object.fromEntries(Object.entries(errors).filter(([, message]) => message));

    const rerender = (message, status) => {
      const date = String(req.body.date || '') || today();
      const availability = service ? slots.availableSlots(service.id, date) : { slots: [], notice: 'Choose a service again.' };
      res.status(status).render('pages/book', {
        title: service ? `Book ${service.name}` : 'Book an appointment',
        groups: catalogue.bookableServicesGrouped(),
        step: 2,
        chosen: service,
        date,
        minDate: today(),
        maxDate: dates.addDays(today(), studio.bookingRules().horizonDays),
        dateStrip: service ? buildDateStrip(service.id, date) : [],
        availability,
        values,
        errors: { ...clean, form: message },
        rules: studio.bookingRules(),
        requiresSignIn: false,
        phone: config.salon.phone,
      });
    };

    if (Object.keys(clean).length) return rerender('Please check the details below.', 400);
    if (!availabilityHasSlot(service.id, slotId, date(req.body.date))) {
      return rerender('That time is no longer free — it has just been taken or the list changed. Please choose another slot.', 409);
    }

    try {
      const booking = slots.createBooking({
        userId: res.locals.currentUser.id,
        serviceId: service.id,
        slotId,
        contactName: res.locals.currentUser.name,
        contactPhone: v.normalizePhone(values.contactPhone),
        preferredTitle: v.normalizeText(values.preferredTitle, 24),
        note: v.normalizeMultiline(values.note, 500),
      });
      flash.success(
        req,
        `Request sent: ${booking.service_name} on ${dates.formatLongDate(booking.slot_date)} at ${dates.formatTime12(booking.start_time)}. The studio will confirm it.`,
      );
      return res.redirect(`/book/done/${booking.id}`);
    } catch (error) {
      const message =
        error.status === 409
          ? error.message
          : error.status === 401
            ? 'Please sign in again to finish booking.'
            : error.status && error.status < 500
              ? error.message
              : 'Something went wrong while saving your request. No time has been taken — please try again.';
      if (!error.status) console.error('[booking]', error);
      return rerender(message, 409);
    }
  },
);

function date(value) {
  return dates.isValidDate(String(value || '')) ? String(value) : today();
}

/** Cheap pre-check purely for a friendly message; the real guard is the transaction. */
function availabilityHasSlot(serviceId, slotId, value) {
  try {
    const { slots: list } = slots.availableSlots(serviceId, value);
    return list.some((slot) => slot.id === slotId);
  } catch {
    return false;
  }
}

router.get('/done/:id', (req, res) => {
  const booking = slots.bookingById(Number(req.params.id));
  if (!booking || booking.user_id !== res.locals.currentUser.id) {
    res.status(404);
    return res.render('errors/404', { title: 'Booking not found' });
  }
  return res.render('pages/booking-done', {
    title: 'Booking request sent',
    booking: {
      ...booking,
      dayLabel: dates.formatLongDate(booking.slot_date),
      range: dates.formatRange(booking.start_time, booking.duration_minutes),
      timeLabel: dates.formatTime12(booking.start_time),
    },
    phone: config.salon.phone,
    mailEnabled: require('../lib/mailer').mailStatus().enabled,
  });
});

module.exports = router;
