'use strict';
/** express-session store backed by the `sessions` table. Cookie = id only. */
const { Store } = require('express-session');
const db = require('../db');

class SqliteSessionStore extends Store {
  constructor({ pruneAfterMs = 60 * 60 * 1000 } = {}) {
    super();
    this.lastPrune = 0;
    this.pruneAfterMs = pruneAfterMs;
  }

  prune(now) {
    if (now - this.lastPrune < this.pruneAfterMs) return;
    this.lastPrune = now;
    db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  }

  get(sid, callback) {
    try {
      const row = db.get('SELECT sess, expires_at FROM sessions WHERE sid = ?', sid);
      const now = Date.now();
      this.prune(now);
      if (!row || row.expires_at < now) return callback(null, null);
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, session, callback) {
    try {
      const cookie = session && session.cookie;
      const maxAge = cookie && cookie.maxAge ? Number(cookie.maxAge) : 7 * 24 * 60 * 60 * 1000;
      const expiresAt = Date.now() + Math.max(60_000, maxAge);
      db.run(
        `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
        sid,
        JSON.stringify(session),
        expiresAt,
      );
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }

  touch(sid, session, callback) {
    try {
      const cookie = session && session.cookie;
      const maxAge = cookie && cookie.maxAge ? Number(cookie.maxAge) : 7 * 24 * 60 * 60 * 1000;
      db.run('UPDATE sessions SET expires_at = ? WHERE sid = ?', Date.now() + Math.max(60_000, maxAge), sid);
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      db.run('DELETE FROM sessions WHERE sid = ?', sid);
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }
}

module.exports = { SqliteSessionStore };
