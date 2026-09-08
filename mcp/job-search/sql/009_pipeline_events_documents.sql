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
-- by name -- so no migration here has to know a later migration's constraint name) and, for each one,
-- FIRST checks that pg_get_constraintdef()'s text is one of a small set of canonical single-column
-- enumeration shapes -- exactly `<col> = ANY (ARRAY[...])`, its cast variant `(<col>)::<type> = ANY
-- ((ARRAY[...])::<type>[])`, the single-value form `<col> = 'v'::<type>`, or a literal `<col> IN (...)`
-- -- each anchored to the ENTIRE definition, with nothing else present: no OR, no AND, no NOT, no other
-- column, no function call. Only a constraint matching one of those shapes has its literal value set
-- extracted and compared; anything else (including a compound constraint like `actor IN (...) OR note =
-- 'apply'`, which DOES contain the literal 'apply' as text but does not actually make actor='apply'
-- valid on its own) is classified as NOT covering, with a RAISE NOTICE naming the constraint and the
-- reason, and is dropped and replaced -- shape recognition is closed, not "does this look like a fit":
-- an unrecognized shape is never assumed to cover, and there is no shape under which the widen is
-- silently skipped without either a matched-and-covering canonical constraint or a NOTICE.
--
-- Multiple CHECK constraints on one column are combined by Postgres via implicit AND (every one must
-- pass), so "already covers" requires EVERY existing CHECK on the column to be canonical AND a superset
-- of the target set -- not just the widest one found. Stopping at the first covering constraint (an
-- earlier revision of this helper) can miss a coexisting narrower constraint that would still reject
-- rows the caller believes are now accepted. Total classification of what it finds on the column: no
-- CHECK constraint at all -> install this one; every existing CHECK is canonical and covers the target ->
-- true no-op (so sql/011 running after sql/012 has already widened the column is a no-op, not a
-- narrowing regression); anything else (any one non-canonical, or any one canonical but narrower than the
-- target) -> drop EVERY CHECK currently on the column and install this one, with a RAISE NOTICE listing
-- every dropped constraint's name and the specific reason it did not cover.
--
-- Defined with CREATE OR REPLACE (Postgres has no CREATE FUNCTION IF NOT EXISTS) so re-running this file
-- just redefines the same body -- safe on every server/dashboard startup like the rest of this file.
--
-- Schema-qualified throughout (p_schema, default current_schema()): the constraint lookup joins
-- pg_namespace and filters n.nspname = p_schema, and the DROP/ADD CONSTRAINT statements target
-- format('%I.%I', p_schema, p_table), never a bare, schema-unqualified table name. Without this, a
-- second table sharing p_table's name in a different schema on the search path could be picked up by an
-- unqualified pg_class join, misreporting the actually-targeted table's own (possibly narrower)
-- constraint as covered by the other schema's wider one, or dropping/altering the wrong table entirely.
-- ---------------------------------------------------------------------------------------------------

-- CREATE OR REPLACE only replaces a function whose argument list matches exactly; adding p_schema below
-- changed the signature from 4 to 5 arguments, so a database that already ran an earlier revision of this
-- file (the 4-argument version, before schema-qualification was added) would otherwise end up with BOTH
-- overloads defined -- the 5-argument one's DEFAULT makes it callable with 4 arguments too, which is
-- ambiguous against the genuine 4-argument overload and breaks every call site with "not unique". Drop
-- that specific prior signature unconditionally (IF EXISTS: a no-op on a database that never had it) so
-- this file converges to exactly one overload regardless of which earlier revision last ran here.
DROP FUNCTION IF EXISTS ic_ensure_widened_check(text, text, text, text[]);

CREATE OR REPLACE FUNCTION ic_ensure_widened_check(
  p_table text,
  p_column text,
  p_constraint_name text,
  p_allowed_values text[],
  p_schema text DEFAULT current_schema()
) RETURNS void
LANGUAGE plpgsql AS $ic_ensure_widened_check$
DECLARE
  con record;
  found_values text[];
  covers boolean;
  drop_list text;
  seen_any boolean := false;
  all_cover boolean := true;
  bad_names text[] := '{}';
  bad_reasons text[] := '{}';
  qualified_table text := format('%I.%I', p_schema, p_table);
  col_ident text := quote_ident(p_column);
  -- A safe SQL identifier never itself contains a regex metacharacter, but this still neutralizes any
  -- that quote_ident's quoting could introduce (e.g. a column requiring double-quoting) before it is
  -- spliced into the patterns below, so the column name is always matched literally, never as regex syntax.
  col_pat text := regexp_replace(col_ident, '([.^$|()\[\]{}*+?\\])', '\\\1', 'g');
  -- A single quoted literal, e.g. 'apply' or a value containing an escaped '' apostrophe, cast to some
  -- type name (text, character varying, etc. -- letters/underscores/spaces only, matching what
  -- pg_get_constraintdef() ever emits for a cast type name).
  lit text := $p$'(?:[^']|'')*'::[a-z_ ]+$p$;
  -- Four canonical single-column enumeration shapes pg_get_constraintdef() emits for a plain
  -- `CHECK (<col> IN (...))` constraint (the only shape every migration in this file installs), each
  -- anchored to the WHOLE definition string so nothing else can be present in the expression.
  pat_any text;
  pat_any_cast text;
  pat_eq text;
  pat_in text;
