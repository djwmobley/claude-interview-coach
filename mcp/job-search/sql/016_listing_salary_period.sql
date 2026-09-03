-- 016: structured pay period on ic_job_listings (hourly-disqualifier ruling, docs/auto-apply-spec.md).
--
-- Damian's ruling (2026-09-03): never apply to hourly-rate jobs. src/core/normalize.js's parseSalary now
-- returns a total pay-period classification (hour/day/week/month/year/unknown, never a throw) alongside
-- salary_min/salary_max; this column persists it so src/core/auto-apply-select.js's `hourly_pay` closed
-- reason (checked before `daily_cap`) can classify a listing as hourly-pay WITHOUT re-parsing salary_raw
-- on every select run.
--
-- salary_period: one of 'hour'|'day'|'week'|'month'|'year'|'unknown', or NULL for a listing scanned/
--   adopted before this migration (never backfilled automatically here -- see
--   bin/backfill-salary-period.js for an optional, explicitly-invoked, read-mostly backfill). NULL and
--   'unknown' are both "no positively-known period" from a caller's point of view; auto-apply-select.js's
--   hourly_pay signal falls back to inspecting salary_raw directly whenever salary_period is NULL, exactly
--   as it already would for a pre-migration row.
--
-- Pure idempotent DDL (ADD COLUMN IF NOT EXISTS), no data backfill -- same "safe to run on every server/
-- worker startup" convention sql/011-015 established. Registered in all three migration lists per that
-- precedent (bin/migrate.js MIGRATIONS, src/core/schema.js AUX_MIGRATIONS, bin/bootstrap-test-db.js
-- MIGRATIONS).

BEGIN;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS salary_period text;

COMMIT;
