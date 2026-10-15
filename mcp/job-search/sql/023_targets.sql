-- 023: Target finder (plan: target-finder-2026-10-15, PR1). Companies to approach directly, not job listings.
--
-- ic_targets: one row per company group (company_norm), the post-classification, post-dedup outcome.
-- class is the classifier's total verdict (target | needs-review | not-target); verdict_rule and
-- verdict_inputs persist WHY (src/core/target-classify.js returns {class, rule, inputs}). The name
-- ic_gmail_targets is taken by sql/021, so none of these tables reuse it.
--
-- ic_target_signals: raw evidence rows, keyed by url_hash (unique). The excerpt is UNTRUSTED source text
-- and must never be treated as instructions; extracted holds the parser's structured fields.
--
-- ic_target_drafts: the outreach note (hook, bridge, claim, ask) parked for approval. Nothing is ever
-- sent: there is no send path anywhere in target code. Populated by a later PR; the table ships now so
-- the schema is one migration.
--
-- ic_target_runs: one row per runner execution (later PR).
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-022 precedent.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_targets (
  id serial PRIMARY KEY,
  company text NOT NULL,
  company_norm text NOT NULL,
  class text NOT NULL CHECK (class IN ('target', 'needs-review', 'not-target')),
  reason text,
  verdict_rule text NOT NULL,
  verdict_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger_kind text CHECK (trigger_kind IS NULL OR trigger_kind IN ('pe_deal', 'exec_departure', 'leadership_gap')),
  trigger_date date,
  evidence_url text,
  contact_role text,
  contact_name text,
  pe_firm text,
  size_low bigint,
  size_high bigint,
  size_basis text,
  size_confidence text CHECK (size_confidence IS NULL OR size_confidence IN ('high', 'medium', 'low', 'none')),
  listing_ids int[] NOT NULL DEFAULT '{}',
  collapsed_signal_ids int[] NOT NULL DEFAULT '{}',
  decision text CHECK (decision IS NULL OR decision IN ('reclassified', 'discarded', 'approved')),
  decision_class text CHECK (decision_class IS NULL OR decision_class IN ('target', 'needs-review', 'not-target')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ic_targets_company_norm_idx ON ic_targets (company_norm);
CREATE INDEX IF NOT EXISTS ic_targets_class_idx ON ic_targets (class);

CREATE TABLE IF NOT EXISTS ic_target_signals (
  id serial PRIMARY KEY,
  url_hash text NOT NULL,
  source text NOT NULL,
  url text,
  excerpt text,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_id int REFERENCES ic_targets(id) ON DELETE SET NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ic_target_signals_url_hash_idx ON ic_target_signals (url_hash);
CREATE INDEX IF NOT EXISTS ic_target_signals_target_idx ON ic_target_signals (target_id);

CREATE TABLE IF NOT EXISTS ic_target_drafts (
  id serial PRIMARY KEY,
  target_id int NOT NULL REFERENCES ic_targets(id) ON DELETE CASCADE,
  hook text,
  bridge text,
  claim text,
  ask text,
  word_count int,
  gates jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_verdict text CHECK (review_verdict IS NULL OR review_verdict IN ('PASS', 'FAIL')),
  review_findings jsonb,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'gate_failed', 'review_failed', 'awaiting_approval', 'approved', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ic_target_drafts_target_idx ON ic_target_drafts (target_id);
CREATE INDEX IF NOT EXISTS ic_target_drafts_state_idx ON ic_target_drafts (state);

CREATE TABLE IF NOT EXISTS ic_target_runs (
  id serial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed', 'partial')),
  signals_seen int NOT NULL DEFAULT 0,
  targets int NOT NULL DEFAULT 0,
  needs_review int NOT NULL DEFAULT 0,
  not_target int NOT NULL DEFAULT 0,
  drafts_made int NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

COMMIT;
