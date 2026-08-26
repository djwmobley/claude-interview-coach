-- 002: search profiles (spec 2.3). The exec-default seed is inserted by
-- migrate.js (values come from the operator profile, not from a checked-in file).

BEGIN;

CREATE TABLE IF NOT EXISTS ic_search_profiles (
  name text PRIMARY KEY,
  keywords text[] NOT NULL DEFAULT '{}',
  phrases text[] NOT NULL DEFAULT '{}',
  exclude_terms text[] NOT NULL DEFAULT '{}',
  locations text[] NOT NULL DEFAULT '{}',
  remote text NOT NULL DEFAULT 'any',
  posted_within_days int NOT NULL DEFAULT 7,
  max_pages int NOT NULL DEFAULT 3,
  sources text[] NOT NULL DEFAULT '{}',
  rev text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
