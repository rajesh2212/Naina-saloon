# Naina Beauty Parlour — Salon Make-up Studio

Appointment booking website for **Naina Beauty Parlour / Naina Salon Make-up Studio**,
College Road, near Lucky Mess, Bagurai, Jagannathpur, Bhadrak, Odisha 756100 —
serving clients since 2018. Phone **094397 12994**.

Clients browse the service catalogue, create an account, and request a real
appointment slot from the studio's diary. Staff confirm or decline those
requests from a private admin area. Every time shown on the site comes from the
database; nothing about availability, sign-in or confirmation is simulated.

---

## Contents

- [Why this stack](#why-this-stack)
- [Quick start](#quick-start)
- [Environment configuration](#environment-configuration)
- [What happens when an integration is not configured](#what-happens-when-an-integration-is-not-configured)
- [npm scripts](#npm-scripts)
- [Project layout](#project-layout)
- [Database schema and migrations](#database-schema-and-migrations)
- [How availability and double-booking prevention work](#how-availability-and-double-booking-prevention-work)
- [Editing the catalogue, hours and booking rules](#editing-the-catalogue-hours-and-booking-rules)
- [Security notes](#security-notes)
- [Accessibility and mobile behaviour](#accessibility-and-mobile-behaviour)
- [Photography and the visual system](#photography-and-the-visual-system)
- [Deliberately not built](#deliberately-not-built)
- [Verification](#verification)

---

## Why this stack

The project directory was empty, so it needed a full-stack choice rather than a
framework to follow. It is a **server-rendered Express 4 + EJS 3 app on Node.js,
with SQLite as the only datastore**, and eight runtime dependencies:

| Dependency | Why it is here |
| --- | --- |
| `express`, `ejs` | Server-rendered pages. Booking correctness has to live on the server, so there is no reason to ship a second copy of the logic to the browser. |
| `node:sqlite` (built into Node ≥ 22.5) | A real relational database with transactions and unique indexes, with **no native compilation step**. On Windows, `better-sqlite3`/`sqlite3` need a C++ toolchain; the built-in `DatabaseSync` API does not. |
| `bcryptjs` | Password hashing (pure JS, installs anywhere). |
| `express-session` | Server-side sessions stored in SQLite. |
| `helmet` | Security headers, including a strict Content Security Policy. |
| `express-rate-limit` | Throttling on authentication endpoints. |
| `nodemailer`, `svg-captcha` | Password-reset mail, and the built-in image CAPTCHA. |

There is no build step, no bundler and no client-side framework: `public/main.js`
is plain ES5-compatible JavaScript that only *enhances* the booking page. With
JavaScript switched off every page still works, because slot lists, date changes
and the booking submission are ordinary server-rendered forms and links.

**Requirements:** Node.js **22.5 or newer** (checked with v22.14.0), npm 10.

---

## Quick start

```bash
# 1. Install dependencies (no compilation needed)
npm install

# 2. Create your own .env — never edit .env.example, and never commit .env
cp .env.example .env

# 3. Set at least the session secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#    → paste that value in as SESSION_SECRET= in .env

# 4. Create the database, weekly hours, settings and the service catalogue
npm run db:setup

# 5. Make the first staff login (asks on the terminal)
npm run create-admin

# 6. Run it
npm run dev        # auto-restarts on file changes, http://127.0.0.1:3000
# or
npm start
```

Then open <http://127.0.0.1:3000>, register a customer account from the site,
and sign in as the staff user at `/admin` to confirm the request.

To see the booking-integrity guarantees exercised against a throwaway copy of
your database:

```bash
npm run check
```

### Resetting to an empty database

Stop the server, then delete the SQLite files and rebuild:

```bash
rm -f data/naina.db data/naina.db-wal data/naina.db-shm
npm run db:setup && npm run create-admin
```

---

## Environment configuration

All values live in `.env`; `.env.example` documents every one with placeholders
only. **No credential, customer record or password is hard-coded anywhere in
this repository.**

### Required before going live

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs session cookies. The app refuses to boot with `NODE_ENV=production` and no secret. |
| `PUBLIC_APP_URL` | Absolute origin used to build password-reset links, so it must match what clients actually type. |
| `DATABASE_FILE` | Path to the SQLite file (default `./data/naina.db`). Keep it off any publicly served directory. |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` | Needed for the forgot-password flow to actually deliver a link. |
| `COOKIE_SECURE=1`, `TRUST_PROXY=1` | Set both once the site is behind HTTPS and a reverse proxy. |

### Optional

| Variable | Purpose |
| --- | --- |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Use Cloudflare Turnstile instead of the built-in image CAPTCHA. Both must be set to switch. |
| `CAPTCHA_MAX_ATTEMPTS` | Retries allowed against a built-in CAPTCHA challenge before it must be re-answered (default 3). |
| `SALON_NOTIFY_EMAIL` | Where the studio gets a copy of each booking request. |
| `MAIL_DEV_OUTBOX=file` | Development only: writes reset mails to `data/outbox/*.eml` so the flow can be tested with no mail server. Forced off when `SMTP_HOST` is set. |
| `BOOTSTRAP_ADMIN_EMAIL/NAME/PASSWORD` | Non-interactive first admin (`npm run create-admin -- --non-interactive`), handy for a deploy pipeline. Do not reuse a real password. |
| `SALON_*` | Name, tagline, phone, address, `SALON_SINCE`, `SALON_MAPS_URL` — the business details shown across the site. |

---

## What happens when an integration is not configured

The site never pretends an integration works. Each unconfigured service reports
itself in the UI and in `GET /healthz`:

- **No SMTP** — `/auth/forgot-password` shows *"Email delivery is not configured
  on this website"*, explains why, prints the exact missing variable
  (`SMTP_HOST is not configured in .env`), offers no form, and tells the client
  to call the counter. No token is created and no mail is queued.
- **No Turnstile** — the built-in `svg-captcha` challenge is served from
  `/captcha.svg` and verified on the server. Only its SHA-256 digest is kept in
  the session, and answers are case-insensitive.
- **No photographs** — each image slot renders a labelled "Photograph coming
  soon" placeholder naming the exact file to drop into `public/assets/`, rather
  than a stock image of another salon. See
  [Photography](#photography-and-the-visual-system).

`GET /healthz` answers `{ ok, database, captcha, mail, env }` for monitoring.

---

## npm scripts

| Script | Does |
| --- | --- |
| `npm start` | Runs `server.js` (migrations apply automatically on boot). |
| `npm run dev` | Same, with `--watch` auto-restart. |
| `npm run db:migrate` | Applies pending migrations from `src/db/migrations/`. |
| `npm run db:seed` | Idempotent seed: settings, 7 weekday rows, 8 service categories, 39 services. Existing rows are left alone. |
| `npm run db:setup` | Migrate, then seed. |
| `npm run create-admin` | Interactive: create the first staff account, or promote an existing email to `admin`. |
| `npm run slots:generate` | Materialises slot rows for the whole booking horizon (also happens lazily when a day is viewed). |
| `npm run check` | 14 assertions against a transaction that is always rolled back — see [Verification](#verification). |

---

## Project layout

```
server.js                 entry point: migrate, print banner, listen
src/
  config.js               .env loading + normalised config object
  app.js                  middleware order, CSP, rate limits, error pages
  db/
    index.js              node:sqlite handle, WAL, helpers (get/all/run/tx)
    migrate.js            ledger-backed migration runner (schema_migrations)
    migrations/001_init.sql
    seed.js               settings, hours, catalogue
  lib/
    users.js password.js captcha.js csrf.js session-store.js
    mailer.js validate.js dates.js settings.js slots.js catalogue.js
    guards.js flash.js auth-rate-limit.js async.js
  routes/
    public.js             home, services, categories, studio, location, how-to-book, /api/availability
    auth.js               register, login, logout, forgot-password, reset
    account.js            profile, password change, booking list + cancel
    booking.js            browse → pick day → pick slot → submit → done
    admin.js              dashboard, bookings, day sheet, services, hours, settings, customers
views/                    partials, auth/, pages/, admin/, errors/
public/                   styles.css, main.js, favicon.svg, assets/
scripts/                  migrate, seed, create-admin, generate-slots, check
data/                     SQLite database + dev outbox (gitignored)
```

---

## Database schema and migrations

Migrations are plain numbered SQL files applied once each, tracked in
`schema_migrations` (created by the runner). SQLite runs in WAL mode with
`foreign_keys = ON` and a 5 s `busy_timeout`.

| Table | Holds |
| --- | --- |
| `users` | name, unique email, bcrypt hash, role (`customer`/`admin`), phone, `preferred_title`, notes, active flag |
| `sessions` | express-session rows: `sid`, JSON `sess`, `expires_at` |
| `opening_hours` | one row per weekday: open/closed, `opens_at`, `closes_at`, staff note |
| `settings` | key/value booking rules |
| `service_categories` | the 8 groups, with `is_active` and sort order |
| `services` | name, slug, description, `duration_minutes`, `price_text`, `is_bookable`, `is_active` |
| `slots` | `slot_date`, `start_time`, `status` (`open`/`blocked`), `block_reason` |
| `bookings` | slot + user + service, `status` (`pending`/`confirmed`/`cancelled`/`completed`/`no-show`), contact name/phone, note, staff note |
| `password_resets` | **SHA-256 digest** of the token, user, expiry, used-at |

Passwords are bcrypt cost 12 over a SHA-256 pre-hash (so long passwords cannot
be silently truncated). Reset tokens are 32 random bytes, shown once in the mail
URL and stored only as a digest.

---

## How availability and double-booking prevention work

A slot is *bookable* when it is `open`, its start is at least
`lead_time_minutes` away in **Asia/Kolkata**, the weekday is open, the service's
`duration_minutes` fits before closing, and no `pending`/`confirmed` booking
already holds it.

Three independent layers stop two people taking the same time:

1. **Availability query** — booked slots are filtered out of every list, so they
   never appear in the UI or in `/api/availability`.
2. **`BEGIN IMMEDIATE` transaction** — `createBooking()` re-checks
   `activeBookingExists()` while holding the write lock, then inserts the slot
   claim and the booking row together, so a check-then-insert race cannot slip
   through.
3. **Partial unique index** — `bookings_one_active_per_slot_key ON
   bookings (slot_id) WHERE status IN ('pending','confirmed')`. Even a direct
   `INSERT` from a different process fails. Cancelled bookings do not hold the
   key, so a freed slot becomes bookable again.

Staff status changes go through the same guard, with the booking's own id
excluded so a request can move `pending → confirmed` without clashing with
itself.

Rules the studio can change at any time from `/admin/settings` (values outside
the hard limits are clamped, never crash):

| Setting | Default | Allowed |
| --- | --- | --- |
| Slot spacing | 30 min | 15–120 |
| Booking horizon | 30 days | 1–60 |
| Same-day notice | 120 min | 0–1440 |
| Open bookings per account | 3 | 1–20 |

Requests arrive as **pending** — the slot is held, but the client is told plainly
that the studio still has to accept it. Only staff can confirm.

---

## Editing the catalogue, hours and booking rules

Everything the business may want to change later is data, not code. All of it is
editable at `/admin` (staff login required):

- **`/admin/services`** — edit any service's name, description, chair time and
  **price text**, or mark it unbookable; add services and rename/hide groups.
  Prices ship as `NULL` and render as *"At the studio"* because none were
  supplied for this build — type the real figures in here.
- **`/admin/hours`** — per-weekday open/close, or mark a day closed. The seeded
  closing times are labelled *"Placeholder closing time — studio to confirm"*;
  only the 9:00 am opening was given, so confirm and replace them.
- **`/admin/settings`** — the four booking rules above.
- **`/admin/day/DATE`** — the day sheet: block a single time (with a reason) or
  reopen it. Blocked times disappear from availability immediately.
- **`/admin/bookings`** — filter by status/day/service, confirm, decline or
  complete a request, leave a staff note.
- **`/admin/customers/ID`** — one client's history, for the counter.

Customer-facing: `/account` lists **pending vs confirmed** separately, `/account/profile`
updates name/phone/title/notes, and a booking can be cancelled there (which frees
the slot).

---

## Security notes

- **Server-side only** for authentication, CAPTCHA, CSRF, validation, rate
  limiting, availability and booking creation. The browser is never trusted.
- **Passwords** — bcrypt (cost 12) over a SHA-256 pre-hash; never plaintext,
  never logged. Strength checks reject the account's own email/name and
  passwords under 10 characters.
- **Sessions** — server-side SQLite store, `httpOnly`, `SameSite=Lax`, rolling 7
  day expiry, session id **regenerated on login and on password change**
  (fixation guard), destroyed when the account disappears. Changing a password
  clears every other session *and* every outstanding reset link for that
  account, so an old phone cannot keep working with a superseded password.
  Nothing authentication-related is ever written to `localStorage`; the client
  stores no state at all.
- **CSRF** — double-submit token held in the session, compared in constant time,
  required on every state-changing POST (including logout). A rejected token
  renders its own explanation page rather than a generic error.
- **CAPTCHA** — verified server-side against the session digest (or Turnstile's
  `siteverify`, which **fails closed** if Cloudflare is unreachable). The
  arithmetic-question style is not used alone anywhere.
- **Rate limiting** — 25 attempts / 15 min / IP across `/auth`, plus a separate
  per-email throttle on login so one busy network does not lock the whole town
  out, and a bounded throttle on reset requests.
- **Input handling** — every field validated and length-capped on the server;
  EJS escapes by default; SQLite statements are always parameterised (no string
  interpolation into SQL); body size capped at 100 kB.
- **Headers** — CSP with `default-src 'self'`, no `'unsafe-inline'` for scripts
  **or styles** (the stylesheet therefore has utility classes instead of
  `style="…"` attributes), `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, HSTS in
  production.
- **Privacy** — a customer sees only their own bookings; ownership is re-checked
  on every read and mutation, so guessing an id returns 404. Staff routes sit
  behind both a login and an `admin` role check. Emails are never enumerated: a
  sign-in failure gives one generic message, and forgot-password behaves the same
  whether or not the address exists (when mail is configured).
- **Errors** — 5xx responses carry a generic sentence; the stack trace goes to
  the server log only.

---

## Accessibility and mobile behaviour

- Verified with no horizontal page overflow at 320, 390, 768, 1024 and 1280 px;
  the layout is mobile-first and only ever widens (`min-width` breakpoints at
  820, 900, 940 and 960 px, plus two `max-width` refinements at 560 and 620 px).
- Buttons, links, fields and time tiles are at least 44 px tall; the consent
  checkbox is a 26 px box inside a 44 px row whose label is clickable end to
  end. The date strip and the time grid are large tap targets, and wide tables
  scroll inside their own container instead of stretching the page.
- All form fields have real `<label>`s; slot choices are radio inputs inside a
  `<fieldset>`, so arrow keys move between times and the selected time is
  announced.
- Visible `:focus-visible` ring (3 px, offset) on links, buttons, inputs and
  slot tiles; a skip-to-content link is the first tab stop on every page.
- One `role="status"` live region on the booking page announces slot loading and
  failures; the decorative spinner is `aria-hidden` so it never competes.
- `prefers-reduced-motion: reduce` disables transitions, the spinner and hover
  movement; `scroll-behavior` reverts to auto.
- One `<h1>` per page, no skipped heading levels, landmarks (`header`/`main`/
  `footer`) present, all images have alt text, no positive `tabindex`, no
  duplicate ids.
- Colours meet WCAG AA contrast on the warm-neutral background; status is
  carried by words ("Pending", "Confirmed"), never colour alone.

---

## Photography and the visual system

The front end is an editorial layout — oversized serif headings on a warm
blush/cream ground, terracotta accents, rounded image panels, and a deep
charcoal footer carrying the `NAINA` wordmark. The home page scrolls
hero → about → your visit → services → pricing → questions → gallery →
inclusion → find us → footer, with booking as the primary action at every stop
(header, hero, each service card, the visit steps and the footer).

All of it is driven by CSS custom properties in `public/styles.css`; the token
names (`--teal`, `--red`, `--rose`) were kept when the palette was re-skinned so
the ~30 admin and auth templates follow along without edits.

**The CSP forbids `style="…"` attributes and `<style>` blocks** (`style-src
'self'`), so one-off rules live in utility classes instead. Nothing in `views/`
carries an inline style — that is a hard constraint, not a preference.

### Adding the studio's own photographs

Every image is a named slot with two filenames attached: the studio's own
photograph in `public/assets/`, and a generated stand-in in
`public/assets/art/`. Drop the real file in with the exact name and it takes
over on the next page load — nothing else changes.

Until then the slot shows the artwork, and the artwork is never passed off as
the studio's: each one carries a visible `Illustrative` chip in the corner and an
alt text that opens "Illustrative image —", and the gallery section says plainly
that none of the pictures are photographs of this salon. If even the artwork is
removed, the slot falls back to a labelled panel naming the file it waits for, so
no image area can render blank. Nothing is hotlinked either — `img-src 'self'
data:` makes external imagery structurally impossible.

The registry is `config.photoSlots` in `src/config.js` (18 slots across hero,
about, visit, service and gallery groups); `public/assets/README.md` has the
filenames and framing notes.

The boot banner and `npm run check` both report how many slots hold a real
photograph, so the team can see what shooting is still outstanding; the admin
"Studio diary" screen lists the exact filenames that are missing.

### One-row header below the desktop cursor

A sticky header that stacks the brand, the menu button and two buttons over
three rows consumed about a third of a phone viewport, so under 960px it
collapses to a single 60px row: the account links move into the menu panel, the
wordmark drops "Parlour" (and "Beauty" below 380px), and the booking button reads
just "Book". CSS shows exactly one of each pair at every width, so the
accessibility tree never doubles up — `views/partials/head.ejs` carries both and
`.header-cta__auth` / `.nav__auth` decide which is live.

---

## Deliberately not built

- **Payments.** No payment screen, no card/UPI collection, no gateway, no
  invoices, and nothing in the schema that pretends to hold a transaction. The
  business may later want a ₹19 booking payment; that is out of scope until it
  is discussed and approved separately, and the booking flow is written so a
  deposit step can be added without touching the slot-claim logic.
- **Invented business facts.** No prices, treatment claims, credentials, reviews
  or closing hours were made up. Durations are editable starting points, prices
  are blank, and seeded closing times say they are placeholders.
- **Testimonials.** The visual reference includes one, but no real customer
  review was supplied, so the home page has no quotes, star ratings or reviewer
  photos. Add the section once the studio gives verified reviews it is happy to
  publish — an empty state is worse than none, and a fabricated one is worse
  than both.
- **Newsletter signup.** No mailing-list service (Mailchimp, Brevo, a database
  subscriber table, anything) is configured, so the footer has no email-capture
  field. The SMTP settings in `.env` are for password-reset mail only and would
  not make a signup honest.
- **No SMS/WhatsApp reminders, no multi-barber staffing, no walk-in queue.**

---

## Verification

`npm run check` opens the database in a transaction it always rolls back (plus a
throwaway account it deletes) and asserts:

```
PASS  service catalogue seeded — 39 bookable services
PASS  weekday rows present — 7/7
PASS  availability comes from the database — 16 free slot(s) on 2026-10-25 for Bridal Makeup
PASS  first request is created as pending
PASS  taken slot disappears from availability
PASS  second request for the same slot is refused
PASS  unique index blocks a direct duplicate insert
PASS  staff can confirm a pending request
PASS  a confirmed slot still refuses a second booking
PASS  cancelling frees the booking
PASS  freed slot is bookable again
PASS  another account cannot act on someone's booking
PASS  reset tokens are stored as sha-256 digests
PASS  changing a password signs every other device out
PASS  …and drops the account's outstanding reset links
PASS  the new password is the one that verifies
17/17 checks passed.
```

Beyond the script, the whole flow was re-run against a **wiped database** using
only the documented commands (`npm run db:setup`, `npm run create-admin`,
`npm start`): a visitor registered, saw 16 real free times from the diary, sent
a request, saw it as *pending*, a staff login confirmed it, the customer then saw
*confirmed*, and a second request for that same slot was refused with 409 — 13
steps, all passing. Every route (including all 8 category pages, the guard
redirects, the 404, the 410 expired-reset page and the CSRF rejection page)
renders without a server error, and the browser console is clean on every page.

The database shipped in `data/` (gitignored) contains the seeded catalogue and
**no accounts at all** — no demo customer, no demo staff login. Create your own
with `npm run create-admin`.

Mobile and accessibility were measured in a real 390 px viewport: no page pans
horizontally, no control falls below the 44 px height guideline (the consent
checkbox excepted — see above), every field has a label, all text colour pairs
clear WCAG AA 4.5:1, keyboard focus draws a visible ring on links, buttons,
inputs and slot tiles, and the time grid is a labelled `fieldset` navigable with
arrow keys.
