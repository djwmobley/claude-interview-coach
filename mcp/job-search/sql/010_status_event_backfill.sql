-- 010: one-time backfill of a 'status' event for legacy rows that predate the ic_job_events log
-- (defect 7 fix, split out of sql/009_pipeline_events_documents.sql). This migration is deliberately NOT
-- part of src/core/schema.js's AUX_MIGRATIONS list, so ensureAuxSchema() never runs it -- it belongs only
-- in `node bin/migrate.js apply`'s MIGRATIONS list (bin/migrate.js), a rare, deliberate, human-invoked
-- action, never on every ordinary dashboard/MCP server startup (src/core/startup.js's startupDb()) or in
-- any test file's ensureAuxSchema(client) call.
--
-- Why this had to move: the original version of this backfill lived inside sql/009 and was guarded by
-- NOT EXISTS keyed on an exact note-text match ("no event with this exact backfill note yet"), not on
-- "no status event of any kind yet". Because sql/009 as a whole runs on every startup (it also carries
-- CREATE TABLE IF NOT EXISTS / idempotent DDL that genuinely is safe to re-run forever), that note-text
-- guard kept matching any row that later acquired marked_at -- including a listing created and marked
-- long after migration 009 first ran, which is a completely ordinary, everyday event, not a one-time
-- historical backfill case. Observed in the real database: a second run of bin/seed-opportunities.js
-- wrote, for every one of that run's 8 seeded rows, a spurious status event with actor 'migration' in
-- addition to the seed's own real status event, because a dashboard/MCP server had started up (and so
-- re-ran ensureAuxSchema -> sql/009's old backfill) between the two seed runs, and every one of those
-- freshly seeded rows had picked up a fresh marked_at with no event carrying that exact note text yet.
--
-- The corrected guard here is "this listing has no status event of any kind" (NOT EXISTS ... kind =
-- 'status'), not "no status event with this exact note". A row that already has any real status event --
-- from createManualListing, applyMark, a scan-run status change, an earlier run of this very migration,
-- or anything else -- is never eligible for a synthetic backfill again, no matter how many times this
-- file is applied.
--
-- That event-derived guard is still not sufficient by itself, though: it is derived from the CURRENT
-- contents of ic_job_events, not from whether this migration has ever actually run. If a listing's
-- status event (synthetic or real) is later deleted for any reason, the row once again has "no status
-- event of any kind" and would re-qualify for a fresh synthetic backfill the next time
-- `node bin/migrate.js apply` runs, even though the backfill already happened once. A one-time migration
-- must not re-open its own eligibility just because someone deleted downstream data. The ic_job_migrations
-- ledger below records that this migration's backfill logic has already executed, independent of what
-- happens afterward to the rows it touched, so a later deletion of events can never re-trigger it.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_job_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ic_job_events (listing_id, kind, from_status, to_status, note, actor, at)
SELECT id, 'status', NULL, status, 'backfilled from marked_at by migration 010', 'migration', marked_at
FROM ic_job_listings
WHERE status IS NOT NULL
  AND marked_at IS NOT NULL
  AND coalesce(record_kind, 'listing') = 'listing'
  AND NOT EXISTS (
    SELECT 1 FROM ic_job_events e
    WHERE e.listing_id = ic_job_listings.id AND e.kind = 'status'
  )
  AND NOT EXISTS (
    SELECT 1 FROM ic_job_migrations WHERE name = '010_status_event_backfill'
  );

INSERT INTO ic_job_migrations (name) VALUES ('010_status_event_backfill')
ON CONFLICT (name) DO NOTHING;

COMMIT;
