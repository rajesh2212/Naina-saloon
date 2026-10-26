'use strict';
/**
 * The confirmed-booking ticket.
 *
 * A ticket exists only for a booking the studio has set to Confirmed, and it is
 * built from the live row every time — nothing about a customer or a time is
 * baked into this file. The PDF is written once to uploads/tickets and
 * kept there so the same document can be downloaded again later; if that file
 * ever goes missing (a fresh clone, a wiped disk) `ensure()` rebuilds it from
 * the booking in front of it, so a download cannot dead-end.
 *
 * The artwork is deliberately soft: the studio's hero portrait sits behind the
 * stub at one fifth opacity, the flower and cat cutouts are accents, and the
 * seal is drawn here as decoration next to an empty signature line. It is not a
 * government or brand-authenticity mark, and the ticket says so in the caption.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { config } = require('../config');
const db = require('../db');
const dates = require('./dates');
const uploads = require('./uploads');

const TICKET_DIR = path.join(config.uploads.dir, 'tickets');
const URL_PREFIX = '/uploads/tickets';
const ART_DIR = path.join(config.root, 'public', 'assets', 'art');

// Stamps keep the exact text shape src/lib/dates.js parses.
const NOW = "to_char(now(), 'YYYY-MM-DD HH24:MI:SS')";

const PAGE_W = 560;
const PAGE_H = 300;
const STUB_X = 410;

/**
 * A ticket only ever exists for a time the studio accepted. `completed` is kept
 * because that appointment was confirmed first, and the brief is to let people
 * download the same ticket again later — not to hand one out early.
 */
const TICKET_STATUSES = ['confirmed', 'completed'];

const INK = rgb(0.141, 0.102, 0.082); // #241a15
const MUTED = rgb(0.467, 0.384, 0.349); // #776259
const SOFT = rgb(0.373, 0.294, 0.255); // #5f4b41
const TEAL = rgb(0.604, 0.416, 0.235); // #b96a3c
const DEEP = rgb(0.604, 0.302, 0.129); // #9a4d21
const LINE = rgb(0.839, 0.757, 0.686); // #d6bda9
const PALE = rgb(0.925, 0.863, 0.816); // #ecdcd0
const PANEL = rgb(1, 0.992, 0.98); // #fffdfa
const BLUSH = rgb(0.984, 0.933, 0.902); // #fbeee6
const GREEN = rgb(0.165, 0.435, 0.278); // #2a6f47
const GREEN_SOFT = rgb(0.886, 0.941, 0.902); // #e2f0e6

/** Characters the built-in PDF fonts cannot encode, mapped to something they can. */
const WIN_ANSI = {
  '₹': 'Rs.', '—': '-', '–': '-', '·': '.', '×': 'x', '→': '->', '’': "'", '‘': "'",
  '“': '"', '”': '"', '…': '...', ' ': ' ', '​': '', '﻿': '',
};

