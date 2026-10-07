-- 021: fit basis and the triage model-failure counter (unblock-auto-apply A2, A9).
--
-- ic_job_listings.fit_basis: what a MODEL fit_score was computed from. 'description' when the listing had a
-- non-empty description at scoring time, 'no_description' when it did not (title/company/location/salary
-- only). src/core/auto-apply-select.js treats a 'no_description' fit as unverified (reason fit_unverified)
-- until a description exists and a description-based rescore (src/core/triage.js) replaced it. NULL means
-- the fit was set some other way (a human, or a row scored before this column existed with a description).
--
-- ic_job_listings.triage_model_failures: how many times this row was sent to the model and came back
-- unscored (a failed batch, or the model omitted it). The backlog sweep skips a row at 2 or more, so one
-- poison row cannot keep a batch slot forever.
--
-- Backfill: a row whose LATEST fit event came from the model (actor 'auto') while its description is
-- empty today was certainly scored without one, so it is tagged 'no_description' (this is what lets the
-- detail fit sweep plus the rescore pick it up). Rows with a description, human fits, and unscored rows
-- are left NULL. Only rows still NULL are touched, so re-running this file is a no-op.
--
-- Pure idempotent DDL plus an idempotent backfill, safe on every startup. Registered in bin/migrate.js
-- MIGRATIONS, src/core/schema.js AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the
-- sql/011-020 precedent.

--
-- ic_gmail_targets (Gmail intake addendum G3, B1, B2): where a gmail-sourced listing's tracker link really
-- leads, kept OUT of ic_job_listings so a listing's own external_id/url_normalized are never overwritten
-- (B1). One row per gmail listing; the resolution is cached by the original tracker URL, so a later run (or a
-- re-ingest of the same email) never unwraps the same link again. `outcome` is the last description-phase
-- outcome for the listing (resolve branch or fetch result); the report's manual-apply list (B2) reads it.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_gmail_targets (
  listing_id int PRIMARY KEY REFERENCES ic_job_listings(id) ON DELETE CASCADE,
  original_url text,
  final_url text,
  canonical_external_id text,
  branch text NOT NULL,
  outcome text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ic_gmail_targets_original_url_idx ON ic_gmail_targets (original_url);

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS fit_basis text
  CHECK (fit_basis IS NULL OR fit_basis IN ('description', 'no_description'));
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS triage_model_failures integer NOT NULL DEFAULT 0;

UPDATE ic_job_listings l
   SET fit_basis = 'no_description'
 WHERE l.fit_basis IS NULL
   AND l.fit_score IS NOT NULL
   AND (l.description IS NULL OR btrim(l.description) = '')
   AND (SELECT e.actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'fit' ORDER BY e.at DESC, e.id DESC LIMIT 1) = 'auto';

COMMIT;
