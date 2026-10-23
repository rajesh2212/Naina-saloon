'use strict';
/** `npm run db:migrate` — apply pending schema migrations. */
const { migrate } = require('../src/db/migrate');
const { config } = require('../src/config');

console.log(`Migrating ${config.db.file}`);
try {
  migrate();
  console.log('Done.');
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
}
