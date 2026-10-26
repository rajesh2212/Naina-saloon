'use strict';
/** Public pages: home, services, studio information, location. */
const express = require('express');
const { config } = require('../config');
const catalogue = require('../lib/catalogue');
const studio = require('../lib/settings');
const dates = require('../lib/dates');
const slots = require('../lib/slots');
const { wrap } = require('../lib/async');

const router = express.Router();

async function weekView() {
  const rows = await studio.allWeekHours();
  return rows.map((row) => ({
    ...row,
    label: dates.WEEKDAY_LABELS[row.weekday],
    opensLabel: dates.formatTime12(row.opens_at),
    closesLabel: dates.formatTime12(row.closes_at),
  }));
}

router.get('/', wrap(async (req, res) => {
  const [categories, week, rules, openTimes] = await Promise.all([
    catalogue.categories(),
    weekView(),
    studio.bookingRules(),
    slots.openTimesAhead(14),
  ]);
  res.render('pages/home', {
    title: `${config.salon.name} — Salon Make-up Studio in Jagannathpur, Bhadrak`,
    categories: categories.slice(0, 8),
    week,
    rules,
    openTimes,
    signedOut: req.query.signed_out === '1',
  });
}));

router.get('/services', wrap(async (req, res) => {
  res.render('pages/services', {
    title: 'Our services',
    categories: await catalogue.categories(),
    rules: await studio.bookingRules(),
  });
}));

router.get('/services/:slug', wrap(async (req, res) => {
  const category = await catalogue.categoryBySlug(req.params.slug);
  if (!category) {
    res.status(404);
    return res.render('errors/404', { title: 'Service group not found' });
  }
  res.render('pages/category', {
    title: category.name,
    category,
    rules: await studio.bookingRules(),
  });
}));

router.get('/studio', wrap(async (req, res) => {
  res.render('pages/studio', {
    title: 'About the studio',
    categories: await catalogue.categories(),
    week: await weekView(),
    stats: await catalogue.catalogueStats(),
    rules: await studio.bookingRules(),
  });
}));

router.get('/how-to-book', wrap(async (req, res) => {
  res.render('pages/how-to-book', {
    title: 'How booking works',
    rules: await studio.bookingRules(),
    today: dates.salonClock().date,
  });
}));

router.get('/location', wrap(async (req, res) => {
  const [week, hoursByWeekday] = await Promise.all([weekView(), studio.allDayHours()]);
  const openByWeekday = new Map(hoursByWeekday.filter((hours) => !hours.closed).map((hours) => [hours.weekday, hours]));
  const today = dates.salonClock().date;
  const nextOpenDays = [];
  for (let i = 0; i < 7 && nextOpenDays.length < 3; i += 1) {
    const date = dates.addDays(today, i);
    const hours = openByWeekday.get(dates.weekdayOf(date));
    if (hours) nextOpenDays.push({ date, label: dates.formatLongDate(date), hours });
  }
  res.render('pages/location', {
    title: 'Find the studio',
    week,
    today,
    nextOpenDays,
  });
}));

// Lightweight JSON used by the booking page's date picker (progressive
// enhancement — the page works without it).
router.get('/api/availability', wrap(async (req, res) => {
  const serviceId = Number(req.query.service);
  const date = String(req.query.date || '');
  if (!Number.isInteger(serviceId) || serviceId < 1) {
    return res.status(400).json({ ok: false, error: 'Choose a service first.' });
  }
  if (!dates.isValidDate(date)) return res.status(400).json({ ok: false, error: 'Choose a valid date.' });
  try {
    const result = await slots.availableSlots(serviceId, date);
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
}));

module.exports = router;
