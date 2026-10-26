'use strict';
/**
 * Postgres access for the whole app. Everything is async now, and `?`
 * placeholders are rewritten to `$n` at the boundary so the rest of the
 * codebase still reads like the SQLite version it replaced.
 *
 * Slot races are decided by the partial unique index
 * `bookings_one_active_per_slot_key`: whichever insert lands second raises
 * SQLSTATE 23505, which `isConflict()` turns back into a friendly message.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');
const { config } = require('../config');

// Every id column is BIGINT, and pg hands int8 back as a string. The values
// are far below 2^53, so numbers are what the rest of the app expects.
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

let pool = null;

function getPool() {
  if (!pool) {
    if (!config.db.url) {
      throw new Error('DATABASE_URL (or POSTGRES_URL) is not set — the app has nowhere to keep bookings.');
    }
    pool = new Pool({
      connectionString: config.db.url,
      // Neon and most hosted Postgres terminate with a private CA; the
      // connection string decides whether SSL is on, not this app.
      ssl: /sslmode=disable/.test(config.db.url) ? false : { rejectUnauthorized: false },
      // A serverless instance starts with no warm connections, and the boot
      // read fires six queries at once (one per salon detail). A pool smaller
      // than that makes the last one wait out the whole cold start of a
      // suspended database and give up, so the headroom is the point.
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
    // A pool that never gets a query in flight would otherwise crash the
    // process on an idle timeout.
    pool.on('error', () => {});
  }
  return pool;
}

async function closeDatabase() {
  if (pool) {
    const ending = pool;
    pool = null;
    await ending.end();
  }
}

// Queries inside transaction() run on one dedicated client; everything else
// borrows from the pool. AsyncLocalStorage means the callers never have to
// thread a client object through.
const txClient = new AsyncLocalStorage();

function target() {
  return txClient.getStore() || getPool();
}

/**
 * Rewrite `?` to `$1, $2, …`, ignoring question marks inside single-quoted
 * string literals. Also refuses a mismatch between placeholders and args,
 * which is the one way a hand-edited query could silently drop a parameter.
 */
function toPg(sql, params) {
  let out = '';
  let index = 1;
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        // '' inside a literal is an escaped quote, not the end.
        if (sql[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '?') {
      out += `$${index}`;
      index += 1;
      continue;
    }
    out += ch;
  }
  const count = index - 1;
  if (count !== params.length) {
    throw new Error(`Query has ${count} placeholders but ${params.length} parameters: ${sql}`);
  }
  return out;
}

async function query(sql, params) {
  return (await target().query(toPg(sql, params), params)).rows;
}

async function all(sql, ...params) {
  return query(sql, params);
}

async function get(sql, ...params) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

async function value(sql, ...params) {
  const row = await get(sql, ...params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

async function run(sql, ...params) {
  const result = await target().query(toPg(sql, params), params);
  // rowCount, not rows.length: an UPDATE with no RETURNING clause returns no
  // rows but must still report how many it touched.
  return { changes: Number(result.rowCount || 0) };
}

/**
 * Insert and hand back the new id. Postgres has no `lastInsertRowid`, so the
 * row is returned straight from the write.
 */
async function insert(sql, ...params) {
  const withId = /\breturning\b/i.test(sql) ? sql : `${sql} RETURNING id`;
  const rows = await query(withId, params);
  return { id: rows.length ? Number(rows[0].id) : null, changes: rows.length };
}

// Multi-statement DDL (migrations) goes through the simple query protocol, so
// it must not be placeholder-rewritten.
async function exec(sql) {
  await (txClient.getStore() || getPool()).query(sql);
}

/**
 * Run `fn` inside a transaction on a single connection. A nested call joins
 * the outer one rather than opening a savepoint — the app only re-enters
 * through seed helpers, and half-started work should roll back with the rest.
 */
async function transaction(fn) {
  if (txClient.getStore()) return fn();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await txClient.run(client, async () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already gone */
    }
    throw error;
  } finally {
    client.release();
  }
}

function isConflict(error) {
  return Boolean(error && error.code === '23505');
}

/**
 * Undo only what `fn` did. Postgres aborts the entire transaction as soon as one
 * statement fails — a rejected row is not merely an error, it poisons every
 * query that follows until the transaction ends. SQLite never did that, so any
 * code that deliberately provokes a constraint has to wrap the attempt here.
 * Outside a transaction there is nothing to roll back to and it is a plain call.
 */
async function savepoint(fn) {
  const client = txClient.getStore();
  if (!client) return fn();
  const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch {
      /* the connection is already gone */
    }
    throw error;
  }
}

module.exports = {
  getPool,
  closeDatabase,
  all,
  get,
  value,
  run,
  insert,
  exec,
  transaction,
  savepoint,
  isConflict,
};
