-- 004: review queue (spec 2.3). Invariant checked by migrate.js --check:
-- every ic_job_listings row with status='review' has exactly one open
-- (resolved_at IS NULL) queue row.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_job_review_queue (
  id serial PRIMARY KEY,
  run_id int REFERENCES ic_scan_runs(id) ON DELETE SET NULL,
  candidate jsonb,
  candidate_id int REFERENCES ic_job_listings(id),
  matches int[] NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  resolution text CHECK (resolution IS NULL OR resolution IN ('merge', 'separate', 'repost')),
  status_at_create text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS ic_job_review_queue_open_idx ON ic_job_review_queue (created_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS ic_job_review_queue_candidate_idx ON ic_job_review_queue (candidate_id);

COMMIT;
