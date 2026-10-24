-- 031: Recruiter-mail listing field provenance (2026-10-24).
--
-- A reply in a recruiter thread re-extracts the listing's title and company. Those two fields are only overwritten
-- while they still hold the value the scorer itself last wrote; a human edit (dashboard, MCP or direct SQL) makes
-- the stored value differ and the field is then left alone. ic_job_listings.mail_auto_fields records the value the
-- scorer last set, e.g. {"title": "Chief Information Officer", "company": "Acme"}. NULL (every pre-existing row,
-- every non-mail listing) means no provenance: nothing is overwritten.
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-030 precedent.

BEGIN;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS mail_auto_fields jsonb;

COMMIT;
