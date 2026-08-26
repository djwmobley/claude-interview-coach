-- 007: explicit-mark metadata for mark_jobs propagation rules (spec section 5).
-- marked_at records the last explicit human mark on a row. Propagation never
-- overwrites a descendant with marked_at set and a different status without
-- routing it to review. Idempotent; applied by src/core/schema.js at server
-- start and should be added to bin/migrate.js MIGRATIONS.

BEGIN;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS marked_at timestamptz;

COMMIT;
