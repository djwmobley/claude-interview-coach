-- 001: extend the legacy ic_job_listings table (spec section 2.1).
-- Idempotent: one ADD COLUMN IF NOT EXISTS per column, CREATE INDEX IF NOT EXISTS.
-- Unique partial indexes are NOT here; migrate.js creates them from
-- sql/unique_indexes.sql only after the backfill reports zero conflicts.
-- Changing the tsv expression later requires DROP COLUMN + re-add
-- (IF NOT EXISTS keeps the old expression).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS record_kind text DEFAULT 'listing';
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS url_normalized text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS dedup_hash text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS company_norm text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS title_norm text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS location_norm text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS remote_mode text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS remote_declared boolean;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS salary_min int;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS salary_max int;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS salary_raw text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS posted_at date;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS first_seen timestamptz DEFAULT now();
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS last_seen timestamptz DEFAULT now();
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS times_seen int DEFAULT 1;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS absent_runs int DEFAULT 0;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS last_page_index int;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS profile_rev text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS description_hash text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS search_profile text;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS prescore int;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS duplicate_of int REFERENCES ic_job_listings(id);
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS repost_of int REFERENCES ic_job_listings(id);
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS stale boolean DEFAULT false;
ALTER TABLE ic_job_listings ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(company, '') || ' ' ||
      coalesce(location, '') || ' ' || coalesce(description, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS ic_job_listings_tsv_idx ON ic_job_listings USING gin (tsv);
CREATE INDEX IF NOT EXISTS ic_job_listings_dedup_hash_idx ON ic_job_listings (dedup_hash);
CREATE INDEX IF NOT EXISTS ic_job_listings_title_norm_trgm_idx ON ic_job_listings USING gin (title_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ic_job_listings_company_norm_trgm_idx ON ic_job_listings USING gin (company_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ic_job_listings_status_last_seen_idx ON ic_job_listings (status, last_seen DESC);
CREATE INDEX IF NOT EXISTS ic_job_listings_duplicate_of_idx ON ic_job_listings (duplicate_of) WHERE duplicate_of IS NOT NULL;

COMMIT;
