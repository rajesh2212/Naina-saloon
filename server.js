'use strict';
/** Process entry point. */
const { config, describeConfig } = require('./src/config');
const db = require('./src/db');
const { migrate } = require('./src/db/migrate');
const { createApp } = require('./src/app');

function banner() {
  const info = describeConfig();
  console.log('— Naina Beauty Parlour — Salon Make-up Studio —');
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
