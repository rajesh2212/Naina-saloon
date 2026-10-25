'use strict';
/** Process entry point. */
const { config, describeConfig } = require('./src/config');
const db = require('./src/db');
const { migrate } = require('./src/db/migrate');
const { seed } = require('./src/db/seed');
const studio = require('./src/lib/settings');
const { createApp } = require('./src/app');

function banner() {
  const info = describeConfig();
  console.log(`— ${config.salon.name} — ${config.salon.tagline} —`);
  console.log(`  environment   : ${info.env}`);
  console.log(`  listening on  : http://${config.http.host}:${config.http.port}`);
  console.log(`  public url    : ${config.http.publicUrl}`);
  console.log(`  database      : ${info.database}`);
  console.log(`  captcha       : ${info.captchaProvider}`);
  console.log(`  email         : ${info.mailEnabled ? 'SMTP configured' : info.mailDevOutbox === 'file' ? 'dev outbox only' : 'NOT CONFIGURED'}`);
  console.log(`  photographs   : ${info.photos.present}/${info.photos.total} slots hold a real photo, ${info.photos.illustrative} show tagged artwork${info.photos.empty ? `, ${info.photos.empty} empty` : ''}`);
  if (!info.envFileLoaded) console.warn('  ! no .env file found — using defaults (copy .env.example to .env)');
  if (!info.sessionSecretSet && config.isProd) console.warn('  ! SESSION_SECRET is not set');
}

function main() {
  const applied = migrate({ log: (line) => console.log(`  migration ${line}`) });
  if (applied.length) console.log(`  ${applied.length} migration(s) applied`);

  // A deployed container starts against a volume that has never held a database,
  // and a site with no catalogue is worse than one that took a second longer to
  // boot. seed() only ever writes a row that is missing, so a studio's own edits
  // in /portal are never overwritten by a restart.
  const seeded = seed({ log: () => {} });
  const added = seeded.settings + seeded.hours + seeded.catalogue.categories + seeded.catalogue.services;
  if (added) {
    console.log(
      `  seeded        : ${seeded.catalogue.categories} categories, ${seeded.catalogue.services} services, ` +
        `${seeded.hours} weekday rows, ${seeded.settings} settings (existing rows left untouched)`,
    );
  }

  // Business details saved in the staff portal win over SALON_* in .env.
  const saved = studio.savedDetailKeys();
  studio.applySalonDetails();
  if (saved.size) {
    console.log(`  details       : ${saved.size} SALON_* value(s) come from the portal, not .env`);
  }
  if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='service_categories'")) {
    console.error('  ! schema missing — run: npm run db:setup');
  }

  banner();
  const app = createApp();
  const server = app.listen(config.http.port, config.http.host, () => {
    console.log(`  ready`);
  });

  const shutdown = (signal) => {
    console.log(`\n  ${signal} received, closing.`);
    server.close(() => {
      db.closeDatabase();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
