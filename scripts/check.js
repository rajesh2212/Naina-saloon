'use strict';
/**
 * `npm run check` — reads the configuration, then proves the booking guarantee
 * and the staff portal rules on the live database inside one transaction that is
 * always rolled back, so no test rows survive. The staff-account, site-detail and
 * ticket groups afterwards cannot sit in that transaction (bcrypt and pdf-lib are
 * async), so they create throwaway rows — and, for tickets, throwaway PDFs — and
 * delete them again.
 */
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
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
const profileLib = require('../src/lib/profile');
const uploads = require('../src/lib/uploads');
const ticket = require('../src/lib/ticket');
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

/**
 * Runs the booking gate against a stub request for an already-loaded account.
 * `reached` means the booking route would have executed, which is the whole
 * claim that the rule is enforced server-side.
 */
function gateOutcome(user, accepts = 'html') {
  let reached = false;
  let redirect = null;
  let payload = null;
  const res = {
    locals: { currentUser: user },
    status() { return this; },
    json(body) { payload = body; return this; },
    redirect(to) { redirect = to; return this; },
    render() { return this; },
  };
  guards.requireProfile(
    { method: 'GET', originalUrl: '/book', session: {}, accepts: () => accepts },
    res,
    () => { reached = true; },
  );
  return { reached, redirect, payload };
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

    // ------------------------------------- profile completion and the booking gate
    console.log('\nProfile completion and the booking gate');

    record(
      'the Block list is the seven around Bhadrak, spelled as the dropdown shows them',
      profileLib.BLOCKS.join('|') ===
        'Bhadrak Block|Basudevpur Block|Bhandaripokhari Block|Bonth Block|Chandabali Block|Dhamnagar Block|Tihidi Block',
      `${profileLib.BLOCKS.length} entries`,
    );

    const nothing = { name: '', phone: '', age: null, address: '', block: '', photo_path: null };
    const almost = { ...nothing, name: 'Gradual G', phone: '94397 12994', age: 29, photo_path: '/uploads/avatars/7-0123456789ab.jpg' };
    const ladder = [
      profileLib.completeness({ ...nothing, name: 'Gradual G' }).percent,
      profileLib.completeness({ ...nothing, name: 'Gradual G', phone: '94397 12994' }).percent,
      profileLib.completeness({ ...almost, photo_path: null }).percent,
      profileLib.completeness(almost).percent,
      profileLib.completeness({ ...almost, address: 'Near Lucky Mess' }).percent,
      profileLib.completeness({ ...almost, address: 'Near Lucky Mess', block: 'Bhadrak Block' }).percent,
    ];
    record(
      'the bar reads 20 / 40 / 60 / 80 / 80 / 100 as the details land',
      ladder.join(',') === '20,40,60,80,80,100',
      ladder.join(' → '),
    );
    record(
      'an address with no Block chosen does not close the profile',
      profileLib.completeness({ ...almost, address: 'Near Lucky Mess' }).percent === 80,
    );
    record(
      '…and neither does every detail except the name',
      profileLib.completeness({ ...almost, name: '', address: 'Near Lucky Mess', block: 'Bhadrak Block' }).percent === 80,
    );
    record(
      'the missing list names what is still to add',
      profileLib.completeness({ ...nothing, name: 'Gradual G' }).missing.join(',') === 'phone number,age,profile photo,address,Block',
      profileLib.completeness({ ...nothing, name: 'Gradual G' }).missing.join(', '),
    );
    record('an age of 0 or 200 is never accepted by the maths', profileLib.normalizeAge('0') === null && profileLib.normalizeAge('200') === null && profileLib.normalizeAge('29') === 29);
    record('a Block typed by hand is checked against the list', profileLib.isBlock('Bhadrak Block') && !profileLib.isBlock('Kolkata Block'));

    const blockRow = makeUser(`check-block-${Date.now()}@invalid.example`, 'Column Check');
    let blocksWritten = 0;
    for (const block of profileLib.BLOCKS) {
      try {
        db.run('UPDATE users SET block = ? WHERE id = ?', block, blockRow.id);
        blocksWritten += 1;
      } catch {
        /* counted by the record below */
      }
    }
    record('the column accepts every Block the dropdown offers', blocksWritten === profileLib.BLOCKS.length, `${blocksWritten}/${profileLib.BLOCKS.length}`);
    let foreignBlockError = null;
    try {
      db.run('UPDATE users SET block = ? WHERE id = ?', 'Kolkata Block', blockRow.id);
    } catch (error) {
      foreignBlockError = error;
    }
    record('…and the database itself refuses one outside the seven', Boolean(foreignBlockError), foreignBlockError ? 'constraint fired' : 'row written');
    let sillyAgeError = null;
    try {
      db.run('UPDATE users SET age = ? WHERE id = ?', 0, blockRow.id);
    } catch (error) {
      sillyAgeError = error;
    }
    record('the same column guard covers the age', Boolean(sillyAgeError), sillyAgeError ? 'constraint fired' : 'row written');

    record(
      'a path outside the avatars folder is never treated as one of ours',
      ['../../public/assets/hero.jpg', '/uploads/avatars/../secrets.env', '/uploads/avatars/', 'uploads/avatars/x.jpg',
       '/uploads/avatars/nested/x.jpg', '/uploads/avatars/x.png?token=1', '/etc/passwd', '']
        .every((candidate) => uploads.safeRelativePath(candidate) === null)
        && uploads.safeRelativePath('/uploads/avatars/7-0123456789ab.jpg') === '/uploads/avatars/7-0123456789ab.jpg',
    );
    record('deleting a photo leaves any file it does not own alone', uploads.removeAvatar('/assets/hero.jpg') === false);

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    record('real PNG bytes are accepted', uploads.decodeImage(`data:image/png;base64,${pngBytes.toString('base64')}`).ok === true);
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const forgery = uploads.decodeImage(`data:image/png;base64,${svgBytes.toString('base64')}`);
    record('bytes that are not a picture are refused whatever mime they claim', forgery.ok === false, forgery.error);
    record('junk that is not base64 at all is refused', uploads.decodeImage('data:image/png;base64,!!!!not base64!!!!').ok === false);
    record('an oversized payload is refused before anything is written', uploads.decodeImage(`data:image/png;base64,${'A'.repeat(uploads.MAX_BYTES * 2)}`).ok === false);
    record('an empty pick is a skip, not an error', uploads.decodeImage('').skipped === true);

    const gateClosed = gateOutcome(users.findById(userA.id));
    record(
      'a signed-in customer with an incomplete profile cannot open the booking page',
      gateClosed.reached === false && gateClosed.redirect === '/account/profile',
      gateClosed.redirect,
    );
    const gateJson = gateOutcome(users.findById(userA.id), 'json');
    record(
      '…and the booking API answers 403 instead of a redirect a script can follow',
      gateJson.reached === false && Boolean(gateJson.payload) && gateJson.payload.profileIncomplete === true
        && gateJson.payload.redirectTo === '/account/profile',
      gateJson.payload ? String(gateJson.payload.error).slice(0, 40) : 'no JSON',
    );
    record('an anonymous request is sent to sign in first', gateOutcome(null).redirect === '/auth/login');
    record('staff logins are exempt — they book at the counter', gateOutcome(users.findById(staffUser.id)).reached === true);

    const filled = users.setPhoto(
      users.updateProfile(userA.id, {
        name: 'Gradual G',
        phone: '94397 12994',
        age: 29,
        address: 'Near Lucky Mess, College Road',
        block: 'Bhadrak Block',
      }).id,
      '/uploads/avatars/7-0123456789ab.jpg',
    );
    record('a complete profile gets through the gate', gateOutcome(filled).reached === true, `${profileLib.completeness(filled).percent}%`);
    record('…and it closes again the moment one detail is taken back out', gateOutcome(users.setPhoto(userA.id, null)).reached === false);

    const preserved = users.updateProfile(userA.id, { notes: 'Prefers mornings' });
    record(
      'a save that omits a detail leaves the stored value in place',
      preserved.age === 29 && preserved.block === 'Bhadrak Block' && Boolean(preserved.address),
    );
    record('…but a Block the form never offered is dropped rather than written', users.updateProfile(userA.id, { block: 'Delhi Block' }).block === null);

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

  console.log('\nStaff logins managed from the portal (throwaway rows, deleted afterwards)');
  const staffStamp = Date.now();
  const existingEmail = `check-promote-${staffStamp}@invalid.example`;
  const freshEmail = `check-staff-${staffStamp}@invalid.example`;
  const detailsBefore = new Map(
    studio.DETAIL_FIELDS.map((field) => {
      const row = db.get('SELECT value FROM settings WHERE key = ?', field.key);
      return [field.key, row ? row.value : undefined];
    }),
  );
  const madeIds = [];
  try {
    const kept = await users.create({ email: existingEmail, name: 'Kept Name', password: 'check-password-1' });
    madeIds.push(kept.id);

    // The bug this catches: promote() once bound two values to one placeholder,
    // threw, and the terminal bootstrap silently never made a staff account.
    const promoted = await users.promote(existingEmail, 'Fallback Name', null);
    record(
      'promoting an existing account keeps their own name',
      promoted.created === false && promoted.user.name === 'Kept Name' && promoted.user.role === 'admin',
      `${promoted.user.name} · ${promoted.user.role}`,
    );
    record(
      '…and the password they already chose still signs them in',
      (await users.verifyCredentials(existingEmail, 'check-password-1')).ok === true,
    );
    let bootstrapError = null;
    try {
      await users.promote(`check-none-${staffStamp}@invalid.example`, 'Nobody', null);
    } catch (error) {
      bootstrapError = error;
    }
    record('a staff login with no password for an unknown email is refused', Boolean(bootstrapError), bootstrapError ? 'needs a password' : 'row created anyway');

    const fresh = await users.createStaff({ email: freshEmail, name: 'Portal Staff', password: 'check-password-1' });
    madeIds.push(fresh.id);
    record('the portal can make a staff login', fresh.role === 'admin' && fresh.is_active === 1, `#${fresh.id}`);
    record(
      'the staff list never carries a password hash',
      users.listStaff().every((row) => !('password_hash' in row)) && users.listStaff().some((row) => row.id === fresh.id),
      `${users.listStaff().length} staff row(s)`,
    );

    db.run(
      'INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)',
      `check-role-${staffStamp}`,
      JSON.stringify({ cookie: { originalMaxAge: 60000 }, userId: fresh.id }),
      Date.now() + 600_000,
    );
    db.run(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))",
      fresh.id,
      digestToken('check-staff-token'),
    );
    users.setRole(fresh.id, 'customer');
    record(
      'taking the staff role closes their open portal session',
      db.get("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(sess, '$.userId') = ?", fresh.id).n === 0,
    );

    users.setActive(fresh.id, false);
    record(
      'switching a login off stops it signing in at all',
      (await users.verifyCredentials(freshEmail, 'check-password-1')).ok === false,
    );
    record(
      '…and drops their outstanding reset links',
      db.get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND used_at IS NULL', fresh.id).n === 0,
    );
    record(
      '…but leaves the account itself, and its bookings, in place',
      Boolean(db.get('SELECT id FROM users WHERE id = ?', fresh.id).id),
    );

    console.log('\nBusiness details held by the portal instead of .env');
    const written = studio.saveSalonDetails({ salon_name: 'Check Parlour', salon_phone: '94397 12995' });
    const live = studio.salonDetails();
    record('two details report as saved', written.length === 2, written.join(', '));
    record(
      'the saved name wins over the environment value',
      live.name === 'Check Parlour' && live.name !== studio.baseDetail('name'),
      `${studio.baseDetail('name')} → ${live.name}`,
    );
    record(
      '…and is pushed into the running config, so the header and the mails change without a restart',
      config.salon.name === 'Check Parlour',
    );
    record('a phone typed by staff rebuilds the tel: link', live.phoneHref === '+919439712995', live.phoneHref);
    record('the saved keys are listed as portal-held', studio.savedDetailKeys().has('salon_name'));
    record(
      '…and the studio clock row is not swept in with them',
      !studio.savedDetailKeys().has('salon_timezone'),
      [...studio.savedDetailKeys()].join(', '),
    );
    studio.saveSalonDetails({ salon_name: '' });
    record(
      'an empty box hands the value back to .env',
      studio.salonDetails().name === studio.baseDetail('name') && Boolean(studio.baseDetail('name')),
      studio.salonDetails().name,
    );
    record(
      '…and every rendered detail has a value to fall back on',
      studio.DETAIL_FIELDS.filter((field) => field.required)
        .every((field) => Boolean(studio.baseDetail(field.field))),
    );
  } finally {
    for (const id of madeIds) {
      db.run('DELETE FROM password_resets WHERE user_id = ?', id);
      db.run("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?", id);
      db.run('DELETE FROM users WHERE id = ?', id);
    }
    for (const [key, value] of detailsBefore) {
      if (value === undefined) db.run('DELETE FROM settings WHERE key = ?', key);
      else studio.setSetting(key, value);
    }
    studio.applySalonDetails();
  }

  // ------------------------------------------------------- booking tickets
  // pdf-lib is async, so this group cannot sit in the rolled-back transaction
  // above. It makes its own bookings and its own PDF, then deletes both.
  console.log('\nConfirmed-booking tickets (throwaway rows and files, deleted afterwards)');
  const ticketStamp = Date.now();
  const ticketOwner = makeUser(`check-ticket-${ticketStamp}@invalid.example`, 'Ticket Checker');
  const ticketFiles = [];
  let ticketBooking = null;
  try {
    const service = db.get('SELECT id FROM services WHERE is_bookable = 1 AND is_active = 1 ORDER BY id LIMIT 1');
    const free = slots.availableSlots(service.id, dates.addDays(dates.salonClock().date, 4)).slots;
    if (!free.length) throw new Error('no free slot to build a ticket from');

    record(
      'only a confirmed or served request can carry a ticket',
      ticket.TICKET_STATUSES.join(',') === 'confirmed,completed',
      ticket.TICKET_STATUSES.join(', '),
    );

    ticketBooking = slots.createBooking({
      userId: ticketOwner.id,
      serviceId: service.id,
      slotId: free[0].id,
      contactName: 'Ticket Checker',
      contactPhone: '9439712994',
    });
    const expected = path.join(ticket.TICKET_DIR, `booking-${ticketBooking.id}.pdf`);

    const whilePending = await ticket.ensure(ticketBooking.id);
    record(
      'a pending request is refused a ticket',
      whilePending.ok === false && whilePending.reason === 'not-confirmed' && !fs.existsSync(expected),
      whilePending.reason,
    );
    let pendingIssue = null;
    try {
      await ticket.issue(ticketBooking.id);
    } catch (error) {
      pendingIssue = error;
    }
    record('…and the staff-side issue call throws rather than writing one', Boolean(pendingIssue), pendingIssue ? pendingIssue.message : 'a PDF was made');

    slots.setBookingStatus({ bookingId: ticketBooking.id, status: 'confirmed', staffNote: 'Desk confirmed' });
    const first = await ticket.ensure(ticketBooking.id);
    ticketFiles.push(first.file);
    const bytes = first.ok ? fs.readFileSync(first.file) : Buffer.alloc(0);
    record(
      'a confirmed request writes a real PDF',
      first.ok === true && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 10_240,
      `${Math.round(bytes.length / 1024)} KB`,
    );
    const stored = db.get('SELECT ticket_path, ticket_issued_at, user_id FROM bookings WHERE id = ?', ticketBooking.id);
    record(
      '…and the booking remembers where it lives and when it was issued',
      stored.ticket_path === first.urlPath && Boolean(stored.ticket_issued_at),
      `${stored.ticket_path} · ${stored.ticket_issued_at}`,
    );
    record(
      'the row carries the owner, so the download route can check who is asking',
      stored.user_id === ticketOwner.id && ticket.ticketRow(ticketBooking.id).user_id === ticketOwner.id,
    );
    const issuedAt = fs.statSync(first.file).mtimeMs;
    const again = await ticket.ensure(ticketBooking.id);
    record(
      'asking twice serves the same file instead of rewriting it',
      again.urlPath === first.urlPath && fs.statSync(again.file).mtimeMs === issuedAt,
    );
    fs.unlinkSync(first.file);
    const rebuilt = await ticket.ensure(ticketBooking.id);
    ticketFiles.push(rebuilt.file);
    record(
      'a file deleted from disk is regenerated, so the link never dies',
      rebuilt.ok === true && fs.existsSync(rebuilt.file) && fs.statSync(rebuilt.file).size > 10_240,
    );

    slots.setBookingStatus({ bookingId: ticketBooking.id, status: 'cancelled', staffNote: 'Moved by phone' });
    const afterCancel = await ticket.ensure(ticketBooking.id);
    record(
      'a booking taken back after confirming stops offering its ticket',
      afterCancel.ok === false && afterCancel.reason === 'not-confirmed',
      afterCancel.reason,
    );

    const rupee = ticket.safe('₹1,200 — 3:30 pm – 5:00 pm · “bridal” …');
    record(
      'the ticket font survives the rupee, the dash and the ellipsis',
      rupee.includes('Rs') && rupee.includes('-') && [...rupee].every((ch) => ch.charCodeAt(0) <= 255),
      rupee,
    );
  } catch (error) {
    record('ticket suite ran', false, error.message);
  } finally {
    if (ticketBooking) db.run('DELETE FROM bookings WHERE id = ?', ticketBooking.id);
    for (const file of ticketFiles) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
    db.run('DELETE FROM users WHERE id = ?', ticketOwner.id);
  }

  const after = db.get('SELECT COUNT(*) AS n FROM bookings').n;
  console.log(`\n  bookings left in the database after cleanup: ${after}`);
  db.closeDatabase();

  const failed = results.filter((item) => !item.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length) {
    failed.forEach((item) => console.log(`  FAILED: ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));
    process.exitCode = 1;
  }
})();
