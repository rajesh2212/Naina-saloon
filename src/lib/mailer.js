'use strict';
/**
 * Outbound email. Nodemailer is only wired up when SMTP_HOST is present —
 * otherwise send() reports "unconfigured" and callers must not claim that a
 * message was delivered.
 */
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { config } = require('../config');

let transporter = null;
let transporterError = null;

function mailStatus() {
  if (config.mail.enabled && !transporterError) {
    return { enabled: true, mode: 'smtp', host: config.mail.host, from: config.mail.from };
  }
  if (canUseDevOutbox()) return { enabled: true, mode: 'outbox', host: null, from: config.mail.from };
  return {
    enabled: false,
    mode: 'none',
    host: null,
    from: config.mail.from,
    reason: transporterError || 'SMTP_HOST is not configured in .env',
  };
}

function canUseDevOutbox() {
  return (
    !config.isProd &&
    !config.mail.enabled &&
    String(config.mail.devOutbox).toLowerCase() === 'file'
  );
}

function getTransporter() {
  if (!config.mail.enabled) return null;
  if (transporterError) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageShell(heading, bodyHtml) {
  return `<!doctype html><html lang="en"><body style="margin:0;background:#faf6f1;color:#241a16;font-family:Georgia,'Times New Roman',serif">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <p style="letter-spacing:.14em;text-transform:uppercase;font-size:11px;color:#8a6d5f;margin:0 0 6px">${escapeHtml(config.salon.name)}</p>
    <h1 style="font-size:24px;margin:0 0 16px;font-weight:500">${escapeHtml(heading)}</h1>
    <div style="font-size:16px;line-height:1.6">${bodyHtml}</div>
    <p style="font-size:13px;color:#7a6055;margin-top:28px">${escapeHtml(config.salon.name)} — ${escapeHtml(config.salon.address)} · ${escapeHtml(config.salon.phone)}</p>
  </div></body></html>`;
}

async function send({ to, subject, heading, bodyHtml, text }) {
  const status = mailStatus();
  if (!status.enabled) {
    return { ok: false, status, error: status.reason };
  }

  const html = pageShell(heading || subject, bodyHtml || `<p>${escapeHtml(text || '')}</p>`);
  const plain = text || `${heading || subject}\n\n${String(bodyHtml || '').replace(/<[^>]+>/g, ' ')}`;

  if (status.mode === 'outbox') {
    const dir = path.join(config.db.dir, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${String(subject).replace(/[^\w-]+/g, '_')}.eml`);
    fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\nContent-Type: text/html; charset=utf-8\n\n${html}`, 'utf8');
    return { ok: true, status, messageId: `outbox:${path.basename(file)}`, file };
  }

  const mailer = getTransporter();
  if (!mailer) return { ok: false, status, error: 'Mail transport unavailable' };
  try {
    const info = await mailer.sendMail({ from: config.mail.from, to, subject, text: plain, html });
    if (config.salon.notifyEmail && config.salon.notifyEmail !== to) {
      // Best-effort copy for the studio; never fail the user's flow on this.
      mailer
        .sendMail({ from: config.mail.from, to: config.salon.notifyEmail, subject: `[copy] ${subject}`, text: plain })
        .catch(() => {});
    }
    return { ok: true, status, messageId: info.messageId };
  } catch (error) {
    return { ok: false, status, error: error.message };
  }
}

function passwordResetMail({ name, link, minutes = 60 }) {
  const subject = 'Reset your password';
  return {
    subject,
    heading: 'Reset your password',
    text:
      `Hello ${name},\n\nUse this link to choose a new password. It works once and expires in ${minutes} minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore the email.\n\n${config.salon.name}, ${config.salon.phone}`,
    bodyHtml: `<p>Hello ${escapeHtml(name)},</p>
      <p>We received a request to reset the password for your ${escapeHtml(config.salon.name)} account.</p>
      <p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#b03a45;color:#fff;padding:12px 18px;text-decoration:none;border-radius:6px">Choose a new password</a></p>
      <p>Or copy this link into your browser:<br><span style="font-family:monospace;font-size:13px;word-break:break-all">${escapeHtml(link)}</span></p>
      <p>The link works once and expires in ${escapeHtml(String(minutes))} minutes. If you did not ask for a reset, ignore this email — your password stays unchanged.</p>`,
  };
}

function bookingReceivedMail({ name, service, when, status }) {
  return {
    subject: `Booking request received — ${service}`,
    heading: 'Your booking request is in',
    text: `Hello ${name},\n\nWe received your request for ${service} on ${when}. Status: ${status}.\n\nThe studio will confirm the time. If anything changes, call ${config.salon.phone}.`,
    bodyHtml: `<p>Hello ${escapeHtml(name)},</p>
      <p>We received your booking request:</p>
      <ul><li><strong>${escapeHtml(service)}</strong></li><li>${escapeHtml(when)}</li><li>Status: <strong>${escapeHtml(status)}</strong></li></ul>
      <p>Our staff confirm each request. You can follow the status from your account page, or call the studio on ${escapeHtml(config.salon.phone)}.</p>`,
  };
}

module.exports = { send, mailStatus, passwordResetMail, bookingReceivedMail, escapeHtml };
