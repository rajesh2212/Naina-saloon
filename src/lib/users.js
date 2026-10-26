'use strict';
/** Account repository: creation, lookups, profile edits, password changes. */
const db = require('../db');
const { hashPassword, verifyPassword } = require('./password');
const { normalizeEmail, normalizeText, normalizePhone, normalizeMultiline } = require('./validate');
const profile = require('./profile');

const NOW = "to_char(now(), 'YYYY-MM-DD HH24:MI:SS')";

// `photo_path` is only ever a key in the private uploads store, so the image
// bytes are never under the folder the static mount serves. Every screen that
// lists accounts reads through this column list, so a password hash can never
// ride along to the browser by accident.
const PUBLIC_COLUMNS =
  'id, email, name, phone, preferred_title, notes, age, address, block, photo_path, role, is_active, created_at, last_login_at';

/** Sessions belong to a user through the JSON blob express-session stores. */
function deleteUserSessions(id) {
  return db.run("DELETE FROM sessions WHERE (sess->>'userId')::bigint = ?", id);
}

function findByEmail(email) {
  return db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', normalizeEmail(email));
}

function findById(id) {
  return db.get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, id);
}

function findForAuth(email) {
  return db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND is_active = 1', normalizeEmail(email));
}

async function create({ email, name, password, phone = '', preferredTitle = '' }) {
  const digest = await hashPassword(password);
  const result = await db.insert(
    `INSERT INTO users (email, name, phone, preferred_title, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'customer')`,
    normalizeEmail(email),
    normalizeText(name, 80),
    normalizePhone(phone) || null,
    normalizeText(preferredTitle, 24) || null,
    digest,
  );
  return findById(result.id);
}

async function verifyCredentials(email, password) {
  const user = await findForAuth(email);
  if (!user) {
    // Hash a throwaway value so timing does not reveal unknown accounts.
    await verifyPassword(password || '', '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    return { ok: false, reason: 'invalid' };
  }
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? { ok: true, user } : { ok: false, reason: 'invalid' };
}

/**
 * Edit the customer's own details. A field left out of `values` keeps whatever
 * is already stored, so a form that only posts part of the profile cannot
 * quietly blank the rest of it.
 */
async function updateProfile(id, values = {}) {
  const user = await findById(id);
  if (!user) return null;
  const kept = (key, incoming) => (incoming === undefined ? user[key] : incoming);
  const block = values.block === undefined
    ? user.block
    : (profile.isBlock(values.block) ? normalizeText(values.block, 40) : null);

  await db.run(
    `UPDATE users SET name = ?, phone = ?, preferred_title = ?, notes = ?, age = ?, address = ?, block = ?,
             updated_at = ${NOW}
     WHERE id = ?`,
    kept('name', values.name === undefined ? undefined : normalizeText(values.name, 80)),
    kept('phone', values.phone === undefined ? undefined : normalizePhone(values.phone) || null),
    kept('preferred_title', values.preferredTitle === undefined ? undefined : normalizeText(values.preferredTitle, 24) || null),
    kept('notes', values.notes === undefined ? undefined : normalizeMultiline(values.notes, 500) || null),
    kept('age', values.age === undefined ? undefined : profile.normalizeAge(values.age)),
    kept('address', values.address === undefined ? undefined : profile.normalizeAddress(values.address) || null),
    block,
    id,
  );
  return findById(id);
}

/** Point the account at its avatar, or clear the pointer when it is removed. */
async function setPhoto(id, photoPath) {
  await db.run(`UPDATE users SET photo_path = ?, updated_at = ${NOW} WHERE id = ?`, photoPath || null, id);
  return findById(id);
}

async function changePassword(id, newPassword) {
  const digest = await hashPassword(newPassword);
  await db.run(`UPDATE users SET password_hash = ?, updated_at = ${NOW} WHERE id = ?`, digest, id);
  // Invalidate every outstanding reset link for this account.
  await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', id);
  // …and every signed-in session, so an old device cannot keep working with the
  // password that has just been changed.
  await deleteUserSessions(id);
  return true;
}

async function recordLogin(id) {
  await db.run(`UPDATE users SET last_login_at = ${NOW} WHERE id = ?`, id);
}

async function count() {
  return Number((await db.get('SELECT COUNT(*) AS n FROM users')).n || 0);
}

async function countAdmins() {
  return Number((await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1")).n || 0);
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
async function setRole(id, role) {
  if (role !== 'admin' && role !== 'customer') throw new Error('The only roles are customer and admin.');
  await db.run(`UPDATE users SET role = ?, updated_at = ${NOW} WHERE id = ?`, role, id);
  if (role !== 'admin') await deleteUserSessions(id);
  return findById(id);
}

/** Stop an account signing in — bookings and history stay intact. */
async function setActive(id, active) {
  await db.run(`UPDATE users SET is_active = ?, updated_at = ${NOW} WHERE id = ?`, active ? 1 : 0, id);
  if (!active) {
    await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', id);
    await deleteUserSessions(id);
  }
  return findById(id);
}

/** Make (or promote) a staff login from the portal, with a password that is only ever hashed. */
async function createStaff({ email, name, password }) {
  const user = await create({ email, name, password });
  return setRole(user.id, 'admin');
}

async function promote(email, name = 'Salon team', password = null) {
  const existing = await findByEmail(email);
  if (existing) {
    // Keep the account's own name; the label is only a fallback for a row that
    // was created without one. The password is deliberately left untouched.
    await db.run(
      `UPDATE users SET role = 'admin', name = COALESCE(NULLIF(name, ''), ?), updated_at = ${NOW} WHERE id = ?`,
      normalizeText(name, 80) || 'Salon team',
      existing.id,
    );
    return { user: await findById(existing.id), created: false };
  }
  if (!password) {
    throw new Error(
      'No account with that email yet. Re-run with BOOTSTRAP_ADMIN_PASSWORD set (or use the interactive prompt) to create the staff login.',
    );
  }
  const user = await create({ email, name, password });
  await db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
  return { user: await findById(user.id), created: true };
}

module.exports = {
  findByEmail,
  findById,
  findForAuth,
  create,
  verifyCredentials,
  updateProfile,
  setPhoto,
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
