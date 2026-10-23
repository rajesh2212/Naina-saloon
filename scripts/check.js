'use strict';
/**
 * `npm run check` — reads the configuration, then proves the booking guarantee
 * and the staff portal rules on the live database inside one transaction that is
 * always rolled back, so no test rows survive.
 */
const bcrypt = require('bcryptjs');
const { config, describeConfig } = require('../src/config');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');
const slots = require('../src/lib/slots');
const studio = require('../src/lib/settings');
const dates = require('../src/lib/dates');
const users = require('../src/lib/users');
const records = require('../src/lib/records');
const guards = require('../src/lib/guards');
const { digestToken } = require('../src/lib/password');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const ROLLBACK = '__rollback__';

const info = describeConfig();
console.log('\nConfiguration');
console.log(`  environment        : ${info.env}`);
console.log(`  database           : ${info.database}`);
console.log(`  public url         : ${info.publicUrl}`);
console.log(`  captcha            : ${info.captchaProvider} (always verified server-side)`);
console.log(`  email              : ${info.mailEnabled ? 'SMTP configured' : info.mailDevOutbox === 'file' ? 'dev outbox only' : 'NOT CONFIGURED — reset links cannot be sent'}`);
console.log(`  photographs        : ${info.photos.present}/${info.photos.total} real photos, ${info.photos.illustrative} tagged illustrative${info.photos.empty ? `, ${info.photos.empty} empty` : ''}`);
record('SESSION_SECRET set', info.sessionSecretSet || !config.isProd, info.sessionSecretSet ? '' : '(dev fallback in use)');

migrate({ log: () => {} });
seed();

console.log('\nData');
const serviceCount = db.get('SELECT COUNT(*) AS n FROM services WHERE is_active = 1 AND is_bookable = 1').n;
const dayCount = db.get('SELECT COUNT(*) AS n FROM opening_hours').n;
console.log(`  slots generated so far: ${db.get('SELECT COUNT(*) AS n FROM slots').n}`);
record('service catalogue seeded', serviceCount > 0, `${serviceCount} bookable services`);
record('weekday rows present', dayCount === 7, `${dayCount}/7`);

const rules = studio.bookingRules();
console.log(`  booking rules: ${rules.stepMinutes} min spacing, ${rules.horizonDays} days ahead, ${rules.leadMinutes} min notice, ${rules.maxActivePerUser} open bookings per account`);

console.log('\nBooking integrity (everything below is rolled back)');

function makeUser(email, name, role = 'customer') {
  const hash = bcrypt.hashSync('check-password-1', 4);
  const inserted = db.run(
    'INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    email,
    name,
    hash,
    role,
  );
  return { id: inserted.lastInsertRowid, name };
}

/**
 * Runs the portal guard against a stub request. `reached` is only true when the
 * route would have executed, which is the whole access control claim.
 */
function guardReaches(userId) {
  let reached = false;
  const res = {
    locals: {},
    status() { return this; },
    json() { return this; },
    render() { return this; },
    redirect() { return this; },
  };
  guards.requireAdmin(
    { session: userId ? { userId } : {}, accepts: () => 'html' },
    res,
    () => { reached = true; },
  );
  return reached;
}

