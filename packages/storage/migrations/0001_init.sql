-- 0001_init.sql — initial schema for agent-greenhopper
--
-- Conventions used throughout:
--
--   * Timestamps are **unix milliseconds**, matching the domain layer exactly.
--     Storing seconds would save nothing measurable and would add a conversion at
--     every boundary, which is where off-by-1000 bugs live.
--   * No STRICT tables. D1's support for them is not something this project has
--     verified, and the repositories plus zod already constrain what is written.
--   * Nullable measurement columns. A Mi Flora reports `unavailable` routinely
--     between advertisements, and battery only once a day, so a bucket with some
--     signals missing is the normal case rather than an error.

-- Rolled-up sensor readings, one row per plant per 15-minute bucket.
--
-- Deliberately wide (a column per signal) rather than narrow
-- (plant_id, ts, signal, value). D1 bills by rows read and written, and the
-- narrow shape would multiply both by seven for a fixed, well-known set of
-- signals. Adding a signal is a migration, which is the right amount of friction.
--
-- Air temperature and humidity are duplicated across plants that share a room
-- sensor. That denormalisation is intentional: it keeps every query single-table,
-- and at roughly 96 buckets/day/plant the storage cost is irrelevant.
CREATE TABLE IF NOT EXISTS readings (
  plant_id     TEXT    NOT NULL,
  bucket_start INTEGER NOT NULL,
  moisture_pct REAL,
  soil_temp_c  REAL,
  lux          REAL,
  ec_us_cm     REAL,
  battery_pct  REAL,
  air_temp_c   REAL,
  humidity_pct REAL,
  PRIMARY KEY (plant_id, bucket_start)
);

-- Supports pruning old buckets without scanning per plant.
CREATE INDEX IF NOT EXISTS idx_readings_bucket ON readings (bucket_start);

-- Daily derived aggregates. These are what make multi-month comparison possible
-- once Home Assistant's recorder has purged the detail (~10 days by default).
CREATE TABLE IF NOT EXISTS daily (
  plant_id       TEXT    NOT NULL,
  day            TEXT    NOT NULL,  -- YYYY-MM-DD in the owner's local time zone
  dli            REAL,              -- relative daily light integral
  vpd_mean       REAL,
  vpd_max        REAL,
  dry_rate_pct   REAL,              -- %/day, negative while drying
  ec_normalised  REAL,              -- EC at reference moisture
  PRIMARY KEY (plant_id, day)
);

-- Alert suppression state, one row per (plant, finding). Maps 1:1 onto the
-- domain's AlertState so planAlerts() can round-trip without translation.
--
-- A resolved condition is DELETED rather than flagged, because the domain treats
-- absence of state as "this is new" — which is exactly what should happen when a
-- problem recurs after recovering.
CREATE TABLE IF NOT EXISTS alert_state (
  plant_id         TEXT    NOT NULL,
  code             TEXT    NOT NULL,
  first_seen_at    INTEGER NOT NULL,
  last_notified_at INTEGER,
  peak_severity    TEXT    NOT NULL,
  PRIMARY KEY (plant_id, code)
);

-- Append-only audit of what was actually sent, suppressed, or resolved.
--
-- Exists so "why did I not get told about this?" is answerable after the fact.
-- Suppressions are recorded too; an alert policy you cannot audit is one you
-- cannot trust.
CREATE TABLE IF NOT EXISTS notifications (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  plant_id  TEXT    NOT NULL,
  code      TEXT    NOT NULL,
  kind      TEXT    NOT NULL,  -- notify | suppress | resolve
  channel   TEXT,              -- push | digest, null when suppressed
  severity  TEXT,
  trigger   TEXT,              -- new | escalated | reminder, or suppression reason
  message   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_at ON notifications (at);
CREATE INDEX IF NOT EXISTS idx_notifications_plant ON notifications (plant_id, at);
