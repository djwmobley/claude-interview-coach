-- 008: noise classification columns, detail-skipped flag, and the daily report marker
-- (spec R1, R2, R4). Idempotent, same conventions as 001-007.

BEGIN;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS noise_class text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS prescore_raw int;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS detail_skipped boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ic_job_listings_noise_class_idx ON ic_job_listings (noise_class);

-- Singleton table (spec R1.1): a persisted "previous report sent" marker so a re-run the same day does
-- not duplicate the email and a missed day is covered next time. The boolean-true primary key is the
-- standard Postgres one-row-table trick; a CHECK on the same column blocks a second row outright.
CREATE TABLE IF NOT EXISTS ic_report_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_report_sent_at timestamptz,
  last_run_id_included int
);
INSERT INTO ic_report_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMIT;
