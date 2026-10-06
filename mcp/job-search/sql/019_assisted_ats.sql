-- 019: assisted apply per ATS (assisted Workday, spec v1 clause 9, v2 A13). 018 built the assisted machinery
-- for LinkedIn Easy Apply only: a singleton circuit breaker (id = 1), leases with no ATS, and one in-flight
-- slot for linkedin_easy. Workday now runs through the same machinery, so:
--
-- ic_easy_apply_breaker: keyed per ATS. The existing row (whatever its id) is backfilled to
-- 'linkedin_easy' with its tripped_until untouched, so a LinkedIn breaker tripped before this migration
-- stays tripped. The singleton CHECK is dropped, id gets a sequence default for new rows, and ats is
-- NOT NULL, unique, and limited to the assisted ATS vocabulary.
--
-- ic_easy_apply_leases: every lease names its ATS. Existing rows are LinkedIn's (backfill 'linkedin_easy');
-- ats is then NOT NULL with the same closed vocabulary and no default, so a caller that forgets it fails
-- loudly instead of being filed under the wrong ATS.
--
-- ic_job_applications_assisted_inflight_uq: one in-flight slot PER ATS for the assisted ATS types (one
-- 'submitting' or awaiting_submit row per ats_type). 018's linkedin-only index stays in place as a
-- redundant backstop for the same LinkedIn slot (018 re-runs on every startup and would recreate it).
--
-- Pure idempotent DDL plus idempotent backfills, safe on every startup. Registered in bin/migrate.js
-- MIGRATIONS, src/core/schema.js AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS.

BEGIN;

-- Breaker: per-ATS key.
ALTER TABLE ic_easy_apply_breaker ADD COLUMN IF NOT EXISTS ats text;
UPDATE ic_easy_apply_breaker SET ats = 'linkedin_easy' WHERE ats IS NULL;
ALTER TABLE ic_easy_apply_breaker DROP CONSTRAINT IF EXISTS ic_easy_apply_breaker_singleton;
ALTER TABLE ic_easy_apply_breaker ALTER COLUMN ats SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ic_easy_apply_breaker_ats_uq ON ic_easy_apply_breaker (ats);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_easy_apply_breaker_ats_check' AND conrelid = 'ic_easy_apply_breaker'::regclass) THEN
    ALTER TABLE ic_easy_apply_breaker ADD CONSTRAINT ic_easy_apply_breaker_ats_check CHECK (ats IN ('linkedin_easy', 'workday'));
  END IF;
END $$;
CREATE SEQUENCE IF NOT EXISTS ic_easy_apply_breaker_id_seq OWNED BY ic_easy_apply_breaker.id;
SELECT setval('ic_easy_apply_breaker_id_seq', GREATEST(coalesce((SELECT max(id) FROM ic_easy_apply_breaker), 1), 1));
ALTER TABLE ic_easy_apply_breaker ALTER COLUMN id SET DEFAULT nextval('ic_easy_apply_breaker_id_seq');

-- Leases: every lease names its ATS.
ALTER TABLE ic_easy_apply_leases ADD COLUMN IF NOT EXISTS ats text;
UPDATE ic_easy_apply_leases SET ats = 'linkedin_easy' WHERE ats IS NULL;
ALTER TABLE ic_easy_apply_leases ALTER COLUMN ats SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_easy_apply_leases_ats_check' AND conrelid = 'ic_easy_apply_leases'::regclass) THEN
    ALTER TABLE ic_easy_apply_leases ADD CONSTRAINT ic_easy_apply_leases_ats_check CHECK (ats IN ('linkedin_easy', 'workday'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ic_easy_apply_leases_ats_issued_idx ON ic_easy_apply_leases (ats, issued_at);

-- In-flight: one slot per assisted ATS.
CREATE UNIQUE INDEX IF NOT EXISTS ic_job_applications_assisted_inflight_uq
  ON ic_job_applications (ats_type)
  WHERE ats_type IN ('linkedin_easy', 'workday')
    AND (state = 'submitting' OR (state = 'needs_human' AND pending_question->>'kind' = 'awaiting_submit'));

COMMIT;
