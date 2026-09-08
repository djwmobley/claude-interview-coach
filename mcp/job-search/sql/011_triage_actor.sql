-- 011: widen ic_job_events.actor to accept 'auto' (slice 3 auto-triage, docs/slice3-auto-triage-spec.md
-- section 8). Pure idempotent DDL, no data backfill, via ic_ensure_widened_check(), the shared helper
-- defined in sql/009_pipeline_events_documents.sql (see the comment there for why the guard here is a
-- DEFINITION comparison rather than a name-keyed one: this exact file, re-running on a startup after
-- sql/012_applications.sql had already widened the same column further, is the scenario that caused the
-- 2026-09-06 incident under the old name-keyed guard). This file never references sql/012's constraint
-- name -- ic_ensure_widened_check() finds whatever CHECK currently covers the column by inspecting the
-- column itself, so a wider constraint installed by a later migration is recognized as already covering
-- this one's target set no matter what it is named.
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
BEGIN
  PERFORM ic_ensure_widened_check('ic_job_events', 'actor', 'ic_job_events_actor_auto_check', ARRAY['dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto']);
END $$;

COMMIT;
