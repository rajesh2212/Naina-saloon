'use strict';
/** `npm run db:seed` — service catalogue, weekly hours, booking settings. */
const { migrate } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');

migrate();
seed();
