-- 015: auto-apply target resolution columns on ic_job_listings (PR B, docs/auto-apply-spec.md).
--
-- A scanned listing's own URL is frequently NOT the real ATS apply page (LinkedIn, Indeed, an aggregator,
-- or an exec board landing page all commonly point somewhere else before a candidate ever reaches
-- Greenhouse/Lever/Workday/etc). These columns record what auto-apply's "prepare" phase discovered when
-- it tried to resolve the REAL apply target for a listing, so "select" can filter to listings whose apply
-- target is exact and automatable without re-deriving that on every run.
--
-- apply_url: the resolved, final apply-page URL (after redirect-chasing/decoding), or NULL when
--   unresolved.
-- apply_ats: the ATS classifyApplyUrl() assigned to apply_url (one of applications.js's ATS_TYPES), or
--   NULL when unresolved.
-- apply_ats_confidence: classifyApplyUrl()'s own confidence tier ('exact'|'inferred'|'low'), or NULL.
-- apply_ats_hint: a same-tab query-param hint captured from a button-only Apply click (e.g.
--   applicantTrackingSystemName/companyName) -- diagnostic only. A hint NEVER counts as a resolved apply
--   target on its own: it exists so a human (or a future probe) has a lead, never as a substitute for
--   apply_url/apply_ats/apply_ats_confidence being set from a real, followed URL.
-- apply_easy_only: true when the listing's own apply flow is an in-page "Easy Apply" with no external
--   apply URL to resolve at all (LinkedIn/Indeed Easy Apply, or any button-only apply that never
--   navigates) -- select's own closed reason enum reports these as 'easy_apply_only', never silently
--   treated as unresolved.
-- apply_probed_at: when the prepare phase last attempted resolution for this listing (whether or not it
--   succeeded) -- drives the 48-hour re-probe cooldown (auto-apply.json's reprobeAfterHours).
-- probe_attempts: lifetime count of resolution attempts for this listing, capped (auto-apply.json's
--   implicit lifetime cap of 3 enforced in code, not a CHECK constraint here -- mirrors every other
--   application-layer cap in this codebase, e.g. src/core/applications.js's `attempt` column). Defaults to
--   0, never NULL, so `probe_attempts + 1` and comparisons against the cap never need a coalesce.
--
-- Pure idempotent DDL (ADD COLUMN IF NOT EXISTS), no data backfill -- same "safe to run on every server/
-- worker startup" convention sql/011-014 established. Registered in all three migration lists per that
-- precedent (bin/migrate.js MIGRATIONS, src/core/schema.js AUX_MIGRATIONS, bin/bootstrap-test-db.js
-- MIGRATIONS).

BEGIN;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_url text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_ats text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_ats_confidence text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_ats_hint jsonb;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_easy_only boolean;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS apply_probed_at timestamptz;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS probe_attempts integer NOT NULL DEFAULT 0;

COMMIT;
