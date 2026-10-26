'use strict';
/**
 * Vercel entry point: the same Express app the container listens with, exported
 * instead. Vercel invokes this per request, so nothing here may assume a disk
 * that survives, and no request may wait on work the platform cannot share.
 *
 * Boot reads exactly one thing: the studio's own words and time zone, which the
 * staff portal keeps in the database and `config.salon` hands to every template.
 * Migrations and seeding deliberately do NOT run here — several functions
 * starting at once would race the migration ledger, so that stays
 * `npm run db:setup`, run once from a terminal.
 *
 * Consequence worth knowing: a detail saved at /portal/details lands in the
 * database and in whichever function instance served that save. Other instances
 * pick it up when they next start. Ticket PDFs read the stored details live, so
 * they are never stale.
 */
const studio = require('../src/lib/settings');
const { createApp } = require('../src/app');

const app = createApp();

/**
 * How long a request will wait for the boot read before it renders anyway. The
 * platform gives a function ~10s in total, so a connect that has not finished by
 * now is not going to make this visitor's page better — and the same read is
 * tried again on the next request.
 */
const BOOT_READ_MS = 3000;

let attempt = null;
let loaded = false;

function readDetails() {
  attempt = studio
    .applySalonDetails()
    .then(() => {
      loaded = true;
    })
    .catch((error) => {
      console.error('Salon details could not be loaded from the database:', error.message);
    })
    .then(() => {
      attempt = null;
    });
  return attempt;
}

module.exports = async function handler(req, res) {
  // Overlapping cold starts share one read, and a read that came back empty-handed
  // is retried rather than leaving the instance on the .env defaults for its whole
  // life. A function frozen mid-connect reports its own connection as timed out
  // when it resumes, which is exactly the miss this covers.
  if (!loaded) await Promise.race([attempt || readDetails(), new Promise((resolve) => setTimeout(resolve, BOOT_READ_MS))]);
  return app(req, res);
};
