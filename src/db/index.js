'use strict';
/**
 * SQLite access built on Node's own `node:sqlite` driver, so the project has
 * no native module to compile. Exposes prepared-statement helpers plus a
 * `transaction()` wrapper that uses BEGIN IMMEDIATE, which is what keeps
 * slot booking from racing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../config');

let db = null;

function openDatabase(file = config.db.file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA synchronous = NORMAL');
  return handle;
}

function getDb() {
  if (!db) db = openDatabase();
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// node:sqlite returns null-prototype objects; EJS and object spread behave
// better with plain objects.
function plain(row) {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map(plain);
  if (row instanceof Map) return row;
  return Object.assign({}, row);
}

function all(sql, ...params) {
  return plain(getDb().prepare(sql).all(...params));
}

function get(sql, ...params) {
  const row = getDb().prepare(sql).get(...params);
  return row === undefined ? null : plain(row);
}

function run(sql, ...params) {
  const result = getDb().prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

function value(sql, ...params) {
  const row = get(sql, ...params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

function exec(sql) {
  getDb().exec(sql);
}

let txDepth = 0;

/**
 * Run `fn` inside a BEGIN IMMEDIATE transaction. Writes are taken by the
 * transaction, so a second concurrent booking attempt on the same slot blocks
 * (busy_timeout) and then fails the availability check instead of double-booking.
 */
function transaction(fn) {
  const handle = getDb();
  if (txDepth === 0) {
    handle.exec('BEGIN IMMEDIATE');
    txDepth += 1;
    try {
      const result = fn(handle);
      handle.exec('COMMIT');
      txDepth -= 1;
      return result;
    } catch (error) {
      txDepth -= 1;
      try {
        handle.exec('ROLLBACK');
      } catch {
        /* rollback of an already-aborted transaction is a no-op */
      }
      throw error;
    }
  }
  // Re-entrant: run inside the outer transaction.
  txDepth += 1;
  try {
    return fn(handle);
  } finally {
    txDepth -= 1;
  }
}

module.exports = { getDb, closeDatabase, all, get, run, value, exec, transaction, plain };
