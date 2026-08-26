-- Unique partial indexes (spec 2.1). Applied by migrate.js ONLY when the
-- review queue holds no open legacy_url_conflict / legacy_ext_conflict rows.
-- Never run this file by hand while conflicts are open: it will fail on the
-- duplicate keys and leave the operator without the queue context.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ic_job_listings_source_ext_uniq
  ON ic_job_listings (source, external_id)
  WHERE external_id IS NOT NULL AND duplicate_of IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ic_job_listings_url_norm_uniq
  ON ic_job_listings (url_normalized)
  WHERE url_normalized IS NOT NULL AND duplicate_of IS NULL;

COMMIT;
