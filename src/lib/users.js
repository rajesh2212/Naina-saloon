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

/**
 * Staff accounts, newest activity first. The password column is not in the
 * select list, so nothing on this screen can carry a hash to the browser.
 */
function listStaff() {
  return db.all(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE role = 'admin' ORDER BY is_active DESC, last_login_at IS NULL, last_login_at DESC, id`);
}

/**
 * Move an account between `customer` and `admin`. Losing the role also drops
 * that account's sessions, so a demoted staff member cannot keep a portal page
 * open on the session that was minted while they had the role.
 */
function setRole(id, role) {
  if (role !== 'admin' && role !== 'customer') throw new Error('The only roles are customer and admin.');
  db.run("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?", role, id);
  if (role !== 'admin') db.run("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?", id);
  return findById(id);
}

/** Stop an account signing in — bookings and history stay intact. */
function setActive(id, active) {
  db.run("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?", active ? 1 : 0, id);
  if (!active) {
    db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', id);
    db.run("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?", id);
  }
  return findById(id);
}

/** Make (or promote) a staff login from the portal, with a password that is only ever hashed. */
async function createStaff({ email, name, password }) {
  const user = await create({ email, name, password });
  return setRole(user.id, 'admin');
}

async function promote(email, name = 'Salon team', password = null) {
  const existing = findByEmail(email);
  if (existing) {
    // Keep the account's own name; the label is only a fallback for a row that
    // was created without one. The password is deliberately left untouched.
    db.run(
      "UPDATE users SET role = 'admin', name = COALESCE(NULLIF(name, ''), ?), updated_at = datetime('now') WHERE id = ?",
      normalizeText(name, 80) || 'Salon team',
      existing.id,
    );
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
  listStaff,
  setRole,
  setActive,
  createStaff,
  promote,
};
