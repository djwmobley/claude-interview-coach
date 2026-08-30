-- 011: widen ic_job_events.actor to accept 'auto' (slice 3 auto-triage, docs/slice3-auto-triage-spec.md
-- section 8). Pure idempotent DDL, no data backfill, following the exact pattern
-- sql/009_pipeline_events_documents.sql already uses to widen ic_scan_runs.trigger's CHECK: find
-- whatever CHECK constraint currently covers ic_job_events.actor, drop it, and replace it with a fixed,
-- known name, guarded so a second run is a no-op.
--
-- Safe to run on every startup, unlike sql/010_status_event_backfill.sql's one-time backfill (which is
-- deliberately excluded from src/core/schema.js's AUX_MIGRATIONS): this file only widens a CHECK
-- constraint, it never touches row data. Applied from three places (spec section 8): bin/migrate.js's
-- MIGRATIONS array, src/core/schema.js's AUX_MIGRATIONS (so a process started against a database that
-- has not run `bin/migrate.js apply` still gets the widened constraint via ensureAuxSchema()), and
-- bin/bootstrap-test-db.js's own hardcoded MIGRATIONS constant (finding 12: that third list is
-- independent of the other two and is what `npm test` actually re-applies against the isolated test
-- database on every run).

BEGIN;

DO $$
DECLARE
  dropsql text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'ic_job_events' AND c.conname = 'ic_job_events_actor_auto_check'
  ) THEN
    SELECT string_agg(format('ALTER TABLE ic_job_events DROP CONSTRAINT %I', c.conname), '; ')
      INTO dropsql
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'ic_job_events' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%actor%';
    IF dropsql IS NOT NULL THEN EXECUTE dropsql; END IF;
    ALTER TABLE ic_job_events ADD CONSTRAINT ic_job_events_actor_auto_check
      CHECK (actor IN ('dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto'));
  END IF;
END $$;

COMMIT;
