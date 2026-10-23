'use strict';
/** Account repository: creation, lookups, profile edits, password changes. */
const db = require('../db');
const { hashPassword, verifyPassword } = require('./password');
const { normalizeEmail, normalizeText, normalizePhone, normalizeMultiline } = require('./validate');

const PUBLIC_COLUMNS =
  'id, email, name, phone, preferred_title, notes, role, is_active, created_at, last_login_at';

function findByEmail(email) {
  return db.get('SELECT * FROM users WHERE email = ?', normalizeEmail(email));
}

function findById(id) {
  return db.get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, id);
}

function findForAuth(email) {
  return db.get('SELECT * FROM users WHERE email = ? AND is_active = 1', normalizeEmail(email));
}

async function create({ email, name, password, phone = '', preferredTitle = '' }) {
  const digest = await hashPassword(password);
  const result = db.run(
    `INSERT INTO users (email, name, phone, preferred_title, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'customer')`,
    normalizeEmail(email),
    normalizeText(name, 80),
    normalizePhone(phone) || null,
    normalizeText(preferredTitle, 24) || null,
    digest,
  );
  return findById(result.lastInsertRowid);
}

async function verifyCredentials(email, password) {
  const user = findForAuth(email);
  if (!user) {
    // Hash a throwaway value so timing does not reveal unknown accounts.
    await verifyPassword(password || '', '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    return { ok: false, reason: 'invalid' };
  }
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? { ok: true, user } : { ok: false, reason: 'invalid' };
}

function updateProfile(id, { name, phone, preferredTitle, notes }) {
  db.run(
    `UPDATE users SET name = ?, phone = ?, preferred_title = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`,
    normalizeText(name, 80),
    normalizePhone(phone) || null,
    normalizeText(preferredTitle, 24) || null,
    normalizeMultiline(notes, 500) || null,
    id,
  );
  return findById(id);
}

async function changePassword(id, newPassword) {
  const digest = await hashPassword(newPassword);
  db.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", digest, id);
  // Invalidate every outstanding reset link for this account.
  db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', id);
  // …and every signed-in session, so an old device cannot keep working with the
  // password that has just been changed.
  db.run("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?", id);
  return true;
}

function recordLogin(id) {
  db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", id);
}

function count() {
  return Number(db.get('SELECT COUNT(*) AS n FROM users').n || 0);
}

function countAdmins() {
  return Number(db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").n || 0);
}

async function promote(email, name = 'Salon team', password = null) {
  const existing = findByEmail(email);
  if (existing) {
    db.run("UPDATE users SET role = 'admin', name = COALESCE(NULLIF(name, ''), name) WHERE id = ?", name, existing.id);
    return { user: findById(existing.id), created: false };
  }
  if (!password) {
    throw new Error(
      'No account with that email yet. Re-run with BOOTSTRAP_ADMIN_PASSWORD set (or use the interactive prompt) to create the staff login.',
    );
  }
  const user = await create({ email, name, password });
  db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
  return { user: findById(user.id), created: true };
}

module.exports = {
  findByEmail,
  findById,
  findForAuth,
  create,
  verifyCredentials,
  updateProfile,
  changePassword,
  recordLogin,
  count,
  countAdmins,
  promote,
};
