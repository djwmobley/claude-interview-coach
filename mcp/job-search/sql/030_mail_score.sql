-- 030: Recruiter-mail scoring and extraction (2026-10-24).
--
-- One headless, tool-less model call per recruiter_like or thread_reply intake item extracts the role and the
-- client and scores fit. The grounded result is stored on the intake row; a real opportunity becomes (or links
-- to) a listing with source 'recruiter_mail'.
--
--   ic_mail_intake.score_status   pending (not yet scored) | scored | failed (invalid output, timeout, refusal or
--                                 exhausted attempts; the item stays surfaced and unscored)
--   ic_mail_intake.score          the grounded result (jsonb); NULL until scored
--   ic_mail_intake.score_flags    ungrounded_<field>, below_floor, excluded, not_opportunity, linked_existing, ...
--   ic_mail_intake.score_attempts model calls spent on this item (a failed item is retried while attempts < 2)
--   ic_mail_intake.score_text     the headers plus at most 4 KB of body the model sees and grounding checks against;
--                                 cleared once the item is scored or has failed for good
--   ic_mail_intake.scored_at / listing_id
--   ic_mail_score_budget          its own reserve (per-run caps live in code), separate from triage's batch budget:
--                                 one row per day with the model calls used
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-029 precedent.

BEGIN;

ALTER TABLE ic_mail_intake ADD COLUMN IF NOT EXISTS score_status text NOT NULL DEFAULT 'pending' CHECK (score_status IN ('pending','scored','failed'));
ALTER TABLE ic_mail_intake ADD COLUMN IF NOT EXISTS score jsonb;
ALTER TABLE ic_mail_intake ADD COLUMN IF NOT EXISTS score_flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE ic_mail_intake ADD COLUMN IF NOT EXISTS score_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE ic_mail_intake ADD COLUMN IF NOT EXISTS score_text text;
ALTER TABLE ic_mail_intake ADD COLUMN IF NOT EXISTS scored_at timestamptz;
ALTER TABLE ic_mail_intake ADD COLUMN IF NOT EXISTS listing_id integer;

CREATE INDEX IF NOT EXISTS ic_mail_intake_score_idx ON ic_mail_intake (score_status, bucket) WHERE score_text IS NOT NULL;

CREATE TABLE IF NOT EXISTS ic_mail_score_budget (
  day  date PRIMARY KEY,
  used integer NOT NULL DEFAULT 0
);

COMMIT;
