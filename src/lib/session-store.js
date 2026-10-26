'use strict';
/** express-session store backed by the `sessions` table. Cookie = id only. */
const { Store } = require('express-session');
const db = require('../db');

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

class PostgresSessionStore extends Store {
  constructor({ pruneAfterMs = 60 * 60 * 1000 } = {}) {
    super();
    this.lastPrune = 0;
    this.pruneAfterMs = pruneAfterMs;
  }

  // Best-effort housekeeping: a failed prune must not break the request that
  // happened to trigger it.
  prune(now) {
    if (now - this.lastPrune < this.pruneAfterMs) return;
    this.lastPrune = now;
    db.run('DELETE FROM sessions WHERE expires_at < ?', now).catch(() => {});
  }

  get(sid, callback) {
    db.get('SELECT sess, expires_at FROM sessions WHERE sid = ?', sid)
      .then((row) => {
        const now = Date.now();
        this.prune(now);
        if (!row || Number(row.expires_at) < now) return callback(null, null);
        // JSONB comes back from pg already parsed.
        const sess = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
        return callback(null, sess);
      })
      .catch((error) => callback(error));
  }

  set(sid, session, callback) {
    const done = callback || (() => {});
    const cookie = session && session.cookie;
    const maxAge = cookie && cookie.maxAge ? Number(cookie.maxAge) : DEFAULT_MAX_AGE_MS;
    const expiresAt = Date.now() + Math.max(60_000, maxAge);
    db.run(
      `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
      sid,
      JSON.stringify(session),
      expiresAt,
    )
      .then(() => done(null))
      .catch(done);
  }

  touch(sid, session, callback) {
    const done = callback || (() => {});
    const cookie = session && session.cookie;
    const maxAge = cookie && cookie.maxAge ? Number(cookie.maxAge) : DEFAULT_MAX_AGE_MS;
    db.run('UPDATE sessions SET expires_at = ? WHERE sid = ?', Date.now() + Math.max(60_000, maxAge), sid)
      .then(() => done(null))
      .catch(done);
  }

  destroy(sid, callback) {
    const done = callback || (() => {});
    db.run('DELETE FROM sessions WHERE sid = ?', sid)
      .then(() => done(null))
      .catch(done);
  }
}

module.exports = { PostgresSessionStore };
