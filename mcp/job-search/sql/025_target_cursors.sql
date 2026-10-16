-- 025: Target finder runner (plan: target-finder-2026-10-15, PR3, section 17).
--
-- ic_target_source_state.cursor_date: the last business day (ET) fully covered for an EDGAR source. The
-- cursor never passes the business day two before today. cursor_detail holds the hash of the source's
-- config (a mismatch resets the cursor), the suspicious_empty hold counter, backlog_days, and the last
-- hold reason. The existing watermark column stays the last-success marker.
--
-- ic_target_runs: trigger (cli | scan), heartbeat_at (the reaper marks a running row failed only when the
-- heartbeat, or started_at when there is none, is stale), coverage (per source and form), skip_reasons
-- (closed codes), backlog (backlog_days per source). The status CHECK is widened with skipped_locked: a
-- runner that loses the advisory lock writes a visible row instead of vanishing.
--
-- ic_target_signals: an expression index on (source, file_date) so the resume lookup (accessions already
-- stored with a read document) stays cheap.
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-024 precedent.

BEGIN;

ALTER TABLE ic_target_source_state ADD COLUMN IF NOT EXISTS cursor_date date;
ALTER TABLE ic_target_source_state ADD COLUMN IF NOT EXISTS cursor_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS trigger text;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS skip_reasons jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ic_target_runs ADD COLUMN IF NOT EXISTS backlog jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ic_target_runs DROP CONSTRAINT IF EXISTS ic_target_runs_status_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_target_runs_status_chk') THEN
    ALTER TABLE ic_target_runs ADD CONSTRAINT ic_target_runs_status_chk
      CHECK (status IN ('running', 'ok', 'failed', 'partial', 'skipped_locked'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ic_target_signals_file_date_idx ON ic_target_signals (source, (extracted->>'file_date'));

COMMIT;
