'use strict';
/** Public pages: home, services, studio information, location. */
const express = require('express');
const { config } = require('../config');
const db = require('../db');
const catalogue = require('../lib/catalogue');
const studio = require('../lib/settings');
const dates = require('../lib/dates');
const slots = require('../lib/slots');

const router = express.Router();

/** How many times the diary is genuinely open for booking in the next `days` days. */
function openTimesAhead(days) {
  const today = dates.salonClock().date;
  for (let i = 1; i <= days; i += 1) slots.ensureDateSlots(dates.addDays(today, i));
  return db.get(
    `SELECT COUNT(*) AS n FROM slots s
     WHERE s.status = 'open' AND s.slot_date > ? AND s.slot_date <= ?
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.slot_id = s.id AND b.status IN ('pending', 'confirmed')
       )`,
    today,
    dates.addDays(today, days),
  ).n;
}

function weekView() {
  const rows = studio.allWeekHours();
  return rows.map((row) => ({
    ...row,
    label: dates.WEEKDAY_LABELS[row.weekday],
    opensLabel: dates.formatTime12(row.opens_at),
    closesLabel: dates.formatTime12(row.closes_at),
  }));
}

router.get('/', (req, res) => {
  res.render('pages/home', {
    title: `${config.salon.name} — Salon Make-up Studio in Jagannathpur, Bhadrak`,
    categories: catalogue.categories().slice(0, 8),
    week: weekView(),
    rules: studio.bookingRules(),
    openTimes: openTimesAhead(14),
    signedOut: req.query.signed_out === '1',
  });
});

router.get('/services', (req, res) => {
  res.render('pages/services', {
    title: 'Our services',
    categories: catalogue.categories(),
    rules: studio.bookingRules(),
  });
});

router.get('/services/:slug', (req, res) => {
  const category = catalogue.categoryBySlug(req.params.slug);
  if (!category) {
    res.status(404);
    return res.render('errors/404', { title: 'Service group not found' });
  }
  res.render('pages/category', {
    title: category.name,
    category,
    rules: studio.bookingRules(),
  });
});

router.get('/studio', (req, res) => {
  res.render('pages/studio', {
    title: 'About the studio',
    categories: catalogue.categories(),
    week: weekView(),
    stats: catalogue.catalogueStats(),
    rules: studio.bookingRules(),
  });
});

router.get('/how-to-book', (req, res) => {
  res.render('pages/how-to-book', {
    title: 'How booking works',
    rules: studio.bookingRules(),
    today: dates.salonClock().date,
  });
});

router.get('/location', (req, res) => {
  res.render('pages/location', {
    title: 'Find the studio',
    week: weekView(),
    today: dates.salonClock().date,
    nextOpenDays: (() => {
      const out = [];
      for (let i = 0; i < 7 && out.length < 3; i += 1) {
        const date = dates.addDays(dates.salonClock().date, i);
        const hours = studio.dayHours(dates.weekdayOf(date));
        if (hours && !hours.closed) out.push({ date, label: dates.formatLongDate(date), hours });
      }
      return out;
    })(),
  });
});

// Lightweight JSON used by the booking page's date picker (progressive
// enhancement — the page works without it).
router.get('/api/availability', (req, res) => {
  const serviceId = Number(req.query.service);
  const date = String(req.query.date || '');
  if (!Number.isInteger(serviceId) || serviceId < 1) {
    return res.status(400).json({ ok: false, error: 'Choose a service first.' });
  }
  if (!dates.isValidDate(date)) return res.status(400).json({ ok: false, error: 'Choose a valid date.' });
  try {
    const result = slots.availableSlots(serviceId, date);
    return res.json({
      ok: true,
      date,
      slots: result.slots,
      notice: result.notice,
      durationMinutes: result.durationMinutes,
      hours: result.hours
        ? {
            opens: dates.formatTime12(result.hours.opensAt),
            closes: dates.formatTime12(result.hours.closesAt),
          }
        : null,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: error.message || 'Could not load availability.' });
  }
});

module.exports = router;