function safe(value, max = 120) {
  let text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  for (const [from, to] of Object.entries(WIN_ANSI)) text = text.split(from).join(to);
  text = text.replace(/[^\x20-\xff]/g, '');
  if (text.length > max) text = `${text.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
  return text || '-';
}

/** Everything the ticket prints, read from the booking and its account right now. */
async function ticketRow(bookingId) {
  return db.get(
    `SELECT b.id, b.user_id, b.status, b.note, b.staff_note, b.contact_name, b.contact_phone, b.preferred_title,
            b.created_at, b.staff_action_at, b.ticket_path, b.ticket_issued_at,
            s.slot_date, s.start_time,
            sv.name AS service_name, sv.duration_minutes, sv.price_text,
            c.name AS category_name,
            u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
            u.photo_path, u.block, u.address, u.preferred_title AS user_title
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     JOIN services sv ON sv.id = b.service_id
     JOIN service_categories c ON c.id = sv.category_id
     JOIN users u ON u.id = b.user_id
     WHERE b.id = ?`,
    bookingId,
  );
}

/**
 * Resolve a stored `ticket_path` to a file on disk. Only a bare filename under
 * the tickets folder is allowed through, so a damaged or crafted row cannot
 * point the writer somewhere else in the filesystem.
 */
function absoluteFor(urlPath) {
  const value = String(urlPath ?? '');
  if (!value.startsWith(`${URL_PREFIX}/`)) return null;
  const name = value.slice(URL_PREFIX.length + 1);
  if (!name || name !== path.basename(name) || name.includes('..')) return null;
  return path.join(TICKET_DIR, name);
}

async function art(doc, name) {
  const file = path.join(ART_DIR, name);
  try {
    const bytes = fs.readFileSync(file);
    const image = name.endsWith('.png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    return { image, width: image.width, height: image.height };
  } catch {
    // A missing decoration must never cost a customer their ticket.
    return null;
  }
}

function contain(box, iw, ih) {
  const scale = Math.min(box.w / iw, box.h / ih);
  const width = iw * scale;
  const height = ih * scale;
  return { x: box.x + (box.w - width) / 2, y: box.y + (box.h - height) / 2, width, height };
}

function roundedRect(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${x + radius} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h - radius}`,
    `Q ${x + w} ${y + h} ${x + w - radius} ${y + h}`,
    `L ${x + radius} ${y + h}`,
    `Q ${x} ${y + h} ${x} ${y + h - radius}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    'Z',
  ].join(' ');
}

function spaced(text) {
  return text.split('').join(' ');
}

async function renderTicket(booking) {
  const salon = await require('./settings').salonDetails();
  const doc = await PDFDocument.create();
  doc.setTitle(`Naina Beauty Parlour — appointment #${booking.id}`);
  doc.setAuthor(salon.name);
  doc.setSubject('Confirmed appointment ticket');
  doc.setCreator('naina-beauty-parlour website');

  const [serif, regular, bold] = await Promise.all([
    doc.embedFont(StandardFonts.TimesRoman),
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ]);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  const portrait = await art(doc, 'ticket-portrait.png');
  const flower = await art(doc, 'ticket-flower.png');
  const cat = await art(doc, 'ticket-cat.png');
  const avatar = booking.photo_path ? await embedUpload(doc, booking.photo_path) : null;

  // ---- ground: a soft card with the stub panel inside it
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PANEL });
  page.drawSvgPath(roundedRect(10, 10, PAGE_W - 20, PAGE_H - 20, 22), {
    color: rgb(1, 0.992, 0.98),
    borderColor: LINE,
    borderWidth: 1,
  });
  page.drawSvgPath(roundedRect(STUB_X + 6, 16, PAGE_W - STUB_X - 22, PAGE_H - 32, 18), { color: BLUSH });

  // ---- the hero portrait, quietly, behind the stub only
  if (portrait) {
    const box = contain({ x: STUB_X + 14, y: 150, w: PAGE_W - STUB_X - 32, h: 130 }, portrait.width, portrait.height);
    page.drawImage(portrait.image, { ...box, opacity: 0.2 });
  }

  // ---- perforation
  page.drawLine({
    start: { x: STUB_X, y: 22 },
    end: { x: STUB_X, y: PAGE_H - 22 },
    thickness: 1,
    color: LINE,
    dashArray: [4, 5],
  });

  // ---- header
  const left = 30;
  page.drawText(safe(salon.name.toUpperCase(), 40), { x: left, y: 254, size: 19, font: serif, color: INK });
  page.drawText(safe(`${salon.tagline}  |  ${salon.address.split(',').slice(0, 3).join(',')}  |  since ${salon.since}`, 96), {
    x: left,
    y: 241,
    size: 7.2,
    font: regular,
    color: MUTED,
  });
  page.drawLine({ start: { x: left, y: 233 }, end: { x: 390, y: 233 }, thickness: 0.8, color: PALE });
  page.drawText(spaced('APPOINTMENT TICKET'), { x: left, y: 219, size: 7, font: bold, color: DEEP });

  // ---- the service
  page.drawText(safe(booking.service_name, 46), { x: left, y: 196, size: 16, font: bold, color: INK });
  page.drawText(
    safe(`${booking.category_name}  -  ${booking.duration_minutes} min chair time  -  ${booking.price_text || 'settled at the studio'}`, 88),
    { x: left, y: 184, size: 8, font: regular, color: SOFT },
  );

  // ---- details, two columns
  const rows = [
    ['Date', dates.formatLongDate(booking.slot_date), 'Time', dates.formatRange(booking.start_time, booking.duration_minutes)],
    ['Guest', booking.contact_name || booking.user_name, 'Called as', booking.preferred_title || booking.user_title || 'not given'],
    ['Phone', booking.contact_phone || booking.user_phone || salon.phone, 'Block', booking.block || 'not given'],
  ];
  let y = 158;
  for (const [labelA, valueA, labelB, valueB] of rows) {
    page.drawText(labelA.toUpperCase(), { x: left, y: y + 10, size: 6, font: bold, color: MUTED });
    page.drawText(safe(valueA, 44), { x: left, y, size: 9.5, font: regular, color: INK });
    page.drawText(labelB.toUpperCase(), { x: 216, y: y + 10, size: 6, font: bold, color: MUTED });
    page.drawText(safe(valueB, 24), { x: 216, y, size: 9.5, font: regular, color: INK });
    y -= 26;
  }

  const note = booking.note ? safe(booking.note, 110) : 'None';
  page.drawText('ANYTHING YOU TOLD THE STUDIO', { x: left, y: y + 10, size: 6, font: bold, color: MUTED });
  page.drawText(note, { x: left, y, size: 8.5, font: regular, color: SOFT, maxWidth: 350 });

  // ---- customer photo, when the account has one
  if (avatar) {
    const box = contain({ x: 322, y: 150, w: 68, h: 68 }, avatar.width, avatar.height);
    page.drawSvgPath(roundedRect(box.x - 3, box.y - 3, box.width + 6, box.height + 6, 10), {
      borderColor: LINE,
      borderWidth: 0.8,
    });
    page.drawImage(avatar.image, box);
  }

  // ---- decorations
  if (flower) {
    const box = contain({ x: 300, y: 18, w: 96, h: 120 }, flower.width, flower.height);
    page.drawImage(flower.image, { ...box, opacity: 0.92 });
  }
  if (cat) {
    const box = contain({ x: 208, y: 20, w: 74, h: 66 }, cat.width, cat.height);
    page.drawImage(cat.image, { ...box, opacity: 0.95 });
  }

  // ---- signature line and the decorative seal
  page.drawLine({ start: { x: 30, y: 44 }, end: { x: 190, y: 44 }, thickness: 0.8, color: LINE });
  page.drawText('Salon signature', { x: 30, y: 34, size: 6.5, font: regular, color: MUTED });
  page.drawText(safe(`Issued ${dates.formatStamp(booking.staff_action_at || booking.created_at)}`, 60), {
    x: 30,
    y: 22,
    size: 6.5,
    font: regular,
    color: MUTED,
  });

  const sealX = STUB_X + (PAGE_W - STUB_X) / 2;
  const sealY = 78;
  page.drawCircle({ x: sealX, y: sealY, size: 33, borderColor: TEAL, borderWidth: 1.6 });
  page.drawCircle({ x: sealX, y: sealY, size: 27, borderColor: LINE, borderWidth: 0.8 });
  page.drawText(safe(salon.name.split(' ')[0].toUpperCase(), 12), { x: sealX - 20, y: sealY + 8, size: 10, font: serif, color: DEEP });
  page.drawText('BEAUTY PARLOUR', { x: sealX - 26, y: sealY - 2, size: 5.4, font: bold, color: SOFT });
  page.drawText(safe(`BHADRAK  |  SINCE ${salon.since}`, 26), { x: sealX - 27, y: sealY - 12, size: 5.4, font: regular, color: MUTED });
  page.drawText('decorative seal - not an official stamp', { x: sealX - 46, y: 30, size: 5.2, font: regular, color: MUTED });

  // ---- status, the stub's headline
  page.drawSvgPath(roundedRect(STUB_X + 12, 202, PAGE_W - STUB_X - 26, 22, 11), { color: GREEN_SOFT, opacity: 0.55 });
  page.drawCircle({ x: STUB_X + 22, y: 214, size: 4.5, color: GREEN });
  page.drawText(spaced('CONFIRMED'), { x: STUB_X + 33, y: 210, size: 8.5, font: bold, color: GREEN });
  page.drawText(`#${booking.id}`, { x: STUB_X + 14, y: 184, size: 15, font: bold, color: INK });
  page.drawText('Reference', { x: STUB_X + 14, y: 173, size: 6, font: bold, color: MUTED });
  page.drawText(safe(dates.formatShortDate(booking.slot_date), 20), { x: STUB_X + 14, y: 158, size: 9, font: regular, color: SOFT });
  page.drawText(safe(dates.formatTime12(booking.start_time), 20), { x: STUB_X + 14, y: 146, size: 9, font: regular, color: SOFT });
  page.drawText(safe(`Call ${salon.phone}`, 24), { x: STUB_X + 14, y: 128, size: 7, font: regular, color: MUTED });

  // ---- the one line that keeps the ticket honest
  page.drawText('Held for you by the studio. Show it at the counter, or give the reference.', {
    x: left,
    y: 14,
    size: 6.4,
    font: regular,
    color: MUTED,
  });

  return Buffer.from(await doc.save());
}

