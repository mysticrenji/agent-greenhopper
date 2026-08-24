-- 0002_run_lock.sql — run lock for overlapping cron/manual run prevention
--
-- A simple lease table. A row exists while a run is in progress; the TTL allows
-- self-healing if a run crashes without releasing. The agent DELETEs expired rows
-- before attempting to acquire, so a stale lock never blocks indefinitely.

CREATE TABLE IF NOT EXISTS run_lock (
  id          TEXT    PRIMARY KEY,
  acquired_at INTEGER NOT NULL,
  ttl_ms      INTEGER NOT NULL
);
