-- 001_init.sql
-- Core schema for Naina Beauty Parlour: accounts, sessions, service catalogue,
-- opening hours, appointment slots and bookings.

CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL COLLATE NOCASE,
  name            TEXT    NOT NULL,
  phone           TEXT,
  preferred_title TEXT,            -- optional: "Ms." / "Mr." / "Mx." / anything
  notes           TEXT,            -- optional free text the customer keeps on file
  password_hash   TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT,
  last_login_at   TEXT
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Server-side session store (cookie holds only the signed id).
CREATE TABLE sessions (
  sid        TEXT    PRIMARY KEY,
  sess       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at_key ON sessions (expires_at);

-- One row per weekday. 0 = Sunday … 6 = Saturday, Asia/Kolkata wall clock.
-- Seeded with a 09:00 opening and a 19:00 closing placeholder that the studio
-- edits from /admin; nothing on the public site claims a closing time.
CREATE TABLE opening_hours (
  weekday   INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  is_closed INTEGER NOT NULL DEFAULT 0,
  opens_at  TEXT    NOT NULL DEFAULT '09:00' CHECK (opens_at  GLOB '[0-2][0-9]:[0-5][0-9]'),
  closes_at TEXT    NOT NULL DEFAULT '19:00' CHECK (closes_at GLOB '[0-2][0-9]:[0-5][0-9]'),
  note      TEXT,
  updated_at TEXT
);

-- Tunables the studio can change without a code deploy.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE service_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  summary    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- price_text stays NULL until the studio supplies real prices; the UI then
-- shows "price confirmed at the studio" instead of an invented figure.
CREATE TABLE services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id      INTEGER NOT NULL REFERENCES service_categories (id) ON DELETE CASCADE,
  slug             TEXT    NOT NULL UNIQUE,
  name             TEXT    NOT NULL,
  description      TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 480),
  price_text       TEXT,
  is_bookable      INTEGER NOT NULL DEFAULT 1,
  is_active        INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT
);
CREATE INDEX services_category_key ON services (category_id, is_active);

-- One row per bookable clock time on a date. `blocked` is a studio-side
-- closure; a slot is "taken" when an active booking points at it, which keeps
-- bookings as the single source of truth and avoids status drift.
CREATE TABLE slots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_date    TEXT    NOT NULL CHECK (slot_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  start_time   TEXT    NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'blocked')),
  block_reason TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (slot_date, start_time)
);
CREATE INDEX slots_date_status_key ON slots (slot_date, status);

CREATE TABLE bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id         INTEGER NOT NULL REFERENCES slots (id) ON DELETE RESTRICT,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  service_id      INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  contact_name    TEXT    NOT NULL,
  contact_phone   TEXT,
  preferred_title TEXT,
  note            TEXT,
  staff_note      TEXT,
  staff_action_at TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT
);
-- The database itself refuses a second active booking for the same slot.
CREATE UNIQUE INDEX bookings_one_active_per_slot_key
  ON bookings (slot_id) WHERE status IN ('pending', 'confirmed');
CREATE INDEX bookings_user_key ON bookings (user_id, status);
CREATE INDEX bookings_status_key ON bookings (status, created_at);

-- Single-use password reset links. Only the SHA-256 of the token is stored.
CREATE TABLE password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX password_resets_user_key ON password_resets (user_id, expires_at);

-- The migration ledger (schema_migrations) is created by src/db/migrate.js.
