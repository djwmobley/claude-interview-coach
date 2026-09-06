-- 017: total classification of a listing's detail-fetch outcome (scan-detail-pass fix,
-- docs/scan-run-detail-pass-spec.md item 2), replacing the boolean detail_skipped that used to be the
-- only signal threaded through finalizeListing.
--
-- detail_outcome: one of 'fetched'|'empty'|'error'|'skipped_budget'|'skipped_gate'|'skipped_cancelled'|
--   'not_queued', or NULL for a listing scanned/adopted before this migration and never revisited since.
-- detail_attempts: count of failed/empty detail-fetch attempts (never incremented for a successful
--   'fetched' outcome, which resets it to 0); used by scan-run.js's retry-eligibility gate
--   (config's detailMaxAttempts, default 3) so a chronically-empty or -erroring listing eventually stops
--   being re-queued.
--
-- Backfill (this migration only, run once): a pre-existing row's detail_skipped=true becomes
-- detail_outcome='skipped_budget' (the only reason detail_skipped was ever set true before this
-- migration existed); a row with a stored description of at least 300 chars (scan-run.js's
-- DETAIL_MIN_CHARS, src/core/normalize.js) becomes detail_outcome='fetched'; everything else is left
-- NULL (no positively-known outcome) rather than guessed at. detail_attempts starts at 0 for every row;
-- it only exists to gate FUTURE retries, so there is nothing correct to backfill into it from a row's
-- past.
--
-- Pure, idempotent DDL plus a one-time backfill guarded by the column's own existence (ADD COLUMN IF NOT
-- EXISTS is a no-op on a second run, and the UPDATE below only ever touches rows still NULL, so re-running
-- this file is always safe). Registered in bin/migrate.js MIGRATIONS, src/core/schema.js AUX_MIGRATIONS,
-- and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-016 precedent.

BEGIN;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS detail_outcome text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS detail_attempts integer NOT NULL DEFAULT 0;

UPDATE ic_job_listings
   SET detail_outcome = CASE
     WHEN detail_skipped THEN 'skipped_budget'
     WHEN description IS NOT NULL AND length(description) >= 300 THEN 'fetched'
     ELSE NULL
   END
 WHERE detail_outcome IS NULL;

COMMIT;
