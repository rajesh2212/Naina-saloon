'use strict';
/**
 * The staff area moved to `/portal`, which has its own chrome, a searchable
 * bookings table and the studio clock setting. These redirects keep an old
 * bookmark working; they are the whole file. The logic lives in
 * routes/portal.js and src/lib/records.js, so there is only one staff surface
 * to keep correct.
 *
 * Access control is unchanged and still server-side: `requireAdmin` runs before
 * a redirect is issued, so an unauthorised session gets the same 403 here as it
 * does anywhere in the portal.
 */
const express = require('express');
const { requireAdmin } = require('../lib/guards');

const router = express.Router();

router.use(requireAdmin);

router.get('/', (req, res) => res.redirect(302, '/portal'));

router.get('/bookings', (req, res) => {
  const status = req.query.status ? `?status=${encodeURIComponent(String(req.query.status).slice(0, 20))}` : '';
  res.redirect(302, `/portal/bookings${status}`);
});

router.get('/bookings/:id(\\d+)', (req, res) => res.redirect(302, `/portal/bookings/${Number(req.params.id)}`));
router.get('/customers/:id(\\d+)', (req, res) => res.redirect(302, `/portal/customers/${Number(req.params.id)}`));
router.get('/day/:date(\\d{4}-\\d{2}-\\d{2})', (req, res) => res.redirect(302, `/portal/day/${req.params.date}`));
router.get('/services', (req, res) => res.redirect(302, '/portal/services'));

// The week hours and the booking rules now share one portal page, and every
// write belongs to the portal's own CSRF-protected forms.
router.get('/hours', (req, res) => res.redirect(302, '/portal/settings'));
router.get('/settings', (req, res) => res.redirect(302, '/portal/settings'));
router.all('*', (req, res) => res.redirect(302, '/portal'));

module.exports = router;