try {
  db.transaction(() => {
    const service = db.get(
      'SELECT id, name, duration_minutes FROM services WHERE is_bookable = 1 AND is_active = 1 ORDER BY id LIMIT 1',
    );
    const date = dates.addDays(dates.salonClock().date, 3);
    const free = slots.availableSlots(service.id, date).slots;

    record('availability comes from the database', free.length > 0, `${free.length} free slot(s) on ${date} for ${service.name}`);
    if (!free.length) throw new Error(ROLLBACK);

    const userA = makeUser(`check-a-${Date.now()}@invalid.example`, 'Integrity Check A');
    const userB = makeUser(`check-b-${Date.now()}@invalid.example`, 'Integrity Check B');

    const booking = slots.createBooking({
      userId: userA.id,
      serviceId: service.id,
      slotId: free[0].id,
      contactName: userA.name,
      contactPhone: '9999999999',
    });
    record('first request is created as pending', booking.status === 'pending', `#${booking.id} at ${booking.start_time}`);

    record(
      'taken slot disappears from availability',
      !slots.availableSlots(service.id, date).slots.some((slot) => slot.id === free[0].id),
    );

    let conflict = null;
    try {
      slots.createBooking({
        userId: userB.id,
        serviceId: service.id,
        slotId: free[0].id,
        contactName: userB.name,
        contactPhone: '8888888888',
      });
    } catch (error) {
      conflict = error;
    }
    record(
      'second request for the same slot is refused',
      Boolean(conflict && conflict.status === 409),
      conflict ? conflict.message : 'a double booking was allowed',
    );

    let indexError = null;
    try {
      db.run(
        "INSERT INTO bookings (slot_id, user_id, service_id, status, contact_name) VALUES (?, ?, ?, 'confirmed', 'Direct insert')",
        free[0].id,
        userB.id,
        service.id,
      );
    } catch (error) {
      indexError = error;
    }
    record('unique index blocks a direct duplicate insert', Boolean(indexError), indexError ? 'constraint fired' : 'constraint did not fire');

    const confirmed = slots.setBookingStatus({ bookingId: booking.id, status: 'confirmed', staffNote: 'Desk confirmed' });
    record(
      'staff can confirm a pending request',
      confirmed.status === 'confirmed' && confirmed.staff_note === 'Desk confirmed',
      `#${confirmed.id} is ${confirmed.status}`,
    );
    let clashAfterConfirm = null;
    try {
      slots.createBooking({
        userId: userB.id,
        serviceId: service.id,
        slotId: free[0].id,
        contactName: userB.name,
        contactPhone: '9800000000',
      });
    } catch (error) {
      clashAfterConfirm = error;
    }
    record(
      'a confirmed slot still refuses a second booking',
      Boolean(clashAfterConfirm && clashAfterConfirm.status === 409),
      clashAfterConfirm ? clashAfterConfirm.message : 'a double booking was allowed',
    );

    const cancelled = slots.cancelBooking({ bookingId: booking.id, userId: userA.id });
    record('cancelling frees the booking', cancelled.status === 'cancelled');
    record(
      'freed slot is bookable again',
      slots.availableSlots(service.id, date).slots.some((slot) => slot.id === free[0].id),
    );

    let foreignGuard = null;
    try {
      slots.cancelBooking({ bookingId: booking.id, userId: userB.id });
    } catch (error) {
      foreignGuard = error;
    }
    record('another account cannot act on someone’s booking', Boolean(foreignGuard), foreignGuard ? foreignGuard.message : 'not blocked');

    // ------------------------------------------------------- staff portal rules
    console.log('\nStaff portal rules');
    if (free.length > 1) {
      const served = slots.createBooking({
        userId: userA.id,
        serviceId: service.id,
        slotId: free[1].id,
        contactName: userA.name,
        contactPhone: '9999999999',
      });
      const completed = slots.setBookingStatus({ bookingId: served.id, status: 'completed' });
      record('staff can mark a request served', completed.status === 'completed', `#${completed.id}`);
      record(
        'a served appointment keeps its time off the market',
        !slots.availableSlots(service.id, date).slots.some((slot) => slot.id === free[1].id),
      );
      record(
        '…but it is not an open booking for the client',
        slots.activeBookingCount(userA.id) === 0,
        `${slots.activeBookingCount(userA.id)} open`,
      );

      let servedClash = null;
      try {
        db.run(
          "INSERT INTO bookings (slot_id, user_id, service_id, status, contact_name) VALUES (?, ?, ?, 'completed', 'Direct insert')",
          free[1].id,
          userB.id,
          service.id,
        );
      } catch (error) {
        servedClash = error;
      }
      record('the widened unique index covers served bookings too', Boolean(servedClash), servedClash ? 'constraint fired' : 'a second client could take it');

      const agenda = records.dayRows(date).filter((row) => row.booking_id);
      record('the day sheet sees who holds each time', agenda.length >= 1, `${agenda.length} held slot(s)`);
    }

    const staffUser = makeUser(`check-staff-${Date.now()}@invalid.example`, 'Integrity Check Staff', 'admin');
    record('the portal guard lets an admin through', guardReaches(staffUser.id));
    record('…and refuses a signed-in customer', !guardReaches(userA.id));
    record('…and refuses an anonymous request', !guardReaches(null));

    const searched = records.searchBookings({ term: 'Integrity Check', sort: 'soonest' });
    record('staff search matches the test requests', searched.total >= 2, `${searched.total} hit(s)`);

    const hostile = records.searchBookings({ sort: "'; DROP TABLE bookings; --", status: 'nonsense', from: 'yesterday', page: 99 });
    const tableStillThere = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookings'");
    record(
      'a hostile filter falls back instead of reaching SQL',
      hostile.sort === 'newest' && hostile.status === 'all' && Boolean(tableStillThere),
      `${hostile.sort} / ${hostile.status} / page ${hostile.page}`,
    );

    const profile = records.customerForStaff(userA.id);
    record('customer reads never carry a password hash', Boolean(profile) && !('password_hash' in profile), `#${userA.id}`);
    record(
      'a roster filter outside the allowlist is ignored',
      records.searchCustomers({ filter: "role='admin' OR 1=1" }).filter === 'all',
    );

    const wallClock = dates.slotToIso(date, '10:30');
    record(
      'a salon wall time resolves to one real instant',
      Boolean(wallClock) && dates.formatStamp(wallClock).includes('10:30 am'),
      `${date} 10:30 → ${wallClock}`,
    );
    record(
      'an invented zone name is refused rather than guessed',
      dates.isValidTimeZone('Mars/Phobos') === false && dates.isValidTimeZone(dates.salonZone()) === true,
      dates.zoneTag(),
    );

    record('reset tokens are stored as sha-256 digests', digestToken('sample').length === 64);

    throw new Error(ROLLBACK);
  });
} catch (error) {
  if (error.message !== ROLLBACK) record('integrity suite ran', false, error.message);
  else console.log('  (transaction rolled back — no test rows kept)');
}