BEGIN
  pat_any := format('^CHECK \(\(%s = ANY \(ARRAY\[(?:%s(?:, )?)+\]\)\)\)$', col_pat, lit);
  pat_any_cast := format('^CHECK \(\(\(%s\)::[a-z_ ]+ = ANY \(\(ARRAY\[(?:%s(?:, )?)+\]\)::[a-z_ ]+\[\]\)\)\)$', col_pat, lit);
  pat_eq := format('^CHECK \(\(%s = %s\)\)$', col_pat, lit);
  pat_in := format('^CHECK \(%s IN \((?:''(?:[^'']|'''''')*''(?:, )?)+\)\)$', col_pat);

  -- Multiple simultaneous CHECK constraints on one column are combined by Postgres via implicit AND
  -- (every one must pass for a row to be valid), so "does the column already accept the target set"
  -- requires EVERY existing CHECK on it to be a canonical single-column enumeration that is itself a
  -- superset of the target -- checking only the widest one and stopping there (the prior version's
  -- behavior) can miss a coexisting narrower constraint that would still reject rows the caller believes
  -- are now accepted. So this loop never returns early on a single covering constraint; it examines all
  -- of them, and only decides "no-op" once every one has been checked.
  FOR con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = p_table AND n.nspname = p_schema AND c.contype = 'c' AND a.attname = p_column
  LOOP
    seen_any := true;

    IF con.def !~ pat_any AND con.def !~ pat_any_cast AND con.def !~ pat_eq AND con.def !~ pat_in THEN
      all_cover := false;
      bad_names := array_append(bad_names, con.conname);
      bad_reasons := array_append(bad_reasons, format('%s: not a recognized single-column enumeration shape (def: %s)', con.conname, con.def));
      CONTINUE;
    END IF;

    found_values := NULL;
    BEGIN
      SELECT array_agg(m[1]) INTO found_values
      FROM regexp_matches(con.def, $rx$'((?:[^']|'')*)'::[a-z_ ]+$rx$, 'g') AS m;
    EXCEPTION WHEN OTHERS THEN
      found_values := NULL;
    END;

    IF found_values IS NULL OR array_length(found_values, 1) IS NULL THEN
      all_cover := false;
      bad_names := array_append(bad_names, con.conname);
      bad_reasons := array_append(bad_reasons, format('%s: matched a canonical shape but no literal values could be extracted (def: %s)', con.conname, con.def));
      CONTINUE;
    END IF;

    SELECT bool_and(v = ANY (found_values)) INTO covers FROM unnest(p_allowed_values) AS v;
    covers := coalesce(covers, true);
    IF NOT covers THEN
      all_cover := false;
      bad_names := array_append(bad_names, con.conname);
      bad_reasons := array_append(bad_reasons, format('%s: a recognized canonical shape, but its value set does not cover the target', con.conname));
    END IF;
  END LOOP;

  IF seen_any AND all_cover THEN
    RETURN; -- every existing CHECK on the column is canonical and covers the target: true no-op
  END IF;

  IF seen_any THEN
    RAISE NOTICE 'ic_ensure_widened_check: dropping ALL CHECK constraint(s) on %.% (%) and installing %: %', p_table, p_column, array_to_string(bad_names, ', '), p_constraint_name, array_to_string(bad_reasons, '; ');
  END IF;

  SELECT string_agg(format('ALTER TABLE %s DROP CONSTRAINT %I', qualified_table, c.conname), '; ')
    INTO drop_list
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = p_table AND n.nspname = p_schema AND c.contype = 'c' AND a.attname = p_column;
  IF drop_list IS NOT NULL THEN
    EXECUTE drop_list;
  END IF;

  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))',
    qualified_table, p_constraint_name, p_column,
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
