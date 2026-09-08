-- 012: apply pipeline schema and state machine, slice 1 (plan `let-s-brainstorm-a-bit-humble-umbrella.md`
-- section "1. Application concept", amended by the slice-1 spec-adversary pass). Two new tables plus a
-- further widen of ic_job_events. 011 already claimed the "triage_actor" name and the auto-actor widen,
-- so this file is 012, not 011 as the original plan text suggested.
--
-- ic_job_applications: one row per application attempt on a listing. A partial UNIQUE index on
-- listing_id (WHERE state <> 'withdrawn') is the uniqueness rule, not a plain UNIQUE column: a withdrawn
-- application must never block a fresh re-apply row for the same listing, and the withdrawn row's own
-- audit trail (ic_job_application_events) must survive untouched rather than being deleted or reused.
--
-- ic_job_application_events: one row per state transition (plus note/error/progress rows a later slice
-- will add) on an application, mirroring ic_job_events' shape for listings but scoped to applications and
-- carrying from_state/to_state instead of from_status/to_status.
--
-- Both tables' state/kind/ats_type columns are closed vocabularies enforced by named CHECK constraints
-- (not by the application layer alone) so a bad value can never reach the database even from a caller
-- that skips src/core/applications.js's own validation.
--
-- This file is pure idempotent DDL (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and the
-- named-constraint drop/replace pattern sql/009 and sql/011 already established for widening a CHECK on
-- a pre-existing table) and carries no data backfill, so -- like sql/011_triage_actor.sql -- it is safe to
-- run on every server/dashboard startup as well as from a deliberate `node bin/migrate.js apply`.
-- Registered in all three migration lists per sql/011's own precedent (bin/migrate.js MIGRATIONS,
-- src/core/schema.js AUX_MIGRATIONS, bin/bootstrap-test-db.js MIGRATIONS).

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- ic_job_applications
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ic_job_applications (
  id serial PRIMARY KEY,
  listing_id int NOT NULL REFERENCES ic_job_listings(id) ON DELETE CASCADE,
  ats_type text NOT NULL DEFAULT 'unknown'
    CONSTRAINT ic_job_applications_ats_type_check
    CHECK (ats_type IN ('greenhouse', 'lever', 'workday', 'dayforce', 'indeed_easy', 'linkedin_easy', 'icims', 'smartrecruiters', 'unknown')),
  apply_url text,
  account_email text NOT NULL DEFAULT 'djwmobley@gmail.com',
  state text NOT NULL DEFAULT 'drafting'
    CONSTRAINT ic_job_applications_state_check
    CHECK (state IN ('drafting', 'docs_ready', 'approved', 'submitting', 'submitted', 'confirmed', 'failed', 'needs_human', 'withdrawn')),
  resume_doc_id int REFERENCES ic_job_documents(id) ON DELETE SET NULL,
  coverletter_doc_id int REFERENCES ic_job_documents(id) ON DELETE SET NULL,
  resume_hash text,
  coverletter_hash text,
  -- Shape documented in src/core/applications.js, not enforced by a CHECK in this slice:
  -- { [canonical_key]: { value, source: 'bank'|'human', answered_at } }
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_question jsonb,
  screenshot_rel_path text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  -- Populated at Approve by a later slice (dashboard PR slice list item 3+); the column ships now so the
  -- state machine and its tests have somewhere to eventually store the DOCX hash comparison timestamp.
  approved_at timestamptz,
  confirmation_ref text,
  error text,
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Partial uniqueness: at most one non-withdrawn application per listing. A withdrawn row stays in the
-- table (its ic_job_application_events audit trail intact) and simply stops counting toward this index,
-- so createApplication can insert a fresh row for the same listing after a withdrawal.
CREATE UNIQUE INDEX IF NOT EXISTS ic_job_applications_listing_active_uq ON ic_job_applications (listing_id) WHERE state <> 'withdrawn';
CREATE INDEX IF NOT EXISTS ic_job_applications_listing_idx ON ic_job_applications (listing_id);
CREATE INDEX IF NOT EXISTS ic_job_applications_state_idx ON ic_job_applications (state);

-- ---------------------------------------------------------------------------------------------------
-- ic_job_application_events
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ic_job_application_events (
  id bigserial PRIMARY KEY,
  application_id bigint NOT NULL REFERENCES ic_job_applications(id) ON DELETE CASCADE,
  kind text NOT NULL
    CONSTRAINT ic_job_application_events_kind_check
    CHECK (kind IN ('state', 'note', 'error', 'progress')),
  from_state text,
  to_state text,
  -- Same actor vocabulary as the widened ic_job_events.actor below, including 'apply' (the apply-pipeline
  -- worker itself, distinct from 'auto', which is slice 3's deterministic/model triage).
  actor text NOT NULL
    CONSTRAINT ic_job_application_events_actor_check
    CHECK (actor IN ('dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto', 'apply')),
  note text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ic_job_application_events_application_id_idx ON ic_job_application_events (application_id);

-- ---------------------------------------------------------------------------------------------------
-- Widen ic_job_events.actor further: sql/011_triage_actor.sql's ic_job_events_actor_auto_check accepts
-- ('dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto'); this adds 'apply' for the apply-pipeline
-- worker (src/core/applications.js's markSubmitted/reconcileStale, and any future caller that records an
-- ic_job_events row -- e.g. a document link -- as a side effect of an application state change). Via
-- ic_ensure_widened_check(), the shared helper defined in sql/009_pipeline_events_documents.sql -- see
-- the comment there for why this is a DEFINITION comparison, not a name-keyed guard. This file never
-- references a later migration's constraint name either; it only asserts the target set this migration
-- itself needs, and the helper finds and drops whatever CHECK currently covers the column if (and only
-- if) it does not already cover that set.
-- ---------------------------------------------------------------------------------------------------

DO $$
BEGIN
  PERFORM ic_ensure_widened_check('ic_job_events', 'actor', 'ic_job_events_actor_apply_check', ARRAY['dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto', 'apply']);
END $$;

-- ---------------------------------------------------------------------------------------------------
-- Widen ic_job_events.kind: sql/009_pipeline_events_documents.sql's original CHECK accepts ('status',
-- 'note', 'fit', 'created', 'document', 'followup', 'reply', 'migrated'); this adds 'application' for a
-- listing-level event that a future slice writes as a side effect of an application-level change (e.g.
-- surfacing "application submitted" on the listing's own timeline). Via ic_ensure_widened_check(), same
-- as the actor widen above.
-- ---------------------------------------------------------------------------------------------------

DO $$
BEGIN
  PERFORM ic_ensure_widened_check('ic_job_events', 'kind', 'ic_job_events_kind_application_check', ARRAY['status', 'note', 'fit', 'created', 'document', 'followup', 'reply', 'migrated', 'application']);
END $$;

COMMIT;