/** A customer's own photo, which lives in the avatar upload folder. */
async function embedUpload(doc, photoPath) {
  if (!photoPath.startsWith(`${uploads.URL_PREFIX}/`)) return null;
  const name = photoPath.slice(uploads.URL_PREFIX.length + 1);
  if (!name || name !== path.basename(name)) return null;
  const file = path.join(uploads.AVATAR_DIR, name);
  try {
    const bytes = fs.readFileSync(file);
    const image = file.endsWith('.png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    return { image, width: image.width, height: image.height };
  } catch {
    return null;
  }
}

/**
 * Return the stored ticket for a booking the studio has accepted, making it
 * first when the file is not on disk. A request that is still pending, declined
 * or cancelled has no ticket and gets nothing here; the caller checks ownership.
 */
async function ensure(bookingId) {
  const booking = await ticketRow(bookingId);
  if (!booking) return { ok: false, reason: 'not-found' };
  if (!TICKET_STATUSES.includes(booking.status)) return { ok: false, reason: 'not-confirmed', booking };

  const file = absoluteFor(booking.ticket_path);
  const urlPath = file ? booking.ticket_path : `${URL_PREFIX}/booking-${booking.id}.pdf`;
  const target = absoluteFor(urlPath);
  if (!fs.existsSync(target)) {
    const bytes = await renderTicket(booking);
    fs.mkdirSync(TICKET_DIR, { recursive: true });
    fs.writeFileSync(target, bytes, { mode: 0o644 });
    await db.run(
      `UPDATE bookings SET ticket_path = ?, ticket_issued_at = COALESCE(ticket_issued_at, ${NOW}), updated_at = ${NOW} WHERE id = ?`,
      urlPath,
      booking.id,
    );
  }
  return { ok: true, booking: await ticketRow(bookingId), file: target, urlPath };
}

/** Called by the portal when staff confirm a request. */
async function issue(bookingId) {
  const result = await ensure(bookingId);
  if (!result.ok) throw new Error(result.reason === 'not-confirmed' ? 'That booking is not confirmed.' : 'Booking not found.');
  return result;
}

module.exports = {
  TICKET_DIR,
  TICKET_STATUSES,
  URL_PREFIX,
  renderTicket,
  ticketRow,
  ensure,
  issue,
  safe,
};
