-- 018: assisted LinkedIn Easy Apply (operator decision 2026-10-04: fill the form in the scan Chrome, stop at
-- LinkedIn's Review screen, Damian clicks Submit himself). Three pieces:
--
-- ic_easy_apply_leases: one row per Easy Apply attempt. The worker issues it (application id, a random
-- nonce stored only as its sha256, an expiry) before spawning the headless session; every call of the
-- easy_apply MCP tool validates it. It also carries the server-side fill ledger (question, bank key,
-- value, read-back verification) and the step state the tool needs between calls, and the verified
-- finish result. Only that verified finish result moves application state, never the model's exit code.
--
-- ic_easy_apply_breaker: a persisted singleton circuit breaker (id = 1). A CAPTCHA/challenge page,
-- "unusual activity", a forced login, HTTP 429, or an unexpected "application sent" trips it for 24 hours;
-- every Easy Apply start checks it.
--
-- ic_job_applications_easy_apply_inflight_uq: at most ONE linkedin_easy application in 'submitting' OR
-- parked at needs_human with pending_question.kind = 'awaiting_submit' (spec G9). Scoped to
-- ats_type = 'linkedin_easy' deliberately: other ATS applications run through the same worker but never
-- hold a browser tab open across the handoff, so they do not compete for this slot. Claiming happens under
-- the worker's LOCK_KEY advisory lock in the same transaction as approved -> submitting; this index is
-- the database-level backstop that turns a lost race into a unique violation instead of a second tab.
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-017 precedent.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_easy_apply_leases (
  id serial PRIMARY KEY,
  application_id int NOT NULL REFERENCES ic_job_applications(id) ON DELETE CASCADE,
  nonce_hash text NOT NULL,
  trigger text NOT NULL
    CONSTRAINT ic_easy_apply_leases_trigger_check CHECK (trigger IN ('morning', 'dashboard')),
  target_id text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  stop_reason text,
  ledger jsonb NOT NULL DEFAULT '[]'::jsonb,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  finish_result jsonb,
  last_action_at timestamptz
);

CREATE INDEX IF NOT EXISTS ic_easy_apply_leases_application_idx ON ic_easy_apply_leases (application_id);
CREATE INDEX IF NOT EXISTS ic_easy_apply_leases_issued_idx ON ic_easy_apply_leases (issued_at);

CREATE TABLE IF NOT EXISTS ic_easy_apply_breaker (
  id int PRIMARY KEY CONSTRAINT ic_easy_apply_breaker_singleton CHECK (id = 1),
  tripped_until timestamptz,
  tripped_at timestamptz,
  reason text,
  application_id int
);

CREATE UNIQUE INDEX IF NOT EXISTS ic_job_applications_easy_apply_inflight_uq
  ON ic_job_applications ((true))
  WHERE ats_type = 'linkedin_easy'
    AND (state = 'submitting' OR (state = 'needs_human' AND pending_question->>'kind' = 'awaiting_submit'));

COMMIT;
