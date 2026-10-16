-- 026: Target finder decisions (plan: target-finder-2026-10-15, PR4, section 18).
--
-- ic_target_decisions: the append-only audit trail of every human action on a target (reclassify, discard,
-- restore) plus every refused attempt to promote a blocked row (blocked_refused). decision_version is the row's
-- optimistic-concurrency counter AFTER the action, so UNIQUE (target_id, decision_version) holds exactly one
-- audit row per version. The actor is the literal 'damian' (single operator); a request body cannot set it. A
-- trigger refuses UPDATE, so history can only grow (no UPDATE or DELETE path exists in code either).
--
-- ic_targets (all additive):
--   decision_version  dedicated optimistic-concurrency counter, +1 per audit row. Never updated_at: the runner
--                     refreshes updated_at on every upsert, so it is not a stable version.
--   decision_reason   the closed reason code of the latest manual decision.
--   new_evidence_at   set by the runner only when the target already has a decision and a linked signal is new to
--                     it; cleared by the next manual action. A badge, never a resurfacing.
--   stale_evidence_at set by the runner when a gap target's listing signals all vanish from a completed gap
--                     snapshot; cleared when one returns. The class is never touched.
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-025 precedent.

BEGIN;

ALTER TABLE ic_targets ADD COLUMN IF NOT EXISTS decision_version int NOT NULL DEFAULT 0;
ALTER TABLE ic_targets ADD COLUMN IF NOT EXISTS decision_reason text;
ALTER TABLE ic_targets ADD COLUMN IF NOT EXISTS new_evidence_at timestamptz;
ALTER TABLE ic_targets ADD COLUMN IF NOT EXISTS stale_evidence_at timestamptz;

CREATE TABLE IF NOT EXISTS ic_target_decisions (
  id serial PRIMARY KEY,
  target_id int NOT NULL REFERENCES ic_targets(id) ON DELETE CASCADE,
  actor text NOT NULL DEFAULT 'damian' CHECK (actor = 'damian'),
  at timestamptz NOT NULL DEFAULT now(),
  from_class text CHECK (from_class IS NULL OR from_class IN ('target', 'needs-review', 'not-target')),
  to_class text CHECK (to_class IS NULL OR to_class IN ('target', 'needs-review', 'not-target')),
  action text NOT NULL CHECK (action IN ('reclassify', 'discard', 'restore', 'blocked_refused')),
  reason_code text,
  note text,
  decision_version int NOT NULL CHECK (decision_version >= 1),
  CONSTRAINT ic_target_decisions_version_uq UNIQUE (target_id, decision_version)
);
CREATE INDEX IF NOT EXISTS ic_target_decisions_target_idx ON ic_target_decisions (target_id, id);

CREATE OR REPLACE FUNCTION ic_target_decisions_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ic_target_decisions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ic_target_decisions_no_update_trg ON ic_target_decisions;
CREATE TRIGGER ic_target_decisions_no_update_trg BEFORE UPDATE ON ic_target_decisions
  FOR EACH ROW EXECUTE FUNCTION ic_target_decisions_no_update();

COMMIT;
