'use strict';
/** Forward-only migration runner for the .sql files in ./migrations. */
const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureLedger() {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
  )`);
}

async function appliedNames() {
  const rows = await db.all('SELECT name FROM schema_migrations');
  return new Set(rows.map((row) => row.name));
}

async function pendingMigrations() {
  await ensureLedger();
  const done = await appliedNames();
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !done.has(name));
}

async function migrate({ log = console.log } = {}) {
  const pending = await pendingMigrations();
  if (!pending.length) {
    log('Database is already up to date.');
    return [];
  }
  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    await db.transaction(async () => {
      await db.exec(sql);
      await db.run('INSERT INTO schema_migrations (name) VALUES (?)', name);
    });
    log(`applied ${name}`);
  }
  return pending;
}

module.exports = { migrate, pendingMigrations, MIGRATIONS_DIR };
