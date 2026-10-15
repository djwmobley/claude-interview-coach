-- 024: Target finder source adapters (plan: target-finder-2026-10-15, PR2, sections 14 and 15).
--
-- ic_targets.size_verified: true only when a size was known in band at medium or high confidence.
-- NULL means "not computed yet"; false means the size is unknown or low confidence and the target needs
-- the operator's eye on size (plan section 15.1, Damian decision 2026-10-15).
--
-- ic_target_signals: the parse outcome of the raw item, kept as columns beside extracted so the
-- unparseable / out_of_scope backlog is queryable (extracted still carries the same values per section
-- 14.2). content_hash is the hash of the parsed content, used by the upsert to decide whether to rewrite
-- extracted and excerpt on a re-seen item. signal and contact keep the classifier input (and the contact
-- beside it) so every stored signal can be re-classified each run even when its source no longer returns it
-- (the stale window, the blocklist, and the rules all move).
--
-- ic_target_runs: per-run item counts (every raw item has exactly one outcome) and the per-source stats
-- document (discovery_total vs read, message and row cap counts, truncation flags, reasons, warnings).
--
-- ic_target_source_state: the last-success watermark per source. A source that has been silent or
-- failing for days is visible here instead of looking like "no triggers".
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-023 precedent.

BEGIN;

ALTER TABLE ic_targets ADD COLUMN IF NOT EXISTS size_verified boolean;

ALTER TABLE ic_target_signals ADD COLUMN IF NOT EXISTS parse_outcome text;
ALTER TABLE ic_target_signals ADD COLUMN IF NOT EXISTS parse_reason text;
ALTER TABLE ic_target_signals ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE ic_target_signals ADD COLUMN IF NOT EXISTS signal jsonb;
ALTER TABLE ic_target_signals ADD COLUMN IF NOT EXISTS contact jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_target_signals_parse_outcome_chk') THEN
    ALTER TABLE ic_target_signals ADD CONSTRAINT ic_target_signals_parse_outcome_chk
      CHECK (parse_outcome IS NULL OR parse_outcome IN ('parsed', 'unparseable', 'out_of_scope'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ic_target_signals_outcome_idx ON ic_target_signals (parse_outcome);

ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS items_raw int NOT NULL DEFAULT 0;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS items_parsed int NOT NULL DEFAULT 0;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS items_unparseable int NOT NULL DEFAULT 0;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS items_out_of_scope int NOT NULL DEFAULT 0;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS source_stats jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ic_target_source_state (
  source text PRIMARY KEY,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_status text,
  watermark text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
