'use strict';
/**
 * Reads and normalises environment configuration, and exposes the feature
 * flags that tell the app which integrations are actually available.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return false;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
    return true;
  }
  // Fallback parser for Node builds without process.loadEnvFile().
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const envFileLoaded = loadEnvFile();

const env = process.env;
const bool = (value, def = false) => {
  if (value === undefined || value === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const int = (value, def) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : def;
};
const str = (value, def = '') => (value === undefined || value === '' ? def : String(value));

const nodeEnv = str(env.NODE_ENV, 'development');
const isProd = nodeEnv === 'production';
const dbFile = path.resolve(ROOT, str(env.DATABASE_FILE, './data/naina.db'));
const publicUrl = str(env.PUBLIC_APP_URL, `http://${str(env.HOST, '127.0.0.1')}:${str(env.PORT, '3000')}`);

const smtpHost = str(env.SMTP_HOST);
const turnstileSite = str(env.TURNSTILE_SITE_KEY);
const turnstileSecret = str(env.TURNSTILE_SECRET_KEY);

const config = {
  root: ROOT,
  nodeEnv,
  isProd,
  envFileLoaded,

  http: {
    port: int(env.PORT, 3000),
    host: str(env.HOST, '127.0.0.1'),
    publicUrl: publicUrl.replace(/\/+$/, ''),
    trustProxy: bool(env.TRUST_PROXY, false),
  },

  db: { file: dbFile, dir: path.dirname(dbFile) },

  session: {
    secret: str(env.SESSION_SECRET),
    cookieSecure: bool(env.COOKIE_SECURE, isProd),
    maxAgeMs: 1000 * 60 * 60 * 24 * 7,
    name: 'naina.sid',
  },

  salon: {
    name: str(env.SALON_NAME, 'Naina Beauty Parlour'),
    tagline: str(env.SALON_TAGLINE, 'Salon Make-up Studio'),
    phone: str(env.SALON_PHONE, '094397 12994'),
    phoneHref: '+919439712994',
    address: str(env.SALON_ADDRESS, 'College Road, near Lucky Mess, Bagurai, Jagannathpur, Bhadrak, Odisha 756100, India'),
    since: str(env.SALON_SINCE, '2018'),
    mapsUrl: str(
      env.SALON_MAPS_URL,
      'https://www.google.com/maps/place/Naina+Beauty+Parlour/@21.0637569,86.4933537,20.97z/data=!4m6!3m5!1s0x3a1bf7f91d33f1ff:0x9874be5037c89943!8m2!3d21.0637734!4d86.4936311!16s%2Fg%2F11fk4qz5qb',
    ),
    notifyEmail: str(env.SALON_NOTIFY_EMAIL),
  },

  // Every image the front end wants, by slot. `file` is the studio's own
  // photograph, dropped into public/assets/; `art` is the generated illustrative
  // stand-in in public/assets/art/ that shows until then. A slot with neither
  // falls back to a labelled placeholder panel, so nothing is ever blank.
  photoSlots: {
    hero: [{ file: 'naina-hero-portrait.png', art: 'hero-portrait.jpg' }],
    about: [
      { file: 'naina-about-1.png', art: 'about-1-chair.jpg' },
      { file: 'naina-about-2.png', art: 'about-2-counter.jpg' },
      { file: 'naina-about-3.png', art: 'about-3-brow.jpg' },
    ],
    visit: [
      { file: 'naina-visit-1.png', art: 'visit-1-service.jpg' },
      { file: 'naina-visit-2.png', art: 'visit-2-date.jpg' },
      { file: 'naina-visit-3.png', art: 'visit-3-details.jpg' },
      { file: 'naina-visit-4.png', art: 'visit-4-confirmed.jpg' },
    ],
    services: [
      { file: 'naina-service-bridal.png', art: 'service-bridal.jpg' },
      { file: 'naina-service-hair.png', art: 'service-hair.jpg' },
      { file: 'naina-service-facial.png', art: 'service-facial.jpg' },
      { file: 'naina-service-eye.png', art: 'service-eye.jpg' },
      { file: 'naina-service-treatment.png', art: 'service-treatment.jpg' },
    ],
    gallery: [
      { file: 'naina-gallery-1.png', art: 'gallery-1-counter.jpg' },
      { file: 'naina-gallery-2.png', art: 'gallery-2-storefront.jpg' },
      { file: 'naina-gallery-3.png', art: 'gallery-3-bridal.jpg' },
      { file: 'naina-gallery-4.png', art: 'gallery-4-hair.jpg' },
      { file: 'naina-gallery-5.png', art: 'gallery-5-skin.jpg' },
    ],
  },

  mail: {
    enabled: Boolean(smtpHost),
    host: smtpHost,
    port: int(env.SMTP_PORT, 587),
    secure: bool(env.SMTP_SECURE, false),
    user: str(env.SMTP_USER),
    pass: str(env.SMTP_PASS),
    from: str(env.MAIL_FROM, 'Naina Beauty Parlour <no-reply@localhost>'),
    devOutbox: !smtpHost ? str(env.MAIL_DEV_OUTBOX, 'off') : 'off',
  },

  captcha: {
    // 'turnstile' only when both keys exist; otherwise the built-in server-side
    // image CAPTCHA is used. Either way verification happens on the server.
    provider: turnstileSite && turnstileSecret ? 'turnstile' : 'local-image',
    siteKey: turnstileSite,
    secretKey: turnstileSecret,
    maxAttempts: int(env.CAPTCHA_MAX_ATTEMPTS, 3),
    verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },

  limits: {
    passwordMinLength: 10,
    nameMaxLength: 80,
    noteMaxLength: 500,
    bookingHorizonDays: 60,
  },
};

function describeConfig() {
  return {
    env: config.nodeEnv,
    envFileLoaded: config.envFileLoaded,
    database: config.db.file,
    publicUrl: config.http.publicUrl,
    sessionSecretSet: Boolean(config.session.secret),
    captchaProvider: config.captcha.provider,
    mailEnabled: config.mail.enabled,
    mailDevOutbox: config.mail.devOutbox,
    photos: (() => {
      const slots = photoSlots();
      const all = Object.values(slots).flat();
      return {
        present: all.filter((p) => p.present).length,
        illustrative: all.filter((p) => !p.present && p.artSrc).length,
        empty: all.filter((p) => !p.present && !p.artSrc).length,
        total: all.length,
      };
    })(),
  };
}

/** Resolves every configured image slot against public/assets/ and its art/ folder. */
function photoSlots() {
  const dir = path.join(ROOT, 'public', 'assets');
  const groups = {};
  for (const [group, slots] of Object.entries(config.photoSlots)) {
    groups[group] = slots.map(({ file, art }) => {
      const present = fs.existsSync(path.join(dir, file));
      const artPresent = Boolean(art) && fs.existsSync(path.join(dir, 'art', art));
      return {
        file,
        src: `/assets/${file}`,
        present,
        art: art || null,
        artSrc: artPresent ? `/assets/art/${art}` : null,
      };
    });
  }
  return groups;
}

module.exports = { config, describeConfig, photoSlots };
