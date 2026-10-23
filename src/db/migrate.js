'use strict';
/** Forward-only migration runner for the .sql files in ./migrations. */
const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureLedger() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function appliedNames() {
  return new Set(db.all('SELECT name FROM schema_migrations').map((row) => row.name));
}

function pendingMigrations() {
  ensureLedger();
  const done = appliedNames();
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !done.has(name));
}

function migrate({ log = console.log } = {}) {
  const pending = pendingMigrations();
  if (!pending.length) {
    log('Database is already up to date.');
    return [];
  }
  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (name) VALUES (?)', name);
    });
    log(`applied ${name}`);
  }
  return pending;
}

module.exports = { migrate, pendingMigrations, MIGRATIONS_DIR };
