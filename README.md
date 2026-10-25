# Naina Beauty Parlour — Salon Make-up Studio

Appointment booking website for **Naina Beauty Parlour / Naina Salon Make-up Studio**,
College Road, near Lucky Mess, Bagurai, Jagannathpur, Bhadrak, Odisha 756100 —
serving clients since 2018. Phone **094397 12994**.

Clients browse the service catalogue, create an account, and request a real
appointment slot from the studio's diary. Staff confirm or decline those
requests from a private portal at `/portal`. Every time shown on the site comes
from the database; nothing about availability, sign-in or confirmation is
simulated.

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
- [Customer profile completion and the booking gate](#customer-profile-completion-and-the-booking-gate)
- [The account pop-up and the shared sheet](#the-account-pop-up-and-the-shared-sheet)
- [Booking tickets (PDF)](#booking-tickets-pdf)
- [Staff portal (`/portal`)](#staff-portal-portal)
- [Editing the catalogue, hours and booking rules](#editing-the-catalogue-hours-and-booking-rules)
- [Where the customer's files live](#where-the-customers-files-live)
- [Running it on a server](#running-it-on-a-server)
- [Security notes](#security-notes)
- [Accessibility and mobile behaviour](#accessibility-and-mobile-behaviour)
- [Photography and the visual system](#photography-and-the-visual-system)
- [Deliberately not built](#deliberately-not-built)
- [Verification](#verification)

---

## Why this stack

The project directory was empty, so it needed a full-stack choice rather than a
framework to follow. It is a **server-rendered Express 4 + EJS 3 app on Node.js,
with SQLite as the only datastore**, and nine runtime dependencies:

| Dependency | Why it is here |
| --- | --- |
| `express`, `ejs` | Server-rendered pages. Booking correctness has to live on the server, so there is no reason to ship a second copy of the logic to the browser. |
| `node:sqlite` (built into Node ≥ 22.5) | A real relational database with transactions and unique indexes, with **no native compilation step**. On Windows, `better-sqlite3`/`sqlite3` need a C++ toolchain; the built-in `DatabaseSync` API does not. |
| `bcryptjs` | Password hashing (pure JS, installs anywhere). |
| `express-session` | Server-side sessions stored in SQLite. |
| `helmet` | Security headers, including a strict Content Security Policy. |
| `express-rate-limit` | Throttling on authentication endpoints. |
| `nodemailer`, `svg-captcha` | Password-reset mail, and the built-in image CAPTCHA. |
| `pdf-lib` | The confirmed-booking ticket PDF. Pure JS (no native build, no headless browser), and it writes the file to disk rather than rendering it through a browser the client could tamper with. |

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
and sign in as the staff user at `/portal` to confirm the request.

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
| `UPLOADS_DIR` | Where booking PDFs and avatars are written (default `./uploads`). Only a host with separate persistent storage needs it; never point it inside `public/` — see [Where the customer's files live](#where-the-customers-files-live). |
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
| `SALON_*` | Name, tagline, phone, address, `SALON_SINCE`, `SALON_MAPS_URL`, `SALON_NOTIFY_EMAIL` — the business details shown across the site. |
| `SALON_TIMEZONE` | The IANA zone the diary is written on (default `Asia/Kolkata`). A zone saved at `/portal/settings` wins over this, because the studio should not need a terminal to change its clock. |

Every `SALON_*` value above is a **starting point**: the same details are
editable at `/portal/details`, and a value saved there wins over the environment
until the box is emptied again. `SESSION_SECRET`, the SMTP credentials,
`TURNSTILE_SECRET_KEY`, `PUBLIC_APP_URL` and `DATABASE_FILE` are **not** on that
page and stay in the environment — see
[What the portal holds vs what stays in `.env`](#what-the-portal-holds-vs-what-stays-in-env).

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
| `npm run art:ticket` | Rebuilds the small derived copies of the studio's cut-outs that the ticket PDF and the page sprigs use — see [Photography](#photography-and-the-visual-system). |
| `npm run check` | 117 assertions — booking integrity, the portal guard and the profile/booking gate inside a transaction that is always rolled back, then staff-account, site-detail, ticket, pop-up and customer-file checks on throwaway rows, PDFs and one live HTTP server, all deleted afterwards — see [Verification](#verification). |

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
    migrations/002_staff_portal.sql
    migrations/003_profile_completion.sql
    migrations/004_booking_ticket.sql
    seed.js               settings, hours, catalogue
  lib/
    users.js password.js captcha.js csrf.js session-store.js
    mailer.js validate.js dates.js settings.js slots.js catalogue.js
    profile.js              the seven Blocks, and the maths behind the completion bar
    uploads.js              customer avatars: decode, signature-check, size-cap, name
    ticket.js               the confirmed-booking PDF: what may be issued, where it lives, how it is drawn
    records.js              staff queries: dashboard snapshot, booking search, roster, day rows
    guards.js flash.js auth-rate-limit.js async.js
  routes/
    public.js             home, services, categories, studio, location, how-to-book, /api/availability
    auth.js               register, login, logout, forgot-password, reset
    account.js            profile, password change, booking list + cancel, ticket download
    booking.js            browse → pick day → pick slot → submit → done
    portal.js             /portal: dashboard, bookings, customers, day sheet, services, settings, details, staff
    admin.js              /admin → 302 to the matching /portal page
views/                    partials, auth/, pages/, portal/, errors/
public/                   styles.css, portal.css, main.js, portal.js, favicon.svg, assets/
uploads/avatars/          customer photos, created on first upload (gitignored)
uploads/tickets/          one PDF per confirmed booking, created on confirmation (gitignored)
scripts/                  migrate, seed, create-admin, generate-slots, ticket-art, check
data/                     SQLite database + dev outbox (gitignored)
Dockerfile                node:24, npm ci --omit=dev, runs as the node user
.dockerignore             keeps data/, uploads/ and .env out of the image
fly.toml                  Fly.io: one machine, /data volume, production env, /healthz
```

---

## Database schema and migrations

Migrations are plain numbered SQL files applied once each, tracked in
`schema_migrations` (created by the runner). SQLite runs in WAL mode with
`foreign_keys = ON` and a 5 s `busy_timeout`.

| Table | Holds |
| --- | --- |
| `users` | name, unique email, bcrypt hash, role (`customer`/`admin`), phone, `preferred_title`, notes, active flag — plus the four booking details from migration `003`: `age`, `address`, `block`, `photo_path` |
| `sessions` | express-session rows: `sid`, JSON `sess`, `expires_at` |
| `opening_hours` | one row per weekday: open/closed, `opens_at`, `closes_at`, staff note |
| `settings` | key/value booking rules |
| `service_categories` | the 8 groups, with `is_active` and sort order |
| `services` | name, slug, description, `duration_minutes`, `price_text`, `is_bookable`, `is_active` |
| `slots` | `slot_date`, `start_time`, `status` (`open`/`blocked`), `block_reason` |
| `bookings` | slot + user + service, `status` (`pending`/`confirmed`/`cancelled`/`completed`/`no-show`), contact name/phone, note, staff note — plus the ticket columns from migration `004`: `ticket_path`, `ticket_issued_at`, both NULL until staff confirm |
| `password_resets` | **SHA-256 digest** of the token, user, expiry, used-at |

Passwords are bcrypt cost 12 over a SHA-256 pre-hash (so long passwords cannot
be silently truncated). Reset tokens are 32 random bytes, shown once in the mail
URL and stored only as a digest.

---

## How availability and double-booking prevention work

A slot is *bookable* when it is `open`, its start is at least
`lead_time_minutes` away on **the salon's own clock** (see
[the staff portal](#staff-portal-portal) — `Asia/Kolkata` until a staff member
chooses otherwise), the weekday is open, the service's
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

Rules the studio can change at any time from `/portal/settings` (values outside
the hard limits are refused with a message, never stored):

| Setting | Default | Allowed |
| --- | --- | --- |
| Slot spacing | 30 min | 15–120 |
| Booking horizon | 30 days | 1–60 |
| Same-day notice | 120 min | 0–1440 |
| Open bookings per account | 3 | 1–20 |

Requests arrive as **pending** — the slot is held, but the client is told plainly
that the studio still has to accept it. Only staff can confirm.

---

## Customer profile completion and the booking gate

Signing in is not enough to request a chair time. The studio needs to know who is
coming, how to reach them, and which Block they travel from, so
`/account/profile` collects five details and a server-side gate holds booking back
until all five are there.

| Step | Worth | Satisfied by |
| --- | --- | --- |
| Name | 20% | `name` |
| Phone number | 40% | `phone` — at least 6 digits |
| Age | 60% | `age` — whole number, 1–120 |
| Profile photo | 80% | `photo_path` |
| Address **and** Block | 100% | `address` + `block` (one step — an address with no Block chosen is still incomplete) |

`src/lib/profile.js` owns that maths, the seven-value Block allowlist and the
field validators, so the bar, the flash message and the gate can never disagree
with each other. The list is the Blocks of Bhadrak district, spelled as the
dropdown shows them: Bhadrak, Basudevpur, Bhandaripokhari, Bonth, Chandabali,
Dhamnagar, Tihidi. Migration `003` puts the same list in a `CHECK` constraint, so
a value typed past the form is refused by SQLite as well as by the route.

**Where the rule lives.** `src/routes/booking.js` opens with
`router.use(requireUser, requireProfile)`, which runs before every booking page,
the slot JSON at `/book/slots`, and the booking `POST` itself. `requireProfile`
re-reads the account from the database on each request, so completeness is decided
server-side; removing a detail closes the gate again immediately. Browser-side it
is only ever a courtesy. HTML requests get a flash naming what is missing and a
redirect to `/account/profile`; JSON requests get `403` with
`profileIncomplete: true` rather than a redirect a script would silently follow.
Staff logins are exempt — the counter books on behalf of walk-ins.

**Keeping the intent.** `requireUser` stores the requested URL in
`session.returnTo`, and the auth pages carry it as `?next=` across the
sign-in / register / forgot-password tabs. After a complete profile is saved the
customer lands back on the booking page they first wanted; an incomplete one keeps
them on `/account/profile` and remembers the destination for next time. A fresh
registration goes to the profile page first, since it starts at 40%.

**Partial saves are allowed.** `POST /account/profile` only validates the *shape*
of what is sent, so a customer can add one detail at a time and see the bar move.
`users.updateProfile()` keeps any stored value whose key is absent from the form,
which is why the same route can write a photo and a name in one go without
blanking the rest.

**Photos.** There is no multipart parser in the dependencies, so
`public/main.js` draws the pick into a 256 px square canvas and posts a base64
data URL. Nothing about that is trusted: `src/lib/uploads.js` re-decodes it, checks
the first bytes against the JPEG/PNG/WebP signatures (an SVG renamed to `.png`
fails), caps it at 400 KB, and writes it under a generated name —
`uploads/avatars/<user id>-<12 hex>.<ext>`. The row stores only the URL
path. Replacing or removing a photo deletes the old file, but only through
`safeRelativePath()`, which accepts a single bare filename under `/uploads/avatars/`
and refuses everything else, so no path from a form can delete an asset the studio
supplied. `/uploads/` is gitignored: these are real faces tied to real
accounts, and it sits **outside** `/public/` on purpose — see
[Where the customer's files live](#where-the-customers-files-live).

**The tick.** At 100% the bar disappears and a small blue circular tick sits by the
photo. It means *the studio has everything it needs to hold a time* — the page says
so in as many words, and it is not presented as an identity or government check.

---

## The account pop-up and the shared sheet

The header's account control is still an ordinary link to `/account`. With
JavaScript on, `public/main.js` intercepts the click, opens the
`<dialog id="account-panel">` that every signed-in page carries, and fills it from
`GET /account/panel`. That route sits behind the same `requireUser` as `/account`
and answers with the fragment in `views/partials/account-panel.ejs`, marked
`X-Naina-Panel: 1` and `Cache-Control: no-store`. Nothing about the page behind
changes and the address bar stays where it was; if the session has expired, the
fragment comes back as a redirect and the script follows it to the sign-in page
instead of pasting a whole layout into the sheet.

**The two lists.** `panelGroups()` in `src/routes/account.js` builds them from
`slots.listUserBookings()`, the same rows `/account` reads:

| Tab | Holds | Statuses a row can show |
| --- | --- | --- |
| Current bookings | everything the diary still carries | pending, confirmed, rejected, cancelled |
| Booking history | the whole record | pending, confirmed, completed, rejected, cancelled |

Only a completed booking leaves Current, so the tabs overlap on purpose and the
copy under each heading says which question it answers. Statuses are printed from
the row (`booking.status`), never inferred; a confirmed booking with a ticket
offers the same `/account/ticket/:id` link the account page does. Each list has
its own empty state, and the panel never renders another customer's rows — the
owner comes from the session, not the request.

**Editing without leaving.** *Edit profile* and *Edit photo* swap the panel to the
same shared editor (`views/partials/profile-fields.ejs`) the profile page uses,
with its ids prefixed `ap-` so two copies can never collide, and post to the same
`POST /account/profile`. The panel's fetch adds `X-Naina-Panel: 1`; the route then
answers with the rebuilt fragment — `200` with the saved values, or `400` with the
same inline errors and nothing written — instead of a redirect. The identical post
without that header still redirects, so the no-JS form behaves exactly as before.
The header avatar is repainted from the fragment's `data-photo-path`, and the
verification tick only appears while `profile.completeness()` says every detail is
on file: clearing the address in the editor removes it in the same re-render.
Sign out is the site's existing `POST /auth/logout` form with its CSRF field.

**One controller for every pop-up.** Both `<dialog>`s on the public site — the
account panel and the booking step panel — are managed by the same
`openSheet`/`closeSheet` pair in `public/main.js`. Opening one calls `showModal()`,
marks the page with `data-popup-open` (overflow hidden, with the scrollbar width
banked in `--popup-gap` so nothing shifts sideways) and puts the previous scroll
position back after the lock. Sheets stack: opening the account panel over the
booking panel keeps the page locked until the last one closes, and a sheet only
releases the lock when it has really left the screen. The × is a real
`<button data-popup-close>` with an `aria-label`, first in the sheet's focus order,
and it closes only its own sheet. A click on the scrim closes a sheet unless one
of its fields holds typing the customer has not saved; Escape always closes, and
once the account sheet shuts its fetched contents are dropped from the document.
The panels are centred squircle cards (30 px radius, hairline warm border, soft
shadow), 620 px wide on desktop and, below 700 px, the screen width less a safe
margin at each edge (19 px at the default text size), with the account panel's
body scrolling inside itself when the content is taller than the screen.

---

## Booking tickets (PDF)

A request is a request until someone at the counter says otherwise. The
confirmation page after `/book` says exactly that — reference number, what was
asked for, and the words *"This is a request, not yet a confirmation"* — and it
offers no download, because there is nothing to download yet.

A ticket appears when staff set the booking to **Confirmed** (marking it
**Served** works too; `TICKET_STATUSES` in `src/lib/ticket.js` is the single list
the route, the view and the generator all read):

- `POST /portal/bookings/:id/status` confirms first and only then calls
  `ticket.issue()`. If the PDF cannot be written the confirmation still stands and
  the flash says so — a broken download must never undo what the studio just did.
- `/account` and the past-bookings table grow a **Download ticket (PDF)** link, and
  `GET /account/ticket/:id` streams the file. The route re-reads the booking, so a
  pending request, somebody else's booking, or an id that does not exist all get the
  same 404 — no status leak.
- Staff are exempt from the profile gate but a ticket is still only ever the
  customer's own copy of their own booking.

**Where the file lives.** `uploads/tickets/booking-<id>.pdf`, created on
demand, one per booking, and `bookings.ticket_path` + `ticket_issued_at` remember
it. That directory is outside `/public/`, and `/uploads/` is gitignored wholesale: a
ticket carries a name, a phone number and a photo, so it is customer data, not
source. Nothing to configure for a normal install — the folder is created on first
use, and only a host with separate persistent storage needs `UPLOADS_DIR`.

**Repeat downloads are the point.** `ensure()` only writes when the file is
missing, so a ticket deleted from disk (a fresh checkout, a cleared cache, a
restore) is regenerated from the live booking row on the next click, and the
customer's link never dies. A booking taken back to **Cancelled** after
confirming stops offering its ticket even though the old file is still on disk.

**What is on it.** The salon name, the reference, one green dot beside
CONFIRMED, service, group, date, time range, duration, the guest's name, the
number the studio can call, their Block, the price text as it is held (which is
usually *"at the studio"*, because prices are not published here), the issue
stamp, the customer's own profile photo when they have one, and the hero portrait
as a 20%-opacity watermark inside the ticket stub — where the only text is the
reference, so nothing has to fight it for contrast.

No real stamp or signature is invented: the studio never supplied one, so the
seal is a drawn double ring captioned *"decorative seal — not an official stamp"*
and the signature line is left unsigned. The cat and flower cut-outs are the
supplied studio artwork, shrunk to ticket size so a download is ~150 KB rather
than 1.8 MB.

---

## Staff portal (`/portal`)

The counter screen the studio works from. It is a separate route tree with its
own stylesheet (`public/portal.css`), its own layout partials and its own
read/query layer (`src/lib/records.js`); the customer-facing pages and their
design are untouched and share only the database.

| Page | What it is for |
| --- | --- |
| `/portal` | Dashboard: today, the queue waiting on a decision, the next seven days, request volume, accounts active in 30 days |
| `/portal/bookings` | Every request — client, service, appointment time, status, when it arrived — with search, status tabs, date range, sort and paging |
| `/portal/bookings/ID` | One request in full, with the decision buttons and a private staff note |
| `/portal/customers` | Accounts that have signed in, with booking counts, last visit and last sign-in |
| `/portal/customers/ID` | One client's profile and their whole booking history |
| `/portal/day/DATE` | The day sheet, hour by hour: who holds each time, block a free time with a reason, reopen a blocked one |
| `/portal/services` | Chair time, price text, description, bookable flag and per-group visibility |
| `/portal/settings` | The salon's operating time zone, weekly opening hours, the four booking rules, and what is wired up vs not |
| `/portal/details` | The business details that ship as `SALON_*` in `.env` — name, tagline, phone, address, year, Maps link, notification email |
| `/portal/staff` | Who can open this portal: make a staff login, promote an existing account, reset a password, switch one off |

**Access is enforced on the server, on every request.** `src/routes/portal.js`
mounts `requireAdmin` for the whole tree; it re-reads the account from the
database by session id, and requires `role = 'admin'` **and** `is_active` before
any handler runs. The header does offer a **Staff** link to signed-out visitors
(`/auth/login?next=/portal`) as a convenience for the person standing at the
counter — it is not a control, and knowing the URL was never one: an anonymous
visitor and a signed-in customer both get a 403 that renders no booking data,
and the JSON variant says only `Salon staff access only.` Deleting the cookie,
editing the page or replaying a POST changes nothing — the role check happens
again server-side, and every mutating form still needs the session's CSRF token.
The old `/admin/*` URLs 302 to their `/portal` equivalents.

**What the portal never shows:** a password hash, a reset token, a session row,
or any credential. `records.customerForStaff()` selects account columns by name
and `scripts/check.js` asserts the returned object has no `password_hash` key,
so a future column cannot quietly start leaking into the roster.

**Statuses** — `pending` (held, awaiting a decision), `confirmed`, `completed`
(served: the time stays closed but it is no longer an open booking),
`rejected` and `cancelled` (both free the time again). `pending`, `confirmed`
and `completed` all hold the slot against a second booking, which is what the
partial unique index enforces.

Confirming a request — or marking it served — is also the moment its PDF ticket
is written, so the download a customer sees at `/account` can never appear
before the studio has accepted the time. See
[Booking tickets](#booking-tickets-pdf).

### The salon's clock

Booking times are wall-clock values on the salon's own time zone, and the zone is
a setting rather than a constant:

1. the `salon_timezone` row in `settings`, chosen at `/portal/settings`;
2. else `SALON_TIMEZONE` from the environment;
3. else `Asia/Kolkata`.

Every time in the portal is labelled with that zone (e.g. `Salon time
(IST · GMT+05:30 · Asia/Kolkata)`), and `public/portal.js` adds the
*reader's* local time underneath each one, so a staff member on another clock
can see both. The footer states which zone the diary is written on and which
zone this device reports. Changing the zone **re-labels** the diary — a 10:30
appointment is 10:30 in the new zone — it does not move appointments that were
booked under the old one, and the settings page says so out loud. An invented
zone name is rejected rather than guessed, and the abbreviation is omitted when
the runtime has no real name for the offset.

### Making a staff account

The **first** staff login has to come from the terminal — before anyone can sign
in, there is nobody on the inside who could hand out access:

```bash
npm run create-admin
```

It asks for an email, a display name and a password (or reads
`BOOTSTRAP_ADMIN_EMAIL/_NAME/_PASSWORD` from `.env`), stores only a bcrypt hash,
and promotes an existing account rather than overwriting its password.

**Every staff login after that is made at `/portal/staff`** by someone who is
already signed in as staff. Typing an email that already has a customer account
promotes it and leaves their password alone; filling in the password box as well
sets that new password and signs the account's other devices out. A login can be
switched off or turned back into a customer account from the same page. Rails:
you cannot deactivate or demote the login you are using, and a second guard
refuses to remove the last working staff login.

There is still **no signup path to `role = 'admin'`**: `/auth/register` always
creates a customer, the portal routes sit behind `requireAdmin`, and every
mutating form needs the session's CSRF token.

### What the portal holds vs what stays in `.env`

`/portal/details` edits the studio's own words — name, tagline, phone, address,
year serving, Maps link, and the address each booking is copied to. The
precedence is the same one the studio clock already uses:

1. the `salon_*` row in `settings`, typed at `/portal/details`;
2. else `SALON_*` from the environment;
3. else the shipped default in `src/config.js`.

Saving applies immediately — `config.salon` is updated in the running process, so
the header, the page titles, the `tel:` link and the outgoing mails change without
a restart. An empty box clears the stored row and hands that one value back to
`.env`. A 10-digit phone is rebuilt as `+91…` for the call button.

The rest of `.env` deliberately **is not** on that page: `SESSION_SECRET`,
`SMTP_*`, `TURNSTILE_SECRET_KEY`, `PUBLIC_APP_URL` and the database file. Those
are credentials and deployment facts. Putting them in a browser-editable form
would mean sending the cookie-signing key and the mailbox password over the site
they protect, and the page says so instead of pretending otherwise.

---

## Editing the catalogue, hours and booking rules

Everything the business may want to change later is data, not code. All of it is
editable in the [staff portal](#staff-portal-portal) (staff login required):

- **`/portal/services`** — edit any service's name, description, chair time and
  **price text**, or mark it unbookable; show or hide a whole group.
  Prices ship as `NULL` and render as *"At the studio"* because none were
  supplied for this build — type the real figures in here. Price text is
  display only; no payment is taken anywhere on this site.
- **`/portal/settings` → Opening hours** — per-weekday open/close, or mark a day
  closed. The seeded closing times are labelled *"Placeholder closing time —
  studio to confirm"*; only the 9:00 am opening was given, so confirm and replace
  them. Chair time is what decides which slots fit inside a day.
- **`/portal/settings` → Booking rules** — the four rules above, each checked
  against its allowed range before it is written.
- **`/portal/settings` → Time zone** — the salon's operating clock, applied to
  the diary and the website at once.
- **`/portal/details`** — the studio's own words: name, tagline, phone, address,
  year serving, Maps link, and who gets a copy of each booking. Each field is
  checked before it is written (length, phone digits, an `http(s)://` Maps link,
  a believable year); the fields that pass still save when one is refused.
- **`/portal/staff`** — who can open the portal. See
  [Making a staff account](#making-a-staff-account).
- **`/portal/day/DATE`** — the day sheet: block a single time (with a reason) or
  reopen it. Blocked times disappear from availability immediately, and a time
  held by a booking cannot be blocked out from under the client.
- **`/portal/bookings`** — search by name, phone, email or note, filter by
  status/day, then confirm, mark served, decline or cancel, with a staff note.
- **`/portal/customers`** and **`/portal/customers/ID`** — the roster and one
  client's history, for the counter.

Customer-facing: `/account` lists **pending vs confirmed** separately, `/account/profile`
updates name/phone/title/notes, and a booking can be cancelled there (which frees
the slot).

---

## Where the customer's files live

Two kinds of file are written while the site is running: a booking's PDF ticket
and a customer's avatar. Both go under `uploads/` at the project root — **not**
under `public/`, which is what the static mount serves to anybody who asks:

```
uploads/tickets/booking-<id>.pdf     written when staff confirm a request
uploads/avatars/<user id>-<12 hex>.<ext>   written when a customer sets a photo
```

The name is the whole reason. A ticket is `booking-3.pdf`, `booking-4.pdf`, and so
on — trivially guessed — and inside each one is a name, a phone number, a time and
often a face. If that folder sat where the browser could reach it by path, signing
in would be a formality: the earlier pass of this code served
`/uploads/tickets/booking-3.pdf` to an anonymous visitor with a `200`, while the
guarded link next to it correctly answered `302`. So:

- **Tickets** are streamed by `GET /account/ticket/:id`, which re-reads the
  booking, checks it belongs to the signed-in account, and `res.download()`s the
  bytes. Nothing under `uploads/tickets/` has a URL.
- **Avatars** need a URL, because the header shows the customer's own photo. One
  route serves them — `GET /uploads/avatars/:name` in `src/app.js` — and it only
  ever opens the single file the signed-in account's `photo_path` already names. A
  stranger's session, no session, or a `name` with `..` in it all get a bare `404`.
- `absoluteFor()` in both `uploads.js` and `ticket.js` refuses any stored path that
  is not one bare filename inside its own folder, so a damaged or crafted database
  row cannot aim a read or a write anywhere else on disk.
- `/uploads/` is gitignored, as is `/data/`. Neither belongs in the repository.

The folders are created on first use, so a normal checkout needs no configuration.
`UPLOADS_DIR` exists for the one case where the default is wrong: a container whose
own filesystem is thrown away between deploys, where the variable points at mounted
persistent storage instead. It is a deployment fact, not a secret.

`npm run check` proves all of this against a live server — it writes a probe PDF
into the tickets folder, confirms the file is really there, asks for it over HTTP
with no session, and expects a `404`; then it hands the same avatar path to three
different requests and expects the owner to be the only one served.

---

## Running it on a server

This is a Node process, not a folder of files: every page is an EJS template
rendered per request, sessions and bookings live in a SQLite file, and a ticket is
drawn with `pdf-lib` when staff confirm one. There is **no build step and no static
output to upload** — a host has to be able to run `npm start` and keep the process
alive. Shared PHP hosting cannot do this at all: no Node runtime, no long-lived
process, and no writable directory that survives a restart for a WAL-mode SQLite
file.

`Dockerfile`, `.dockerignore` and `fly.toml` are set up for
[Fly.io](https://fly.io), which builds the image on its own builder — so this works
from a machine with no Docker installed. The four commands that took the site
live, in order:

```bash
fly auth login                  # approves in the browser; no token to copy around
fly apps create naina-beauty-parlour
fly volume create naina_data -a naina-beauty-parlour -s 1 --region sin -y
fly secrets set SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
fly deploy
```

`.dockerignore` is what keeps the laptop's data on the laptop: `data/` (the SQLite
file, with real names, phone numbers and session rows), `uploads/`, `.env` and
`node_modules/` are all excluded from the build context, so none of it can end up in
an image layer in a registry.

`fly.toml` carries the rest: `NODE_ENV=production`, `COOKIE_SECURE=1`,
`TRUST_PROXY=1`, `PORT=3000` matching the app's internal port, and both
`DATABASE_FILE` and `UPLOADS_DIR` pointed into the mounted volume so customers,
bookings and tickets survive the next deploy. Nothing else is a plain environment
variable — `SESSION_SECRET` stays a secret, and `SMTP_*` / `TURNSTILE_*` are set the
same way when those integrations are wanted:

```bash
fly secrets set SMTP_HOST=… SMTP_USER=… SMTP_PASS=… MAIL_FROM="… <no-reply@…>"
fly secrets set TURNSTILE_SITE_KEY=… TURNSTILE_SECRET_KEY=…
```

`fly open` gets to the site. `fly ssh console -a <app> -u node -C "<command>"` runs
one command inside it as the same user the app runs as — note `-C`, not `-c` (`-c` is
the config file), and that the command is passed straight through without a shell, so
it is one program and its arguments, not a pipeline. A fresh volume holds no database
at all, so the first boot migrates **and seeds** the catalogue, the seven weekday
rows and the booking settings; `server.js` does that on purpose, because a container
that comes up against an empty disk would otherwise render a beautiful site with
nothing bookable on it. `seed()` skips every row that already exists, so a restart
never rolls back a staff edit. The one thing boot cannot do is invent the studio's
own login, so the first staff account is made interactively:

```bash
fly ssh console -a naina-beauty-parlour -u node
npm run create-admin        # asks for email, name and password; do not reuse a customer's
```

Two things to know before pointing a real domain at it. Fly has **no India region**,
so `sin` (Singapore) is the closest machine to Bhadrak — the salon's own clock is
unaffected, because every appointment time is stored as wall-clock on
`SALON_TIMEZONE=Asia/Kolkata`, which is what makes `10:30` mean 10:30 in Bhadrak.
And the machine sleeps when nothing is hitting it (`auto_stop_machines = 'stop'`,
`min_machines_running = 0`), which costs nothing while idle but makes the first
visitor after a quiet spell wait a second or two; set `min_machines_running = 1` to
trade a small monthly charge for that never happening. The app has no HTTPS-redirect
logic of its own — Fly terminates TLS at its edge and forwards `X-Forwarded-Proto`,
which is exactly what `TRUST_PROXY=1` and `COOKIE_SECURE=1` are for. Without them the
site would think it is plain HTTP: cookies stop being `Secure` and password-reset
links are built as `http://`.

Backups are one file plus one folder on the volume: `naina.db` (and its `-wal`) and
`uploads/`. Fly takes scheduled snapshots of a volume (5 retained by default); for a
copy you can hold, pull both database files together, or checkpoint first —
a bare copy of the main `.db` while writes are still in `-wal` misses them.

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
  interpolation into SQL); body size capped at 100 kB, with a route-scoped 800 kB
  limit on `/account/profile` alone so a re-sized avatar can be posted — the
  uploaded bytes are still capped at 400 kB, signature-checked, and renamed by
  the server.
- **Headers** — CSP with `default-src 'self'`, no `'unsafe-inline'` for scripts
  **or styles** (the stylesheet therefore has utility classes instead of
  `style="…"` attributes), `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, HSTS in
  production.
- **Privacy** — a customer sees only their own bookings; ownership is re-checked
  on every read and mutation, so guessing an id returns 404. The staff portal sits
  behind a server-side `admin` role check on every request (see
  [the staff portal](#staff-portal-portal)), its pages carry `noindex` so the
  diary is never crawled, and its queries select account columns by name — a
  password hash, reset token or session row is never in the data a page could
  render. Emails are never enumerated: a
  sign-in failure gives one generic message, and forgot-password behaves the same
  whether or not the address exists (when mail is configured).
- **Profile details** — age, address, Block and photo are held in the `users` row
  and the avatars directory, shown to that customer and to staff; no public page,
  search result or `/api/*` route reads them, and the account page is behind
  `requireUser`. `/uploads/` is gitignored and lives outside `/public/` because those
  files are real faces, names and phone numbers tied to real accounts;
  `safeRelativePath()` means a form can only ever point at a filename this server
  wrote in that directory, and no file under it is reachable over HTTP without
  signing in — see [Where the customer's files live](#where-the-customers-files-live).
- **Errors** — 5xx responses carry a generic sentence; the stack trace goes to
  the server log only.

---

## Accessibility and mobile behaviour

- Verified with no horizontal page overflow at 320, 390, 768, 1024 and 1280 px;
  the layout is mobile-first and only ever widens (`min-width` breakpoints at
  820, 900, 940 and 960 px, plus two `max-width` refinements at 560 and 620 px).
- Choosing a day and a time happens in a centred, rounded `<dialog>` step panel
  over a dimmed backdrop. It is server-rendered **open**, so with JavaScript off it
  is simply the next section of the page and the form submits like any other; JS
  then moves it into the modal sheet. The back control is a real link in the panel's
  top-left — first it returns to the times, then it closes the panel — and it never
  clears the chosen day, the chosen time or the typed details, because nothing is
  stored in the browser.
- Both pop-ups carry a visible × with an accessible name ("Close the booking
  panel", "Close the account panel") as the first control in the sheet, and it is
  reachable and operable by keyboard. Escape closes either one; a scrim click closes
  it too unless a field holds unsaved typing. The page behind cannot scroll while a
  sheet is open and returns to the same scroll position afterwards. Sheets fit the
  viewport at 375, 690 and 1280 px, and below 700 px they use the screen width less
  a safe edge margin, with their own internal scrolling.
- The frangipani sprigs are `aria-hidden`, `pointer-events: none`, sized to fit
  inside a section's own padding band so they cannot overlap a line of text, and
  dropped below 860 px and in print.
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
- The completion bar is a real `role="progressbar"` with `aria-valuenow`, and the
  percentage next to it sits in an `aria-live="polite"` region, so saving one
  detail is announced without moving the caret. It is five fixed segments rather
  than a percentage-width fill because the CSP allows no inline styles; each
  segment carries the step's own label, so progress is readable without colour.
- Password fields share one partial with a `Show`/`Hide` button whose accessible
  name always ends in "password" (`<span class="sr-only">`), and every error is
  joined to its input with `aria-describedby` + `aria-invalid`.
- Below 700 px the hero stacks and centres: the portrait sits mid-page with the
  two pill CTAs — Book an appointment and See services — beneath it, and the
  header's account controls collapse into the compact menu.
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
the auth and account templates follow along without edits. The staff portal
shares the same tokens from its own stylesheet (`public/portal.css`), which is
why it reads as the same studio rather than a bolted-on back office.

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
photograph, so the team can see at a glance what shooting is still outstanding.

### The studio's own cut-outs: frangipani, cat, portrait

Three pictures the studio supplied are decoration rather than photo slots, so
they live outside the registry above: `public/assets/art/flower-stem.png` (the
frangipani stem), `cat-cutout.png` (the cat) and `hero-portrait-cutout.png` (the
hero figure, which is also the hero slot's stand-in). All three arrive as
transparent PNGs and are placed straight on the page — no mat, no border.

Each one is used through a smaller copy drawn from it, never at full size:
`flower-accent.png` (150 px wide) is the corner sprig, and
`ticket-portrait.png` / `ticket-flower.png` / `ticket-cat.png` (240 / 96 / 132 px)
are embedded in the ticket PDF, which keeps a download around 150 KB instead of
the 1.8 MB the originals would cost. The originals are the source of truth and
are committed unchanged; `npm run art:ticket` (`scripts/ticket-art.js`) rebuilds
every derived copy from them with nothing but Node's own `zlib` — it decodes and
writes the PNGs itself, downsampling with alpha-weighted colour so a soft edge
never darkens. Run it again after dropping a new flower, cat or portrait over an
original.

The sprigs are one `<img>` partial (`views/partials/flower.ejs`) included at a
corner of each page's main section and the footer: 38–54 px, ~40% opacity, sitting
inside the section's own padding band so it can never land on a line of text,
`aria-hidden` and `pointer-events: none`, and removed below 860 px and in print.

### The hero: wordmark left, portrait right, nothing overlapping

The hero's picture carries its own transparency: no mat, border, rounded corner
or shadow, so the figure sits straight on the white-to-peach gradient. From 700px
up the oversized `NAINA` wordmark is left-aligned and she stands to its right, so
the last letter stops where her hair begins — the two halves meet rather than
cross, and neither one obscures the other. Below 700px they stack: the word on its
own line, then her, pushed into the same right-hand corner she occupies above.

Every position is derived from where her silhouette actually is, not from the edge
of the picture box. The PNG's alpha bounding box is x 62–729 of 880 and y 275–1099
of 1100, so the stylesheet keeps three constants — `--fig-ink-l`, `--fig-ink-r` and
`--fig-crown` — and places her by them. One more variable, `--word-slot`, is the
band of pixels left of her: the wordmark's font-size is `--word-slot / 4.15` (4.15em
is the widest "NAINA" the serif stack can produce, Palatino Linotype at 3.955em, with
a few percent spare) and the copy column is cut to the same width, so the headline
breaks on the edge the word ends on at every viewport from 700 to 1920. The
wordmark's peach gradient now fades only to about 62% alpha: it no longer crosses
her face, and ink that thinned to nothing on a pale background read as a bug.

She is the bottom layer, the wordmark the middle and the copy the top, so the
headline and the booking buttons survive any width the picture reaches; her box is
`pointer-events: none` above 700px, where it leaves the grid and is positioned over
the text column.

### The header and hero animate; nothing else does

The reference clip is one slow camera move, so the entrance is the same idea: the
header's three parts drop in, the wordmark settles from tighter tracking to its own
(`.025em → .08em`, the direction that can only ever narrow the word, never push it
across her), she rises 36px into place behind it, and the copy, the badge and the
three cards ease up after her on staggered delays. `hero-drift` then keeps the
picture alive with a ±5px lift every sixteen seconds, and a pointer parallax leans
her a few pixels against the wordmark's movement — `main.js` writes plain `±1`
numbers into `--par-x` / `--par-y` and the stylesheet decides the amplitudes, next
to the measurements they have to stay inside. At the extreme the word still clears
her hair by 21px, her crown still clears the clipped top of the hero by 19px, and
she still leaves the copy column 8px short.

No section below the hero moves, and the last frame of every animation is the layout
described above, so what was measured is what settles. Under
`prefers-reduced-motion: reduce` the entrance, the drift and the parallax are all
switched off by name — each element simply renders where it animates towards, with
no frame in which the wordmark or the portrait is missing — and `main.js` never
attaches the pointer listener.

### One-row header below the desktop cursor

A sticky header that stacks the brand, the menu button and two buttons over
three rows consumed about a third of a phone viewport, so under 960px it
collapses to a single 60px row: the account links move into the menu panel, the
wordmark drops "Parlour" (and "Beauty" below 380px), and the sign-in pill shrinks
to its label alone. CSS shows exactly one of each pair at every width, so the
accessibility tree never doubles up — `views/partials/head.ejs` carries both and
`.header-cta__auth` / `.nav__auth` decide which is live.

The header holds no booking button: requesting a time belongs to the hero, the
nav and the service pages, and a second copy at the top pushed the account
controls around on small screens. What sits there instead is a round
**account icon** beside the pill **Sign in**. Before login both open the
authentication page (the icon is the same destination, not a hidden second
route); after login the icon becomes the only control and points at
`/account`, showing the customer's own photo when the profile has one, so the
signed-in state is visible without reading a name. Staff keep **Staff area** in
the same row — it was never renamed and it never moves.

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

`npm run check` opens the database in a transaction it always rolls back (plus
throwaway accounts, staff logins and ticket PDFs it deletes afterwards) and
asserts:

```
PASS  service catalogue seeded — 39 bookable services
PASS  weekday rows present — 7/7
PASS  availability comes from the database — 16 free slot(s) on 2026-10-27 for Bridal Makeup
PASS  first request is created as pending — #9 at 09:00
PASS  taken slot disappears from availability
PASS  second request for the same slot is refused — Someone has just taken that slot. Please pick another time.
PASS  unique index blocks a direct duplicate insert — constraint fired
PASS  staff can confirm a pending request — #9 is confirmed
PASS  a confirmed slot still refuses a second booking — Someone has just taken that slot. Please pick another time.
PASS  cancelling frees the booking
PASS  freed slot is bookable again
PASS  another account cannot act on someone’s booking — That booking belongs to another account.
PASS  staff can mark a request served — #10
PASS  a served appointment keeps its time off the market
PASS  …but it is not an open booking for the client — 0 open
PASS  the widened unique index covers served bookings too — constraint fired
PASS  the day sheet sees who holds each time — 1 held slot(s)
PASS  the portal guard lets an admin through
PASS  …and refuses a signed-in customer
PASS  …and refuses an anonymous request
PASS  staff search matches the test requests — 2 hit(s)
PASS  a hostile filter falls back instead of reaching SQL — newest / all / page 1
PASS  customer reads never carry a password hash — #57
PASS  a roster filter outside the allowlist is ignored
PASS  the Block list is the seven around Bhadrak, spelled as the dropdown shows them — 7 entries
PASS  the bar reads 20 / 40 / 60 / 80 / 80 / 100 as the details land — 20 → 40 → 60 → 80 → 80 → 100
PASS  an address with no Block chosen does not close the profile
PASS  …and neither does every detail except the name
PASS  the missing list names what is still to add — phone number, age, profile photo, address, Block
PASS  an age of 0 or 200 is never accepted by the maths
PASS  a Block typed by hand is checked against the list
PASS  the column accepts every Block the dropdown offers — 7/7
PASS  …and the database itself refuses one outside the seven — constraint fired
PASS  the same column guard covers the age — constraint fired
PASS  a path outside the avatars folder is never treated as one of ours
PASS  deleting a photo leaves any file it does not own alone
PASS  real PNG bytes are accepted
PASS  bytes that are not a picture are refused whatever mime they claim — That file is not a picture we can use. Choose a JPEG, PNG or WebP image.
PASS  junk that is not base64 at all is refused
PASS  an oversized payload is refused before anything is written
PASS  an empty pick is a skip, not an error
PASS  a signed-in customer with an incomplete profile cannot open the booking page — /account/profile
PASS  …and the booking API answers 403 instead of a redirect a script can follow — Your profile is 20% complete. Please add
PASS  an anonymous request is sent to sign in first
PASS  staff logins are exempt — they book at the counter
PASS  a complete profile gets through the gate — 100%
PASS  …and it closes again the moment one detail is taken back out
PASS  a save that omits a detail leaves the stored value in place
PASS  …but a Block the form never offered is dropped rather than written
PASS  a salon wall time resolves to one real instant — 2026-10-27 10:30 → 2026-10-27T05:00:00Z
PASS  an invented zone name is refused rather than guessed — GMT+05:30
PASS  reset tokens are stored as sha-256 digests
PASS  changing a password signs every other device out
PASS  …and drops the account’s outstanding reset links
PASS  the new password is the one that verifies
PASS  promoting an existing account keeps their own name — Kept Name · admin
PASS  …and the password they already chose still signs them in
PASS  a staff login with no password for an unknown email is refused — needs a password
PASS  the portal can make a staff login — #59
PASS  the staff list never carries a password hash — 3 staff row(s)
PASS  taking the staff role closes their open portal session
PASS  switching a login off stops it signing in at all
PASS  …and drops their outstanding reset links
PASS  …but leaves the account itself, and its bookings, in place
PASS  two details report as saved — Salon name, Phone number
PASS  the saved name wins over the environment value — Naina Beauty Parlour → Check Parlour
PASS  …and is pushed into the running config, so the header and the mails change without a restart
PASS  a phone typed by staff rebuilds the tel: link — +919439712995
PASS  the saved keys are listed as portal-held
PASS  …and the studio clock row is not swept in with them — salon_name, salon_phone
PASS  an empty box hands the value back to .env — Naina Beauty Parlour
PASS  …and every rendered detail has a value to fall back on
PASS  only a confirmed or served request can carry a ticket — confirmed, completed
PASS  a pending request is refused a ticket — not-confirmed
PASS  …and the staff-side issue call throws rather than writing one — That booking is not confirmed.
PASS  a confirmed request writes a real PDF — 143 KB
PASS  …and the booking remembers where it lives and when it was issued — /uploads/tickets/booking-9.pdf · 2026-10-23 21:06:44
PASS  the row carries the owner, so the download route can check who is asking
PASS  asking twice serves the same file instead of rewriting it
PASS  a file deleted from disk is regenerated, so the link never dies
PASS  a booking taken back after confirming stops offering its ticket — not-confirmed
PASS  the ticket font survives the rupee, the dash and the ellipsis — Rs.1,200 - 3:30 pm - 5:00 pm . "bridal" ...
PASS  the files live outside the folder the web server serves — …/uploads
PASS  …and the probe ticket really is on disk
PASS  nobody can download a booking PDF by its filename — 404 text/html; charset=utf-8
PASS  a signed-in customer’s photo is not readable without signing in — 404
PASS  the owner is handed their own photo, and only that file
PASS  another signed-in account cannot read it
PASS  …not even by slipping a path into the filename
PASS  …while the site’s own CSS and pictures still serve — 200 text/css; charset=UTF-8
117/117 checks passed.
```

(The pop-up group in between is abbreviated here; `npm run check` prints all of it.)

The portal was then driven over **real HTTP** against the running server — every
page and every mutating form — to confirm what an in-process test cannot: that
the guard fires before a handler, that a 403 carries no booking data, that a
stale or missing CSRF token is refused with 400 while the session's live token
is accepted, that a search/filter/paging query string cannot reach SQL, that
blocking a time removes it from `/api/availability` and that reopening it
returns, that an out-of-range booking rule is refused rather than stored, that
saving a time zone re-labels the diary without moving an appointment, that
`/portal/details` refuses an implausible year / a non-`https` Maps link / a
phone with no digits while still saving the fields that passed, that a login
made at `/portal/staff` opens the portal on its first try, and that a demoted or
switched-off staff account loses its open portal session on the very next
request. All 110 of those assertions passed, and the rows the run touched
(statuses, staff notes, opening hours, `salon_*` settings, throwaway logins) were
restored afterwards — the database this README was written against is the one it
started from.

The sign-in and profile flow was driven the same way, over **real HTTP** against
a running server — 35 assertions, all passing. A throwaway account registered
with a name and a phone lands at 40%, is bounced off `/book` to
`/account/profile`, and gets a 403 from the slot JSON; saving an age moves the
rendered bar to 60% and names all seven Blocks in the dropdown; a Block outside
the list, a non-numeric age, bytes that are not a picture and an SVG that calls
itself a PNG are each refused with the offending field named and nothing
written; the complete save lands on `/account`, the bar is gone, the blue tick is
beside the photo and says it is not an identity check, the avatar is served back
over HTTP, and booking opens. Deleting the photo closes the gate again on the
same request. The header is checked in the same run: no booking button, an
account icon, **Staff area** still present, and the three-way
sign-in / register / forgot-password switch carrying `?next=`.

The ticket was driven over **real HTTP** too, against a live booking rather than
a fixture: once staff confirm, `GET /account/ticket/<id>` answers with a real
`application/pdf` and a download filename, the same link keeps working on every
visit afterwards without the file being rewritten, and a *pending* request,
another account's booking and an id that does not exist each answer 404 while an
anonymous visitor is sent to sign in. Replaying the booking `POST` is refused
server-side with the "someone has just taken that slot" 409 instead of writing a
second row, and the confirmation page renders the reference with no download
button and no "What happens next" section — there is nothing to download yet.
In a real browser, the free times open in the centred rounded `<dialog>` step
panel, its back control returns to the times and then closes the panel without
clearing the chosen day, the chosen time or the typed details, and the submit
button is disabled until a time is picked and stays disabled while the request
is on its way. The frangipani sprigs were measured line by line against the text
of every page that carries one — no collision at any width from 880 to 1440 px,
and they are dropped below 860 px.

Beyond the script, the whole flow was re-run against a **wiped database** using
only the documented commands (`npm run db:setup`, `npm run create-admin`,
`npm start`): a visitor registered, saw 16 real free times from the diary, sent
a request, saw it as *pending*, a staff login confirmed it, the customer then saw
*confirmed*, and a second request for that same slot was refused with 409 — 13
steps, all passing. Every route (including all 8 category pages, the guard
redirects, the 404, the 410 expired-reset page and the CSRF rejection page)
renders without a server error, and the browser console is clean on every page.

The database in `data/` is gitignored, so a clone starts with the seeded
catalogue and **no accounts at all** — no demo customer, no demo staff login.
Create your own with `npm run create-admin`.

Mobile and accessibility were measured in a real 390 px viewport: no page pans
horizontally, no control falls below the 44 px height guideline (the consent
checkbox excepted — see above), every field has a label, all text colour pairs
clear WCAG AA 4.5:1, keyboard focus draws a visible ring on links, buttons,
inputs and slot tiles, and the time grid is a labelled `fieldset` navigable with
arrow keys. The portal was measured the same way at 390, 660 and 1440 px: no
horizontal panning at any width (wide tables become stacked cards below 720 px,
the day-sheet rows wrap their inline form onto its own line, and the sidebar nav
becomes a scrollable strip), every `input`, `select` and
`textarea` carries a label, each page has one `h1` plus `header`/`nav`/`main`/
`footer` landmarks and a skip link, table headers carry `scope`, every tap target
clears WCAG 2.5.8 (the smallest control measured was 30 px tall), and each status
pill is paired with its word rather than relying on colour alone.

The deployed container was checked the same way, against the live host rather than
localhost. `/healthz` answers `{"ok":true,"database":true,"captcha":"local-image",
"mail":"none","env":"production"}`; `/`, `/services`, `/studio`, `/location`,
`/how-to-book`, `/auth/login` and `/auth/register` render, `/book` and `/account`
redirect to sign-in, and `/portal` answers **403** to an anonymous request rather
than a redirect — the guard is enforced before a handler, not by hiding a link.
`/api/availability` returns real generated times for a three-day-forward date. The
session cookie arrives `HttpOnly; Secure; SameSite=Lax`, HSTS is set, the CSP header
is the app's own, and no page carries an inline script. The files that used to be
reachable are not: `/uploads/tickets/booking-3.pdf`, `/uploads/avatars/<a real
filename from the local database>` and a bare `/uploads/` directory each answer 404,
while `/styles.css` and the illustrative artwork still serve `200`. The rendered
pages contain no `₹` or `Rs` amount anywhere and every generated image carries its
**Illustrative** label (36 of them on the home page). Inside the machine, the
database and its `-wal` sit on the mounted volume rather than the image, and the
`node` user the app runs as can write into `UPLOADS_DIR`. One fresh-volume boot was
tested on a throwaway `DATABASE_FILE`: migrate, then seed — 8 categories, 39
services, 7 weekday rows, 5 settings — and the availability API answered on the
first request, with no manual `db:setup`.
