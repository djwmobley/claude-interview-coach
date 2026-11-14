-- 032: Indeed verification park (2026-11-13).
--
-- When an unattended scan meets an Indeed human-verification challenge it leaves that tab open, pings the owner,
-- and records where, on the 'indeed' row of ic_source_state only:
--   parked_at        when the challenge parked the source; NULL = not parked. Later scans skip Indeed while set.
--   park_url         the challenge page URL (query string already stripped by the capability).
--   park_target_id   the CDP target id of the tab left open.
-- A re-enable of indeed or indeed:detail sets all three back to NULL. No wall is recorded for a park.
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-031 precedent.

BEGIN;

ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS park_url text;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS park_target_id text;

COMMIT;
