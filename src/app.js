'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { config, photoSlots } = require('./config');
const db = require('./db');
const { SqliteSessionStore } = require('./lib/session-store');
const { csrfMiddleware } = require('./lib/csrf');
const flash = require('./lib/flash');
const captcha = require('./lib/captcha');
const { mailStatus } = require('./lib/mailer');
const studio = require('./lib/settings');
const catalogue = require('./lib/catalogue');
const dates = require('./lib/dates');
const users = require('./lib/users');

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const bookingRoutes = require('./routes/booking');
const adminRoutes = require('./routes/admin');
const portalRoutes = require('./routes/portal');

const VIEWS = path.join(__dirname, '..', 'views');

function assetVersion() {
  try {
    return String(Math.floor(fs.statSync(path.join(config.root, 'public', 'styles.css')).mtimeMs));
  } catch {
    return String(Date.now());
  }
}

function buildLocals() {
  const opensAt = studio.earliestOpening();
  return {
    salon: {
      ...config.salon,
      opensAtLabel: opensAt === null ? '9:00 am' : dates.formatTime12(dates.minutesToHm(opensAt)),
    },
    site: {
      captcha: captcha.status(),
      mail: mailStatus(),
      photos: photoSlots(),
      isProduction: config.isProd,
    },
    stats: catalogue.catalogueStats(),
    assets: { version: assetVersion() },
  };
}

function limiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message,
    handler: (req, res) => {
      if (req.accepts(['html', 'json']) === 'json') {
        return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes.' });
      }
      flash.error(req, 'Too many attempts from this connection. Please wait a few minutes and try again.');
      const back = req.get('referer') && req.get('referer').startsWith(config.http.publicUrl)
        ? req.get('referer')
        : null;
      return back
        ? res.redirect(back)
        : res.status(429).render('errors/message', {
            title: 'Please slow down',
            message: 'Too many attempts from this connection. Please wait a few minutes and try again.',
            status: 429,
          });
    },
  });
}

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.disable('x-powered-by');
  if (config.http.trustProxy) app.set('trust proxy', 1);

  const cspDirectives = {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", ...(config.captcha.provider === 'turnstile' ? ['https://challenges.cloudflare.com'] : [])],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'font-src': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      ...(config.captcha.provider === 'turnstile' ? { 'frame-src': ['https://challenges.cloudflare.com'] } : {}),
    },
  };
  app.use(
    helmet({
      contentSecurityPolicy: cspDirectives,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: config.isProd ? undefined : false,
    }),
  );

  // The avatar field on /account/profile carries a browser-resized picture as
  // base64, which is far more than the 100kb every other form on the site needs.
  // Only this one endpoint asks for the larger body, and it still caps at a few
  // hundred kilobytes before src/lib/uploads.js looks at the bytes.
  app.use('/account/profile', express.urlencoded({ extended: false, limit: '800kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '20kb' }));

  app.use(
    '/assets',
    express.static(path.join(config.root, 'public', 'assets'), { maxAge: config.isProd ? '7d' : 0 }),
  );
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1d' : 0, index: false }));

  if (!config.session.secret && config.isProd) {
    throw new Error('SESSION_SECRET must be set in production. Copy .env.example to .env.');
  }

  app.use(
    session({
      name: config.session.name,
      secret: config.session.secret || 'naina-dev-only-secret-change-me',
      store: new SqliteSessionStore(),
      resave: false,
      saveUninitialized: true,
      rolling: true,
      proxy: config.http.trustProxy,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.session.cookieSecure,
        maxAge: config.session.maxAgeMs,
        path: '/',
      },
    }),
  );

  app.use((req, res, next) => {
    flash.consume(req, res);
    next();
  });

  // Page furniture first: any template rendered below this point — including the
  // CSRF and error pages — needs salon/site/assets/currentUser present.
  app.use((req, res, next) => {
    Object.assign(res.locals, buildLocals());
    res.locals.currentPath = req.path;
    res.locals.query = req.query;

    const uid = req.session && req.session.userId;
    res.locals.currentUser = uid ? users.findById(uid) : null;
    if (uid && !res.locals.currentUser) {
      // Account deleted or deactivated mid-session.
      req.session.destroy(() => {});
      res.locals.currentUser = null;
    }
    res.locals.isAdmin = Boolean(res.locals.currentUser && res.locals.currentUser.role === 'admin');
    res.locals.bookingRules = studio.bookingRules();
    res.locals.dates = dates;
    next();
  });

  app.use(csrfMiddleware());

  // CAPTCHA image for the built-in provider.
  app.get('/captcha.svg', (req, res) => {
    const svg = captcha.issue(req);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(svg);
  });

  app.get('/healthz', (req, res) => {
    const ok = (() => {
      try {
        return Number(db.get('SELECT 1 AS one').one) === 1;
      } catch {
        return false;
      }
    })();
    res.status(ok ? 200 : 503).json({
      ok,
      database: ok,
      captcha: config.captcha.provider,
      mail: mailStatus().mode,
      env: config.nodeEnv,
    });
  });

  const authLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 25, message: 'Too many attempts.' });
  app.use('/auth', authLimiter);

  app.use('/', publicRoutes);
  app.use('/auth', authRoutes);
  app.use('/account', accountRoutes);
  app.use('/book', bookingRoutes);
  app.use('/portal', portalRoutes);
  // Old staff URLs; see src/routes/admin.js.
  app.use('/admin', adminRoutes);

  app.use((req, res) => {
    res.status(404);
    res.render('errors/404', { title: 'Page not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = error.status || (error.code === 'SQLITE_CONSTRAINT' ? 409 : 500);
    if (status >= 500) {
      console.error('[error]', error.stack || error.message);
    }
    // body-parser says "request entity too large"; say what to do about it.
    const tooBig = status === 413 ? 'That photo is too large. Choose a smaller one, or save the other details.' : null;
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(status).json({
        ok: false,
        error:
          tooBig ||
          (status >= 500 ? 'Something went wrong at our end. Please try again.' : error.message),
      });
    }
    req.session = req.session || {};
    res.status(status);
    return res.render('errors/message', {
      title: status >= 500 ? 'Something went wrong' : 'Please check that',
      message:
        tooBig ||
        (status >= 500
          ? 'Something went wrong at our end. Please try again, or call the studio.'
          : error.message),
      status,
    });
  });

  return app;
}

module.exports = { createApp };
