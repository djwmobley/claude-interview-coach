-- 009: pipeline event log, linked documents, dashboard scan trigger, and the legacy 'active' status
-- remap (dashboard PR 1, plan section "Data model changes" plus pr1-spec-decisions.md). Idempotent:
-- every statement is safe to run twice, including the legacy 'active' remap near the bottom, which is
-- guarded by a NOT EXISTS check keyed on a fixed note string rather than a one-time flag, so a second
-- `node bin/migrate.js` run (or the test-db bootstrap's own re-apply-for-idempotence pass) adds nothing.
--
-- This file is safe to run on EVERY server/dashboard startup (src/core/startup.js's ensureAuxSchema()
-- does exactly that) because every statement here, including the legacy 'active' remap, is either pure
-- schema DDL or self-limiting against a fixed legacy value that a healthy row can never carry going
-- forward. The marked_at status-event backfill that originally lived at the bottom of this file was NOT
-- self-limiting that way -- see sql/010_status_event_backfill.sql, split out for exactly that reason
-- (defect 7 fix): it must only ever run from a deliberate `node bin/migrate.js apply`, never from
-- ensureAuxSchema, so it never fires again on every ordinary dashboard/MCP startup against rows that were
-- created (and legitimately marked) long after this migration first applied.

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
-- ic_ensure_widened_check(table, column, constraint_name, allowed_values): shared helper. This table/
-- column-widen site plus sql/011_triage_actor.sql and both widen sites in sql/012_applications.sql used
-- to each carry their own copy of a name-keyed guard ("does a constraint named X already exist? if not,
-- drop whatever CHECK currently covers the column and install X"). That pattern broke on 2026-09-06: a
-- server start runs sql/009, then sql/011, then sql/012 in that fixed order every time (schema.js's
-- AUX_MIGRATIONS), so once sql/012 had ever widened ic_job_events.actor to include 'apply', a LATER
-- server start still ran sql/011's guard, which only checks for its OWN constraint name
-- (ic_job_events_actor_auto_check) -- found the wider ic_job_events_actor_apply_check installed under a
-- different name, decided nothing covered it yet, dropped that wider constraint, and reinstalled its own
-- narrower one that does not include 'apply'. Live data with actor = 'apply' already existed, so the
-- ADD CONSTRAINT itself failed on the check violation, and the resulting aborted-transaction connection
-- was returned to the pool unrolled-back (see src/core/db.js's withClient fix in this same change).
--
-- This helper replaces every one of those name-keyed guards with a DEFINITION comparison: it finds
-- whatever CHECK constraint(s) currently sit on the target column (found by conkey/pg_attribute, never
-- by name -- so no migration here has to know a later migration's constraint name) and parses each
-- one's allowed value set out of pg_get_constraintdef(). If any existing constraint's set is already a
-- superset of the set this call asks for, the column is already wide enough for this migration's needs
-- and it does nothing at all -- so sql/011 running after sql/012 has already widened the column is a
-- true no-op, not a narrowing regression. Total classification of what it finds on the column: no CHECK
-- constraint at all -> install this one; an existing CHECK whose value set already covers the target ->
-- no-op; anything else, including a CHECK whose definition this helper cannot parse into a value list
-- (treated as NOT covering, never silently trusted, RAISE NOTICE so it is visible) -> drop every CHECK
-- currently on the column and install this one.
--
-- Defined with CREATE OR REPLACE (Postgres has no CREATE FUNCTION IF NOT EXISTS) so re-running this file
-- just redefines the same body -- safe on every server/dashboard startup like the rest of this file.
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ic_ensure_widened_check(
  p_table text,
  p_column text,
  p_constraint_name text,
  p_allowed_values text[]
) RETURNS void
LANGUAGE plpgsql AS $ic_ensure_widened_check$
DECLARE
  con record;
  found_values text[];
  covers boolean;
  drop_list text;
BEGIN
  FOR con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = p_table AND c.contype = 'c' AND a.attname = p_column
  LOOP
    found_values := NULL;
    BEGIN
      SELECT array_agg(m[1]) INTO found_values
      FROM regexp_matches(con.def, $rx$'([^']*)'::text$rx$, 'g') AS m;
    EXCEPTION WHEN OTHERS THEN
      found_values := NULL;
    END;

    IF found_values IS NULL OR array_length(found_values, 1) IS NULL THEN
      RAISE NOTICE 'ic_ensure_widened_check: constraint % on %.% has an unparsable definition (%); treating as not covering', con.conname, p_table, p_column, con.def;
      covers := false;
    ELSE
      SELECT bool_and(v = ANY (found_values)) INTO covers FROM unnest(p_allowed_values) AS v;
      covers := coalesce(covers, true);
    END IF;

    IF covers THEN
      RETURN;
    END IF;
  END LOOP;

  SELECT string_agg(format('ALTER TABLE %I DROP CONSTRAINT %I', p_table, c.conname), '; ')
    INTO drop_list
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = p_table AND c.contype = 'c' AND a.attname = p_column;
  IF drop_list IS NOT NULL THEN
    EXECUTE drop_list;
  END IF;

  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IN (%s))',
    p_table, p_constraint_name, p_column,
    (SELECT string_agg(quote_literal(v), ', ') FROM unnest(p_allowed_values) AS v)
  );
END;
$ic_ensure_widened_check$;

-- ---------------------------------------------------------------------------------------------------
-- Widen ic_scan_runs.trigger to accept 'dashboard' alongside the existing 'mcp'/'cli', via the shared
-- helper above -- a second run of this file (which finds the target set already covered) does nothing.
-- ---------------------------------------------------------------------------------------------------

DO $$
BEGIN
  PERFORM ic_ensure_widened_check('ic_scan_runs', 'trigger', 'ic_scan_runs_trigger_dashboard_check', ARRAY['mcp', 'cli', 'dashboard']);
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

COMMIT;