(async () => {
  console.log('\nPassword change hygiene (throwaway account, deleted afterwards)');
  const stamp = Date.now();
  const email = `check-pw-${stamp}@invalid.example`;
  const temp = makeUser(email, 'Integrity Check PW');
  try {
    db.run(
      'INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)',
      `check-sess-${stamp}`,
      JSON.stringify({
        cookie: { originalMaxAge: 60000, expires: new Date(Date.now() + 60000).toISOString() },
        userId: temp.id,
      }),
      Date.now() + 600_000,
    );
    db.run(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))",
      temp.id,
      digestToken('check-token'),
    );

    await users.changePassword(temp.id, 'check-password-2');

    record(
      'changing a password signs every other device out',
      db.get("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(sess, '$.userId') = ?", temp.id).n === 0,
    );
    record(
      '…and drops the account’s outstanding reset links',
      db.get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND used_at IS NULL', temp.id).n === 0,
    );
    const outcome = await users.verifyCredentials(email, 'check-password-2');
    record('the new password is the one that verifies', outcome.ok === true);
  } finally {
    db.run('DELETE FROM password_resets WHERE user_id = ?', temp.id);
    db.run('DELETE FROM sessions WHERE json_extract(sess, \'$.userId\') = ?', temp.id);
    db.run('DELETE FROM users WHERE id = ?', temp.id);
  }

  const after = db.get('SELECT COUNT(*) AS n FROM bookings').n;
  console.log(`\n  bookings left in the database after rollback: ${after}`);
  db.closeDatabase();

  const failed = results.filter((item) => !item.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length) {
    failed.forEach((item) => console.log(`  FAILED: ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));
    process.exitCode = 1;
  }
})();
