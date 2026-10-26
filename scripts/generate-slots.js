'use strict';
/** `npm run slots:generate` — build slot rows for every bookable day in the horizon. */
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const slots = require('../src/lib/slots');
const studio = require('../src/lib/settings');
const dates = require('../src/lib/dates');

async function main() {
  await migrate({ log: () => {} });
  await studio.applySalonZone();

  const rules = await studio.bookingRules();
  const start = dates.salonClock().date;
  let created = 0;
  let closed = 0;

  for (let i = 0; i < rules.horizonDays; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await slots.ensureDateSlots(dates.addDays(start, i), { force: true });
    if (result.closed) closed += 1;
    else created += result.created;
  }

  const total = await db.value('SELECT COUNT(*) AS n FROM slots');
  console.log(
    `Generated ${created} slot rows across ${rules.horizonDays - closed} open day(s) ` +
      `from ${start} (${rules.stepMinutes}-minute spacing). ${closed} closed day(s) skipped.`,
  );
  console.log(`Slots now in the database: ${total}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.closeDatabase());
