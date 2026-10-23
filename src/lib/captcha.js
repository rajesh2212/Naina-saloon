'use strict';
/**
 * CAPTCHA, always verified on the server.
 *
 * Provider "turnstile"  — Cloudflare Turnstile, used when both keys are set.
 * Provider "local-image" — an svg-captcha image served by this app and checked
 *                          server-side, used when Turnstile is not configured.
 * There is no browser-side arithmetic shortcut in either path.
 */
const crypto = require('node:crypto');
const svgCaptcha = require('svg-captcha');
const { config } = require('../config');

const SESSION_KEY = '_captcha';
const TTL_MS = 5 * 60 * 1000;

function provider() {
  return config.captcha.provider;
}

function status() {
  return {
    provider: provider(),
    label: provider() === 'turnstile' ? 'Cloudflare Turnstile' : 'Built-in image CAPTCHA',
    turnstileConfigured: provider() === 'turnstile',
    note:
      provider() === 'turnstile'
        ? 'Turnstile is configured and the token is verified by the server.'
        : 'Turnstile keys are not set, so the app falls back to its own image CAPTCHA. Answers are stored only as a hash in the server-side session and checked on the server.',
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value).toLowerCase()).digest('hex');
}

/** Generate a fresh local image CAPTCHA and keep only its digest. */
function issue(req) {
  const captcha = svgCaptcha.create({
    size: 5,
    noise: 2,
    color: true,
    background: '#f6efe8',
    width: 190,
    height: 64,
    ignoreChars: '0oO1ilI',
  });
  req.session[SESSION_KEY] = { digest: digest(captcha.text), createdAt: Date.now(), attempts: 0 };
  return captcha.data;
}

function clear(req) {
  if (req.session) delete req.session[SESSION_KEY];
}

async function verifyTurnstile(req) {
  const response = String((req.body && (req.body['cf-turnstile-response'] || req.body.turnstile_token)) || '');
  if (!response) return { ok: false, message: 'Please complete the CAPTCHA check.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const upstream = await fetch(config.captcha.verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({
        secret: config.captcha.secretKey,
        response,
        remoteip: req.ip || '',
      }),
      signal: controller.signal,
    });
    const result = await upstream.json();
    if (result.success) return { ok: true };
    return { ok: false, message: 'The CAPTCHA check failed. Please try again.' };
  } catch {
    // Fail closed: an unreachable verifier must not let a login through.
    return { ok: false, message: 'The CAPTCHA service could not be reached. Please try again in a moment.' };
  } finally {
    clearTimeout(timer);
  }
}

function verifyLocal(req) {
  const stored = req.session && req.session[SESSION_KEY];
  const answer = String((req.body && req.body.captcha_answer) || '').trim();
  clear(req);
  if (!stored) return { ok: false, message: 'The verification image expired. Please reload it and try again.' };
  if (Date.now() - stored.createdAt > TTL_MS) {
    return { ok: false, message: 'The verification image timed out. Please load a new one.' };
  }
  if (!answer) return { ok: false, message: 'Type the characters you see in the image.' };
  const a = Buffer.from(digest(answer));
  const b = Buffer.from(stored.digest);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return { ok: false, message: 'That answer does not match the image. Try a new one.' };
  return { ok: true };
}

/** Entry point used by every protected form. */
async function verify(req) {
  if (provider() === 'turnstile') return verifyTurnstile(req);
  return verifyLocal(req);
}

module.exports = { provider, status, issue, clear, verify, verifyLocal, verifyTurnstile, SESSION_KEY, TTL_MS };
