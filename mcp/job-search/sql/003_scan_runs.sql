-- 003: scan runs and per-run items (spec 2.3).

BEGIN;

CREATE TABLE IF NOT EXISTS ic_scan_runs (
  id serial PRIMARY KEY,
  profile text NOT NULL,
  profile_rev text,
  trigger text NOT NULL CHECK (trigger IN ('mcp', 'cli')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed', 'locked')) DEFAULT 'running',
  dry_run boolean NOT NULL DEFAULT false,
  config_hash text,
  pages_by_source jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS ic_scan_runs_status_started_idx ON ic_scan_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS ic_scan_run_items (
  run_id int NOT NULL REFERENCES ic_scan_runs(id) ON DELETE CASCADE,
  listing_id int NOT NULL REFERENCES ic_job_listings(id),
  source text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('new', 'update', 'cross_source_dup', 'repost', 'ambiguous')),
  page_index int,
  PRIMARY KEY (run_id, listing_id, source)
);

CREATE INDEX IF NOT EXISTS ic_scan_run_items_listing_idx ON ic_scan_run_items (listing_id);

COMMIT;
