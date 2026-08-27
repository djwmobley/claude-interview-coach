-- 009: pipeline event log, linked documents, dashboard scan trigger, and the legacy 'active' status
-- remap (dashboard PR 1, plan section "Data model changes" plus pr1-spec-decisions.md). Idempotent:
-- every statement is safe to run twice, including the two data-migration passes near the bottom, which
-- are guarded by NOT EXISTS checks keyed on a fixed note string rather than a one-time flag, so a
-- second `node bin/migrate.js` run (or the test-db bootstrap's own re-apply-for-idempotence pass) adds
-- nothing.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- ic_job_events: one row per status/note/fit change, manual creation, document link, follow-up action,
-- or reply, across every actor (dashboard, mcp, cli, migration, seed).
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ic_job_events (
  id serial PRIMARY KEY,
  listing_id int NOT NULL REFERENCES ic_job_listings(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('status', 'note', 'fit', 'created', 'document', 'followup', 'reply', 'migrated')),
  from_status text,
  to_status text,
  note text,
  actor text NOT NULL CHECK (actor IN ('dashboard', 'mcp', 'cli', 'migration', 'seed')),
  run_id int REFERENCES ic_scan_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ic_job_events_listing_at_idx ON ic_job_events (listing_id, at DESC);
CREATE INDEX IF NOT EXISTS ic_job_events_at_idx ON ic_job_events (at DESC);

-- ---------------------------------------------------------------------------------------------------
-- ic_job_documents: links between a listing and a file under output/ (resume, cover letter, cheat
-- sheet, markdown source, company research, scan report, or other). rel_path is relative to output/
-- with forward slashes, in the on-disk-canonical casing resolveOutputPath() returns.
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ic_job_documents (
  id serial PRIMARY KEY,
  listing_id int NOT NULL REFERENCES ic_job_listings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('resume', 'coverletter', 'cheatsheet', 'markdown', 'research', 'report', 'other')),
  rel_path text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (actor IN ('dashboard', 'mcp', 'cli', 'migration', 'seed')),
  UNIQUE (listing_id, rel_path)
);

CREATE INDEX IF NOT EXISTS ic_job_documents_listing_idx ON ic_job_documents (listing_id);

-- ---------------------------------------------------------------------------------------------------
-- Widen ic_scan_runs.trigger to accept 'dashboard' alongside the existing 'mcp'/'cli'. The original
-- CHECK from sql/003 was an unnamed column constraint (Postgres auto-names it); rather than assume that
-- generated name, find and drop whatever CHECK constraint currently covers the trigger column and
-- replace it with a fixed, known name -- so a second run of this file (which finds the fixed name
-- already present) does nothing.
-- ---------------------------------------------------------------------------------------------------

DO $$
DECLARE
  dropsql text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'ic_scan_runs' AND c.conname = 'ic_scan_runs_trigger_dashboard_check'
  ) THEN
    SELECT string_agg(format('ALTER TABLE ic_scan_runs DROP CONSTRAINT %I', c.conname), '; ')
      INTO dropsql
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'ic_scan_runs' AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%trigger%';
    IF dropsql IS NOT NULL THEN
      EXECUTE dropsql;
    END IF;
    ALTER TABLE ic_scan_runs ADD CONSTRAINT ic_scan_runs_trigger_dashboard_check CHECK (trigger IN ('mcp', 'cli', 'dashboard'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- Legacy 'active' status remap (plan: "Remap active -> applied with audit events"). A 'migrated' event
-- is written for every row still carrying the legacy value BEFORE it is flipped, so the audit trail
-- survives the flip; the note text is the idempotence guard (a re-run finds the event already present
-- for every row still at 'active', and finds no rows left at 'active' at all once this has run once).
-- ---------------------------------------------------------------------------------------------------

INSERT INTO ic_job_events (listing_id, kind, from_status, to_status, note, actor)
SELECT id, 'migrated', status, 'applied', 'legacy active remapped to applied by migration 009', 'migration'
FROM ic_job_listings
WHERE status = 'active'
  AND coalesce(record_kind, 'listing') = 'listing'
  AND NOT EXISTS (
    SELECT 1 FROM ic_job_events e
    WHERE e.listing_id = ic_job_listings.id AND e.kind = 'migrated' AND e.note = 'legacy active remapped to applied by migration 009'
  );

UPDATE ic_job_listings SET status = 'applied' WHERE status = 'active' AND coalesce(record_kind, 'listing') = 'listing';

-- ---------------------------------------------------------------------------------------------------
-- Backfill one 'status' event per row that was ever explicitly marked (marked_at IS NOT NULL, set by
-- sql/007's mark_meta) but predates the event log, so its current status is not invisible in the
-- history timeline. Guarded by the same note-text pattern: a re-run finds every marked_at row already
-- has this exact backfill event and inserts nothing further.
-- ---------------------------------------------------------------------------------------------------

INSERT INTO ic_job_events (listing_id, kind, from_status, to_status, note, actor, at)
SELECT id, 'status', NULL, status, 'backfilled from marked_at by migration 009', 'migration', marked_at
FROM ic_job_listings
WHERE marked_at IS NOT NULL
  AND coalesce(record_kind, 'listing') = 'listing'
  AND NOT EXISTS (
    SELECT 1 FROM ic_job_events e
    WHERE e.listing_id = ic_job_listings.id AND e.kind = 'status' AND e.note = 'backfilled from marked_at by migration 009'
  );

COMMIT;
