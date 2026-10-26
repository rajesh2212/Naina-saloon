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

// One async main: every read below is a round trip to a hosted Postgres, so the
// whole suite awaits rather than assuming a synchronous driver.
(async () => {
await migrate({ log: () => {} });
await seed();

console.log('\nData');
const serviceCount = await db.value('SELECT COUNT(*) FROM services WHERE is_active = 1 AND is_bookable = 1');
const dayCount = await db.value('SELECT COUNT(*) FROM opening_hours');
console.log(`  slots generated so far: ${await db.value('SELECT COUNT(*) FROM slots')}`);
record('service catalogue seeded', serviceCount > 0, `${serviceCount} bookable services`);
record('weekday rows present', dayCount === 7, `${dayCount}/7`);

const rules = await studio.bookingRules();
console.log(`  booking rules: ${rules.stepMinutes} min spacing, ${rules.horizonDays} days ahead, ${rules.leadMinutes} min notice, ${rules.maxActivePerUser} open bookings per account`);

console.log('\nBooking integrity (everything below is rolled back)');

async function makeUser(email, name, role = 'customer') {
  const hash = bcrypt.hashSync('check-password-1', 4);
  const inserted = await db.insert(
    'INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    email,
    name,
    hash,
    role,
  );
  return { id: inserted.id, name };
}

/**
 * Runs the portal guard against a stub request. `reached` is only true when the
 * route would have executed, which is the whole access control claim.
 */
async function guardReaches(userId) {
  let reached = false;
  const res = {
    locals: {},
    status() { return this; },
    json() { return this; },
    render() { return this; },
    redirect() { return this; },
  };
  await guards.requireAdmin(
    { session: userId ? { userId } : {}, accepts: () => 'html' },
    res,
    () => { reached = true; },
  );
  return reached;
}

/**
 * Runs the booking gate against a stub request for an already-loaded account.
 * `reached` means the booking route would have executed, which is the whole
 * claim that the rule is enforced server-side. Awaited, because an anonymous
 * request goes through the async sign-in guard before it answers.
 */
async function gateOutcome(user, accepts = 'html') {
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
  await Promise.resolve(
    guards.requireProfile(
      { method: 'GET', originalUrl: '/book', session: {}, accepts: () => accepts },
      res,
      () => { reached = true; },
    ),
  );
  return { reached, redirect, payload };
}

/**
 * Runs one wrapped route handler and waits for it, so a rejected handler fails
 * the check here instead of leaving a half-built body to be read.
 */
async function runHandler(layer, req, res) {
  let error = null;
  await layer.route.stack[0].handle(req, res, (cause) => {
    error = cause || new Error('handler called next()');
  });
  if (error) throw error;
}

try {
  await db.transaction(async () => {
    const service = await db.get(
      'SELECT id, name, duration_minutes FROM services WHERE is_bookable = 1 AND is_active = 1 ORDER BY id LIMIT 1',
    );
    const date = dates.addDays(dates.salonClock().date, 3);
    const free = (await slots.availableSlots(service.id, date)).slots;

    record('availability comes from the database', free.length > 0, `${free.length} free slot(s) on ${date} for ${service.name}`);
    if (!free.length) throw new Error(ROLLBACK);

    const userA = await makeUser(`check-a-${Date.now()}@invalid.example`, 'Integrity Check A');
    const userB = await makeUser(`check-b-${Date.now()}@invalid.example`, 'Integrity Check B');

    const booking = await slots.createBooking({
      userId: userA.id,
      serviceId: service.id,
      slotId: free[0].id,
      contactName: userA.name,
      contactPhone: '9999999999',
    });
    record('first request is created as pending', booking.status === 'pending', `#${booking.id} at ${booking.start_time}`);

    record(
      'taken slot disappears from availability',
      !(await slots.availableSlots(service.id, date)).slots.some((slot) => slot.id === free[0].id),
    );

    let conflict = null;
    try {
      await slots.createBooking({
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
      // Savepointed: the rejected row would otherwise abort the whole rolled-back
      // transaction before the later checks get to run.
      await db.savepoint(() =>
        db.run(
          "INSERT INTO bookings (slot_id, user_id, service_id, status, contact_name) VALUES (?, ?, ?, 'confirmed', 'Direct insert')",
          free[0].id,
          userB.id,
          service.id,
        ),
      );
    } catch (error) {
      indexError = error;
    }
    record('unique index blocks a direct duplicate insert', Boolean(indexError), indexError ? 'constraint fired' : 'constraint did not fire');

    const confirmed = await slots.setBookingStatus({ bookingId: booking.id, status: 'confirmed', staffNote: 'Desk confirmed' });
    record(
      'staff can confirm a pending request',
      confirmed.status === 'confirmed' && confirmed.staff_note === 'Desk confirmed',
      `#${confirmed.id} is ${confirmed.status}`,
    );
    let clashAfterConfirm = null;
    try {
      await slots.createBooking({
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

    const cancelled = await slots.cancelBooking({ bookingId: booking.id, userId: userA.id });
    record('cancelling frees the booking', cancelled.status === 'cancelled');
    record(
      'freed slot is bookable again',
      (await slots.availableSlots(service.id, date)).slots.some((slot) => slot.id === free[0].id),
    );

    let foreignGuard = null;
    try {
      await slots.cancelBooking({ bookingId: booking.id, userId: userB.id });
    } catch (error) {
      foreignGuard = error;
    }
    record('another account cannot act on someone’s booking', Boolean(foreignGuard), foreignGuard ? foreignGuard.message : 'not blocked');

    // ------------------------------------------------------- staff portal rules
    console.log('\nStaff portal rules');
    if (free.length > 1) {
      const served = await slots.createBooking({
        userId: userA.id,
        serviceId: service.id,
        slotId: free[1].id,
        contactName: userA.name,
        contactPhone: '9999999999',
      });
      const completed = await slots.setBookingStatus({ bookingId: served.id, status: 'completed' });
      record('staff can mark a request served', completed.status === 'completed', `#${completed.id}`);
      record(
        'a served appointment keeps its time off the market',
        !(await slots.availableSlots(service.id, date)).slots.some((slot) => slot.id === free[1].id),
      );
      const stillOpen = await slots.activeBookingCount(userA.id);
      record('…but it is not an open booking for the client', stillOpen === 0, `${stillOpen} open`);

      let servedClash = null;
      try {
        await db.savepoint(() =>
          db.run(
            "INSERT INTO bookings (slot_id, user_id, service_id, status, contact_name) VALUES (?, ?, ?, 'completed', 'Direct insert')",
            free[1].id,
            userB.id,
            service.id,
          ),
        );
      } catch (error) {
        servedClash = error;
      }
      record('the widened unique index covers served bookings too', Boolean(servedClash), servedClash ? 'constraint fired' : 'a second client could take it');

      const agenda = (await records.dayRows(date)).filter((row) => row.booking_id);
      record('the day sheet sees who holds each time', agenda.length >= 1, `${agenda.length} held slot(s)`);
    }

    const staffUser = await makeUser(`check-staff-${Date.now()}@invalid.example`, 'Integrity Check Staff', 'admin');
    record('the portal guard lets an admin through', await guardReaches(staffUser.id));
    record('…and refuses a signed-in customer', !(await guardReaches(userA.id)));
    record('…and refuses an anonymous request', !(await guardReaches(null)));

    const searched = await records.searchBookings({ term: 'Integrity Check', sort: 'soonest' });
    record('staff search matches the test requests', searched.total >= 2, `${searched.total} hit(s)`);

    const hostile = await records.searchBookings({ sort: "'; DROP TABLE bookings; --", status: 'nonsense', from: 'yesterday', page: 99 });
    const tableStillThere = await db.get("SELECT to_regclass('public.bookings') AS name");
    record(
      'a hostile filter falls back instead of reaching SQL',
      hostile.sort === 'newest' && hostile.status === 'all' && Boolean(tableStillThere && tableStillThere.name),
      `${hostile.sort} / ${hostile.status} / page ${hostile.page}`,
    );

    const profile = await records.customerForStaff(userA.id);
    record('customer reads never carry a password hash', Boolean(profile) && !('password_hash' in profile), `#${userA.id}`);
    record(
      'a roster filter outside the allowlist is ignored',
      (await records.searchCustomers({ filter: "role='admin' OR 1=1" })).filter === 'all',
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

    const blockRow = await makeUser(`check-block-${Date.now()}@invalid.example`, 'Column Check');
    let blocksWritten = 0;
    for (const block of profileLib.BLOCKS) {
      try {
        await db.savepoint(() => db.run('UPDATE users SET block = ? WHERE id = ?', block, blockRow.id));
        blocksWritten += 1;
      } catch {
        /* counted by the record below */
      }
    }
    record('the column accepts every Block the dropdown offers', blocksWritten === profileLib.BLOCKS.length, `${blocksWritten}/${profileLib.BLOCKS.length}`);
    let foreignBlockError = null;
    try {
      await db.savepoint(() => db.run('UPDATE users SET block = ? WHERE id = ?', 'Kolkata Block', blockRow.id));
    } catch (error) {
      foreignBlockError = error;
    }
    record('…and the database itself refuses one outside the seven', Boolean(foreignBlockError), foreignBlockError ? 'constraint fired' : 'row written');
    let sillyAgeError = null;
    try {
      await db.savepoint(() => db.run('UPDATE users SET age = ? WHERE id = ?', 0, blockRow.id));
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

    const gateClosed = await gateOutcome(await users.findById(userA.id));
    record(
      'a signed-in customer with an incomplete profile cannot open the booking page',
      gateClosed.reached === false && gateClosed.redirect === '/account/profile',
      gateClosed.redirect,
    );
    const gateJson = await gateOutcome(await users.findById(userA.id), 'json');
    record(
      '…and the booking API answers 403 instead of a redirect a script can follow',
      gateJson.reached === false && Boolean(gateJson.payload) && gateJson.payload.profileIncomplete === true
        && gateJson.payload.redirectTo === '/account/profile',
      gateJson.payload ? String(gateJson.payload.error).slice(0, 40) : 'no JSON',
    );
    record('an anonymous request is sent to sign in first', (await gateOutcome(null)).redirect === '/auth/login');
    record('staff logins are exempt — they book at the counter', (await gateOutcome(await users.findById(staffUser.id))).reached === true);

    await users.updateProfile(userA.id, {
      name: 'Gradual G',
      phone: '94397 12994',
      age: 29,
      address: 'Near Lucky Mess, College Road',
      block: 'Bhadrak Block',
    });
    const filled = await users.setPhoto(userA.id, '/uploads/avatars/7-0123456789ab.jpg');
    record('a complete profile gets through the gate', (await gateOutcome(filled)).reached === true, `${profileLib.completeness(filled).percent}%`);
    record('…and it closes again the moment one detail is taken back out', (await gateOutcome(await users.setPhoto(userA.id, null))).reached === false);

    const preserved = await users.updateProfile(userA.id, { notes: 'Prefers mornings' });
    record(
      'a save that omits a detail leaves the stored value in place',
      preserved.age === 29 && preserved.block === 'Bhadrak Block' && Boolean(preserved.address),
    );
    record(
      '…but a Block the form never offered is dropped rather than written',
      (await users.updateProfile(userA.id, { block: 'Delhi Block' })).block === null,
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

  console.log('\nPassword change hygiene (throwaway account, deleted afterwards)');
  const stamp = Date.now();
  const email = `check-pw-${stamp}@invalid.example`;
  const temp = await makeUser(email, 'Integrity Check PW');
  try {
    await db.run(
      'INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)',
      `check-sess-${stamp}`,
      JSON.stringify({
        cookie: { originalMaxAge: 60000, expires: new Date(Date.now() + 60000).toISOString() },
        userId: temp.id,
      }),
      Date.now() + 600_000,
    );
    await db.run(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, to_char(now() + interval '10 minutes', 'YYYY-MM-DD HH24:MI:SS'))",
      temp.id,
      digestToken('check-token'),
    );

    await users.changePassword(temp.id, 'check-password-2');

    record(
      'changing a password signs every other device out',
      (await db.value('SELECT COUNT(*) FROM sessions WHERE (sess->>\'userId\')::bigint = ?', temp.id)) === 0,
    );
    record(
      '…and drops the account’s outstanding reset links',
      (await db.value('SELECT COUNT(*) FROM password_resets WHERE user_id = ? AND used_at IS NULL', temp.id)) === 0,
    );
    const outcome = await users.verifyCredentials(email, 'check-password-2');
    record('the new password is the one that verifies', outcome.ok === true);
  } finally {
    await db.run('DELETE FROM password_resets WHERE user_id = ?', temp.id);
    await db.run("DELETE FROM sessions WHERE (sess->>'userId')::bigint = ?", temp.id);
    await db.run('DELETE FROM users WHERE id = ?', temp.id);
  }

  console.log('\nStaff logins managed from the portal (throwaway rows, deleted afterwards)');
  const staffStamp = Date.now();
  const existingEmail = `check-promote-${staffStamp}@invalid.example`;
  const freshEmail = `check-staff-${staffStamp}@invalid.example`;
  const detailsBefore = new Map();
  for (const field of studio.DETAIL_FIELDS) {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', field.key);
    detailsBefore.set(field.key, row ? row.value : undefined);
  }
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
    const roster = await users.listStaff();
    record(
      'the staff list never carries a password hash',
      roster.every((row) => !('password_hash' in row)) && roster.some((row) => row.id === fresh.id),
      `${roster.length} staff row(s)`,
    );

    await db.run(
      'INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)',
      `check-role-${staffStamp}`,
      JSON.stringify({ cookie: { originalMaxAge: 60000 }, userId: fresh.id }),
      Date.now() + 600_000,
    );
    await db.run(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, to_char(now() + interval '10 minutes', 'YYYY-MM-DD HH24:MI:SS'))",
      fresh.id,
      digestToken('check-staff-token'),
    );
    await users.setRole(fresh.id, 'customer');
    record(
      'taking the staff role closes their open portal session',
      (await db.value('SELECT COUNT(*) FROM sessions WHERE (sess->>\'userId\')::bigint = ?', fresh.id)) === 0,
    );

    await users.setActive(fresh.id, false);
    record(
      'switching a login off stops it signing in at all',
      (await users.verifyCredentials(freshEmail, 'check-password-1')).ok === false,
    );
    record(
      '…and drops their outstanding reset links',
      (await db.value('SELECT COUNT(*) FROM password_resets WHERE user_id = ? AND used_at IS NULL', fresh.id)) === 0,
    );
    record(
      '…but leaves the account itself, and its bookings, in place',
      Boolean(await db.value('SELECT id FROM users WHERE id = ?', fresh.id)),
    );

    console.log('\nBusiness details held by the portal instead of .env');
    const written = await studio.saveSalonDetails({ salon_name: 'Check Parlour', salon_phone: '94397 12995' });
    const live = await studio.salonDetails();
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
    const heldKeys = await studio.savedDetailKeys();
    record('the saved keys are listed as portal-held', heldKeys.has('salon_name'));
    record(
      '…and the studio clock row is not swept in with them',
      !heldKeys.has('salon_timezone'),
      [...heldKeys].join(', '),
    );
    await studio.saveSalonDetails({ salon_name: '' });
    const backToEnv = await studio.salonDetails();
    record(
      'an empty box hands the value back to .env',
      backToEnv.name === studio.baseDetail('name') && Boolean(studio.baseDetail('name')),
      backToEnv.name,
    );
    record(
      '…and every rendered detail has a value to fall back on',
      studio.DETAIL_FIELDS.filter((field) => field.required)
        .every((field) => Boolean(studio.baseDetail(field.field))),
    );
  } finally {
    for (const id of madeIds) {
      await db.run('DELETE FROM password_resets WHERE user_id = ?', id);
      await db.run("DELETE FROM sessions WHERE (sess->>'userId')::bigint = ?", id);
      await db.run('DELETE FROM users WHERE id = ?', id);
    }
    for (const [key, value] of detailsBefore) {
      if (value === undefined) await db.run('DELETE FROM settings WHERE key = ?', key);
      else await studio.setSetting(key, value);
    }
    await studio.applySalonDetails();
  }

  // ------------------------------------------------------- booking tickets
  // pdf-lib is async, so this group cannot sit in the rolled-back transaction
  // above. It makes its own bookings and its own PDF, then deletes both.
  console.log('\nConfirmed-booking tickets (throwaway rows and files, deleted afterwards)');
  const ticketStamp = Date.now();
  const ticketOwner = await makeUser(`check-ticket-${ticketStamp}@invalid.example`, 'Ticket Checker');
  const ticketFiles = [];
  let ticketBooking = null;
  try {
    const service = await db.get('SELECT id FROM services WHERE is_bookable = 1 AND is_active = 1 ORDER BY id LIMIT 1');
    const free = (await slots.availableSlots(service.id, dates.addDays(dates.salonClock().date, 4))).slots;
    if (!free.length) throw new Error('no free slot to build a ticket from');

    record(
      'only a confirmed or served request can carry a ticket',
      ticket.TICKET_STATUSES.join(',') === 'confirmed,completed',
      ticket.TICKET_STATUSES.join(', '),
    );

    ticketBooking = await slots.createBooking({
      userId: ticketOwner.id,
      serviceId: service.id,
      slotId: free[0].id,
      contactName: 'Ticket Checker',
      contactPhone: '9439712994',
    });
    const expected = path.join(ticket.TICKET_DIR, `booking-${ticketBooking.id}.pdf`);
    // A PDF left on disk by an older run can already carry this booking number,
    // and `ensure()` would then hand back a file it never wrote. Start clean:
    // everything below is this group's own file, deleted in its finally.
    fs.rmSync(expected, { force: true });

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

    await slots.setBookingStatus({ bookingId: ticketBooking.id, status: 'confirmed', staffNote: 'Desk confirmed' });
    const first = await ticket.ensure(ticketBooking.id);
    ticketFiles.push(first.file);
    const bytes = first.ok ? fs.readFileSync(first.file) : Buffer.alloc(0);
    record(
      'a confirmed request writes a real PDF',
      first.ok === true && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 10_240,
      `${Math.round(bytes.length / 1024)} KB`,
    );
    const stored = await db.get('SELECT ticket_path, ticket_issued_at, user_id FROM bookings WHERE id = ?', ticketBooking.id);
    record(
      '…and the booking remembers where it lives and when it was issued',
      stored.ticket_path === first.urlPath && Boolean(stored.ticket_issued_at),
      `${stored.ticket_path} · ${stored.ticket_issued_at}`,
    );
    const forTicket = await ticket.ticketRow(ticketBooking.id);
    record(
      'the row carries the owner, so the download route can check who is asking',
      stored.user_id === ticketOwner.id && forTicket.user_id === ticketOwner.id,
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

    await slots.setBookingStatus({ bookingId: ticketBooking.id, status: 'cancelled', staffNote: 'Moved by phone' });
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
    if (ticketBooking) await db.run('DELETE FROM bookings WHERE id = ?', ticketBooking.id);
    for (const file of ticketFiles) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
    await db.run('DELETE FROM users WHERE id = ?', ticketOwner.id);
  }

  // ------------------------------------------------------- the account pop-up
  // The fragment is built from the same reads as the /account pages, so what is
  // worth pinning is the split between its two lists, the tick rule, and who is
  // allowed to ask for it at all. These call the real route handlers with stubbed
  // requests, so a rule that moved out of the server would fail here.
  console.log('\nAccount pop-up (throwaway rows and files, deleted afterwards)');
  const ejs = require('ejs');
  const account = require('../src/routes/account');
  const viewsDir = path.join(config.root, 'views');
  const panelLayer = account.stack.find((layer) => layer.route && layer.route.path === '/panel');
  const profilePostLayer = account.stack.find(
    (layer) => layer.route && layer.route.path === '/profile' && layer.route.methods.post,
  );

  /** A res that renders like the app does, so the fragment can be read back. */
  function stubRes(user) {
    return {
      locals: { currentUser: user },
      headers: {},
      view: null,
      body: null,
      statusCode: null,
      redirectTo: null,
      set(key, value) {
        this.headers[String(key).toLowerCase()] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      render(view, locals) {
        this.view = view;
        const file = path.join(viewsDir, `${view}.ejs`);
        this.body = ejs.render(fs.readFileSync(file, 'utf8'), Object.assign({
          currentUser: user,
          isAdmin: user.role === 'admin',
          dates,
          csrfField: () => '<input type="hidden" name="_csrf" value="stubbed">',
        }, locals), { filename: file });
        return this;
      },
      redirect(to) {
        this.redirectTo = to;
        return this;
      },
    };
  }

  function stubReq(user, { body = {}, query = {}, session = {}, panel = null, remember = null } = {}) {
    if (remember) session.returnTo = remember;
    session.csrfToken = session.csrfToken || 'stubbed';
    return {
      method: Object.keys(body).length ? 'POST' : 'GET',
      originalUrl: panel === null ? '/account/profile' : '/account/panel',
      query,
      body,
      session,
      user,
      ip: '127.0.0.1',
      get: (name) => (String(name).toLowerCase() === 'x-naina-panel' ? panel : undefined),
      accepts: () => 'html',
    };
  }

  const panelStamp = Date.now();
  const panelOwner = await makeUser(`check-panel-${panelStamp}@invalid.example`, 'Panel Owner');
  const panelOther = await makeUser(`check-panelother-${panelStamp}@invalid.example`, 'Panel Stranger');
  const panelBookings = [];
  const panelFiles = [];
  try {
    const service = await db.get('SELECT id FROM services WHERE is_bookable = 1 AND is_active = 1 ORDER BY id LIMIT 1');
    const panelStatuses = ['pending', 'confirmed', 'completed', 'rejected', 'cancelled'];
    for (let index = 0; index < panelStatuses.length; index += 1) {
      const day = dates.addDays(dates.salonClock().date, index + 3);
      const free = (await slots.availableSlots(service.id, day)).slots;
      if (!free.length) throw new Error(`no free slot on ${day} to build the two lists from`);
      const made = await slots.createBooking({
        userId: panelOwner.id,
        serviceId: service.id,
        slotId: free[0].id,
        contactName: 'Panel Owner',
        contactPhone: '9439712994',
      });
      panelBookings.push(made.id);
      // Written straight to the row: the staff route only steps between two of
      // these, and the panel has to be tested against all five at once.
      if (panelStatuses[index] !== 'pending') {
        await db.run('UPDATE bookings SET status = ? WHERE id = ?', panelStatuses[index], made.id);
      }
    }

    const loaded = await users.findById(panelOwner.id);
    const groups = await account.panelGroups(loaded);
    const statusesOf = (list) => list.map((b) => b.status).sort().join(',');
    record(
      'Current bookings holds every request the diary still carries',
      statusesOf(groups.current) === 'cancelled,confirmed,pending,rejected',
      statusesOf(groups.current),
    );
    record(
      'Booking history is the whole record, including the served one',
      statusesOf(groups.history) === 'cancelled,completed,confirmed,pending,rejected',
      statusesOf(groups.history),
    );
    record(
      '…so the two overlap on purpose, and only “completed” leaves Current',
      groups.history.length === 5 && groups.current.length === 4 && !groups.current.some((b) => b.status === 'completed'),
    );
    record(
      '…and every row is one of this account’s own bookings',
      groups.history.length === panelBookings.length
        && groups.history.every((b) => panelBookings.includes(b.id)),
      `${groups.history.length} of ${panelBookings.length}`,
    );

    const panelRes = stubRes(loaded);
    await runHandler(panelLayer, stubReq(loaded, { panel: '1' }), panelRes);
    record(
      'the pop-up answers with a fragment, never a page',
      panelRes.view === 'partials/account-panel' && !String(panelRes.body).includes('<!doctype'),
      panelRes.view,
    );
    record(
      '…marked as one, and never cached',
      panelRes.headers['x-naina-panel'] === '1' && panelRes.headers['cache-control'] === 'no-store',
    );
    const fragmentStatuses = (chunk) => [...chunk.matchAll(/pill pill--([a-z]+)/g)].map((m) => m[1]).sort().join(',');
    const [currentFrag, historyFrag] = String(panelRes.body).split('data-panel-list="history"');
    record(
      'the lists it renders are the two it promised',
      fragmentStatuses(currentFrag) === 'cancelled,confirmed,pending,rejected'
        && fragmentStatuses(historyFrag) === 'cancelled,completed,confirmed,pending,rejected',
    );
    record(
      'a ticket link only appears where the booking can carry one',
      (currentFrag.match(/Download ticket/g) || []).length === 1
        && (historyFrag.match(/href="\/account\/ticket/g) || []).length === 2,
    );
    record(
      '…and the panel ends on the sign-out form the site already has',
      panelRes.body.includes('action="/auth/logout"'),
    );

    // The tick is the site’s existing verification rule, not a decoration.
    record(
      'an incomplete profile shows no verification tick',
      !panelRes.body.includes('profile-tick') && profileLib.completeness(loaded).complete === false,
      `${profileLib.completeness(loaded).percent}% · still to add ${profileLib.completeness(loaded).missing.join(', ')}`,
    );
    const whole = stubRes(loaded);
    await runHandler(
      profilePostLayer,
      stubReq(loaded, {
        panel: '1',
        session: {},
        body: {
          name: 'Panel Owner',
          phone: '9439712994',
          preferred_title: '',
          notes: '',
          age: '31',
          address: 'Bagurai, near Lucky Mess',
          block: 'Bhadrak Block',
          photo_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        },
      }),
      whole,
    );
    const savedRow = await users.findById(panelOwner.id);
    panelFiles.push(uploads.absoluteFor(savedRow.photo_path));
    record(
      'saving through the pop-up writes the same columns the page writes',
      savedRow.age === 31 && savedRow.block === 'Bhadrak Block' && Boolean(savedRow.photo_path),
      `${savedRow.age} · ${savedRow.block} · ${savedRow.photo_path}`,
    );
    record(
      '…answers with the rebuilt fragment, so nothing navigates away',
      whole.view === 'partials/account-panel' && whole.redirectTo === null && whole.body.includes('role="status"'),
    );
    record(
      '…shows the saved values back',
      whole.body.includes('>31<') && whole.body.includes('Bhadrak Block'),
    );
    record(
      'the verification tick appears once every rule is met, and not before',
      whole.body.includes('profile-tick') && profileLib.completeness(savedRow).complete === true,
      `${profileLib.completeness(savedRow).percent}%`,
    );

    const refused = stubRes(loaded);
    await runHandler(
      profilePostLayer,
      stubReq(loaded, { panel: '1', body: { name: 'Panel Owner', phone: '9439712994', age: '900', address: '', block: '' } }),
      refused,
    );
    record(
      'a value the page would reject is rejected here too, inline',
      refused.statusCode === 400 && refused.view === 'partials/account-panel' && refused.body.includes('id="ap-age-error"'),
      `${refused.statusCode}`,
    );
    const afterRefusal = await users.findById(panelOwner.id);
    record('…and nothing was written', afterRefusal.age === 31);

    const classic = stubRes(loaded);
    await runHandler(
      profilePostLayer,
      stubReq(loaded, { body: { name: 'Panel Owner', phone: '9439712994', age: '29', address: 'Bagurai', block: 'Bhadrak Block' } }),
      classic,
    );
    const afterClassic = await users.findById(panelOwner.id);
    record(
      'the same form without the pop-up header still redirects, so no-JS is untouched',
      classic.view === null && classic.redirectTo === '/account' && afterClassic.age === 29,
      `${classic.redirectTo}`,
    );

    const editor = stubRes(loaded);
    await runHandler(panelLayer, stubReq(loaded, { panel: '1', query: { edit: 'profile' } }), editor);
    record(
      '“Edit profile” opens the shared editor with its own ids',
      editor.body.includes('id="ap-name"') && !editor.body.includes('id="name"') && editor.body.includes('action="/account/profile"'),
    );
    const photoEditor = stubRes(loaded);
    await runHandler(panelLayer, stubReq(loaded, { panel: '1', query: { edit: 'photo' } }), photoEditor);
    record(
      '“Edit photo” shows only the picker, but carries the stored details along',
      photoEditor.body.includes('name="photo_data"') && !photoEditor.body.includes('id="ap-name"')
        && photoEditor.body.includes('name="block"'),
    );

    // Who may ask. The route sits behind the router-wide guard, and the guard is
    // the same one every other account screen uses.
    const gateAt = account.stack.findIndex((layer) => layer.handle === guards.requireUser);
    const panelAt = account.stack.findIndex((layer) => layer.route && layer.route.path === '/panel');
    record(
      'the pop-up route sits behind requireUser, enforced on the server',
      gateAt === 0 && panelAt > gateAt,
      `guard at ${gateAt}, panel at ${panelAt}`,
    );
    let anonymousReached = false;
    let anonymousTo = null;
    const anonymousRes = stubRes({ id: 0, role: 'customer' });
    anonymousRes.redirect = (to) => {
      anonymousTo = to;
      return anonymousRes;
    };
    await guards.requireUser(
      { method: 'GET', originalUrl: '/account/panel', session: {}, accepts: () => 'html', get: () => undefined },
      anonymousRes,
      () => {
        anonymousReached = true;
      },
    );
    record(
      'an anonymous request never reaches the data — it is sent to sign in',
      anonymousReached === false && anonymousTo === '/auth/login',
      `${anonymousTo}`,
    );
    const stranger = await users.findById(panelOther.id);
    const foreign = await account.panelGroups(stranger);
    record(
      'another signed-in account’s panel holds none of these rows',
      foreign.current.length === 0 && foreign.history.length === 0,
    );
    const foreignRender = stubRes(stranger);
    await runHandler(panelLayer, stubReq(stranger, { panel: '1' }), foreignRender);
    record(
      '…and says so with its own empty state, without leaking the owner',
      foreignRender.body.includes('No current bookings') && !foreignRender.body.includes('Panel Owner'),
    );
  } catch (error) {
    record('account pop-up suite ran', false, error.message);
  } finally {
    for (const id of panelBookings) await db.run('DELETE FROM bookings WHERE id = ?', id);
    for (const file of panelFiles) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* never written, or already gone */
      }
    }
    for (const id of [panelOwner.id, panelOther.id]) {
      await db.run("DELETE FROM sessions WHERE (sess->>'userId')::bigint = ?", id);
      await db.run('DELETE FROM users WHERE id = ?', id);
    }
  }

  // --------------------------------------- the files the app writes for people
  // Ticket PDFs are named booking-<id>.pdf and avatars are somebody's face, so the
  // one rule worth pinning here is that the web server cannot be talked into
  // handing either of them out. These ask a real running app over real HTTP, with
  // no session at all — which is exactly the request that used to succeed.
  console.log('\nCustomer files over HTTP (throwaway rows, files and one port)');
  const { createApp } = require('../src/app');
  const probeFiles = [];
  const probeUsers = [];
  const servedSids = new Set((await db.all('SELECT sid FROM sessions')).map((row) => row.sid));
  let uploadServer = null;
  try {
    const uploadOwner = await makeUser(`uploads-owner-${Date.now()}@example.test`, 'Uploads Owner');
    const uploadOther = await makeUser(`uploads-other-${Date.now()}@example.test`, 'Uploads Other');
    probeUsers.push(uploadOwner.id, uploadOther.id);

    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const savedPhoto = uploads.saveAvatar(uploadOwner.id, tinyPng, null);
    const photoFile = uploads.absoluteFor(savedPhoto.path);
    probeFiles.push(photoFile);
    await db.run('UPDATE users SET photo_path = ? WHERE id = ?', savedPhoto.path, uploadOwner.id);
    const photoName = savedPhoto.path.slice(uploads.URL_PREFIX.length + 1);

    fs.mkdirSync(ticket.TICKET_DIR, { recursive: true });
    const probeTicket = path.join(ticket.TICKET_DIR, 'booking-999999.pdf');
    fs.writeFileSync(probeTicket, Buffer.from('%PDF-1.4 probe\n%%EOF'));
    probeFiles.push(probeTicket);

    const app = createApp();
    uploadServer = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const origin = `http://127.0.0.1:${uploadServer.address().port}`;
    const ask = async (url) => {
      const response = await fetch(`${origin}${url}`);
      return { status: response.status, type: response.headers.get('content-type') || '' };
    };

    record(
      'the files live outside the folder the web server serves',
      !config.uploads.dir.startsWith(`${path.join(config.root, 'public')}${path.sep}`),
      config.uploads.dir,
    );
    record('…and the probe ticket really is on disk', fs.existsSync(probeTicket));
    const ticketAnswer = await ask(`/uploads/tickets/${path.basename(probeTicket)}`);
    record(
      'nobody can download a booking PDF by its filename',
      ticketAnswer.status === 404,
      `${ticketAnswer.status} ${ticketAnswer.type}`,
    );
    record('…nor can the folder be listed', (await ask('/uploads/tickets/')).status === 404);
    record('…and the old location under public/ is gone for good', !fs.existsSync(path.join(config.root, 'public', 'uploads')));

    const anonymousAvatar = await ask(`${uploads.URL_PREFIX}/${photoName}`);
    record(
      'a signed-in customer’s photo is not readable without signing in',
      anonymousAvatar.status === 404 && fs.existsSync(photoFile),
      `${anonymousAvatar.status} ${anonymousAvatar.type}`,
    );
    const strangerName = await ask(`${uploads.URL_PREFIX}/0-deadbeefdeadbeef.jpg`);
    record('…and a name that is not in the database gives nothing away', strangerName.status === 404);

    /** The same handler the app mounted, run against a res that says what it served. */
    const routes = app._router || app.router;
    const avatarLayer = routes.stack.find(
      (layer) => layer.route && layer.route.path === `${uploads.URL_PREFIX}/:name`,
    );
    async function openDoor(user, name) {
      const served = { file: null, status: null };
      const res = {
        locals: { currentUser: user },
        status(code) {
          served.status = code;
          return this;
        },
        end() {
          return this;
        },
        sendFile(file, done) {
          served.file = file;
          if (done) done(null);
          return this;
        },
      };
      await runHandler(avatarLayer, { params: { name }, path: `${uploads.URL_PREFIX}/${name}` }, res);
      return served;
    }

    const ownerRow = await users.findById(uploadOwner.id);
    const otherRow = await users.findById(uploadOther.id);
    record(
      'the owner is handed their own photo, and only that file',
      (await openDoor(ownerRow, photoName)).file === photoFile,
    );
    record(
      'another signed-in account cannot read it',
      (await openDoor(otherRow, photoName)).file === null,
    );
    const handedOut = [];
    for (const trick of ['../tickets/booking-999999.pdf', '..', photoName + '?x=1', '']) {
      handedOut.push((await openDoor(ownerRow, trick)).file);
    }
    record('…not even by slipping a path into the filename', handedOut.every((file) => file === null));

    const sheet = await ask('/styles.css');
    record('…while the site’s own CSS and pictures still serve', sheet.status === 200, `${sheet.status} ${sheet.type}`);
  } catch (error) {
    record('customer file suite ran', false, error.message);
  } finally {
    if (uploadServer) await new Promise((resolve) => uploadServer.close(resolve));
    for (const file of probeFiles) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* never written, or already gone */
      }
    }
    for (const id of probeUsers) {
      await db.run("DELETE FROM sessions WHERE (sess->>'userId')::bigint = ?", id);
      await db.run('DELETE FROM users WHERE id = ?', id);
    }
    const leftover = await db.all('SELECT sid FROM sessions');
    for (const row of leftover) {
      if (!servedSids.has(row.sid)) await db.run('DELETE FROM sessions WHERE sid = ?', row.sid);
    }
  }

  const after = await db.value('SELECT COUNT(*) FROM bookings');
  console.log(`\n  bookings left in the database after cleanup: ${after}`);
  await db.closeDatabase();

  const failed = results.filter((item) => !item.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length) {
    failed.forEach((item) => console.log(`  FAILED: ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));
    process.exitCode = 1;
  }
})();
