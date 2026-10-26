'use strict';
/** `npm run db:migrate` — apply pending schema migrations. */
const { migrate } = require('../src/db/migrate');
const { closeDatabase } = require('../src/db');
const { config } = require('../src/config');

(async () => {
  console.log(`Migrating ${config.db.url ? new URL(config.db.url).pathname.slice(1) : 'postgres (not configured)'}`);
  try {
    await migrate();
    console.log('Done.');
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
})();
