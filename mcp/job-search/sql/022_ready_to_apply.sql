-- 022: Ready to apply list (spec-ready-to-apply-v1, resolutions R1-R8, amendments A1-A10).
--
-- ic_job_listings.manual_apply_* (R1): the decoded external apply href that did NOT resolve to an exact ATS
-- target. Never read by any submit path; apply_url keeps its meaning ("the resolved ATS target").
--
-- ic_job_listings.apply_page_*: the last LinkedIn page classification (src/apply/linkedin-apply-state.js
-- LINKEDIN_APPLY_BRANCHES) and how many consecutive observations returned the same (branch, reason) pair.
--
-- ic_ready_to_apply: one row per listing the Ready list has tracked (ready, held, or on the auto-submit
-- path). A cache plus ledger, never the source of truth: the bucket is recomputed live on every read.
-- Carries the listing-level resume state and the advisory review verdict (R4).
--
-- ic_manual_only_locks (R8, A1, A2): written the first time a listing is DISPLAYED in a listed bucket.
-- An active lock (released_at IS NULL) keeps the listing, and any listing matching its company/title,
-- normalized target URL, or dedup root, out of unattended submit and the assisted Easy Apply path until
-- Damian hands it back on the dashboard (released_at set, the release logged as a listing event).
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-021 precedent.

BEGIN;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS manual_apply_url text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS manual_apply_host text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS manual_apply_origin text
  CHECK (manual_apply_origin IS NULL OR manual_apply_origin IN ('linkedin_href', 'linkedin_click', 'detail_external', 'redirect_final'));
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS manual_apply_seen_at timestamptz;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_page_branch text
  CHECK (apply_page_branch IS NULL OR apply_page_branch IN ('load_failure', 'challenge', 'auth_wall', 'closed', 'already_applied', 'easy_apply', 'external', 'no_control', 'unknown'));
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_page_reason text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_page_first_seen_at timestamptz;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_page_repeat integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ic_ready_to_apply (
  listing_id int PRIMARY KEY REFERENCES ic_job_listings(id) ON DELETE CASCADE,
  bucket text NOT NULL CHECK (bucket ~ '^(auto_submit_path|ready_to_apply|held_[a-z_]+|excluded_[a-z_]+)$'),
  reason text,
  channel text CHECK (channel IS NULL OR channel IN ('linkedin_easy', 'linkedin_page', 'indeed_easy', 'indeed_page', 'external_manual', 'ats_manual', 'ats_inferred', 'ats_exact', 'listing_page', 'easy_other')),
  first_listed_at timestamptz,
  first_displayed_at timestamptz,
  auto_path_since timestamptz,
  last_classified_at timestamptz NOT NULL,
  left_at timestamptz,
  resume_status text NOT NULL DEFAULT 'none'
    CHECK (resume_status IN ('none', 'queued', 'running', 'ready', 'failed', 'gave_up', 'skipped_no_description')),
  resume_doc_id int REFERENCES ic_job_documents(id) ON DELETE SET NULL,
  resume_source text CHECK (resume_source IS NULL OR resume_source IN ('generated', 'reused')),
  resume_attempts int NOT NULL DEFAULT 0,
  resume_last_error text,
  resume_last_attempt_at timestamptz,
  resume_run_id text,
  review_verdict text CHECK (review_verdict IS NULL OR review_verdict IN ('PASS', 'FAIL')),
  review_findings jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ic_ready_to_apply_bucket_idx ON ic_ready_to_apply (bucket);
CREATE INDEX IF NOT EXISTS ic_ready_to_apply_resume_status_idx ON ic_ready_to_apply (resume_status);

CREATE TABLE IF NOT EXISTS ic_manual_only_locks (
  id serial PRIMARY KEY,
  listing_id int NOT NULL REFERENCES ic_job_listings(id) ON DELETE CASCADE,
  root_listing_id int NOT NULL,
  company_norm text,
  title_norm text,
  location_norm text,
  placeholder boolean NOT NULL DEFAULT false,
  url_keys text[] NOT NULL DEFAULT '{}',
  bucket text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by text,
  release_note text
);
CREATE UNIQUE INDEX IF NOT EXISTS ic_manual_only_locks_active_listing_idx ON ic_manual_only_locks (listing_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ic_manual_only_locks_listing_idx ON ic_manual_only_locks (listing_id);

COMMIT;
