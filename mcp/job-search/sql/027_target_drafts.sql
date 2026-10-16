-- 027: Target finder drafts (plan: target-finder-2026-10-15, PR5, section 19). Nothing here sends anything.
--
-- ic_target_drafts (table from 023) gains the columns the draft pipeline needs:
--   attempt        1 for a request's first generation, 2 for its one automatic regeneration.
--   origin         auto_first (the scan picked the target; at most ONE per target, enforced by a unique index),
--                  auto_regen (the single automatic retry of a parked draft), manual (Damian asked to regenerate).
--                  auto_first and manual rows are "claims": they carry cap_day (the ET business day) and count
--                  against the daily cap. auto_regen rows never do.
--   regen_of       the parked draft an auto_regen row retries (unique: one regeneration per draft).
--   evidence_ids   the signal ids that were sent to the drafter; the citation gate only trusts these.
--   sentences      the model's sentence tags [{text, src}], re-derived on edit.
--   fail_codes     closed codes from the gates, the reviewer and the pipeline.
--   draft_version  optimistic-concurrency counter, +1 per edit.
--   text_hash      sha256 of the exact text that Preflight returns and approve binds to.
--   edited         true once Damian has edited the draft (gates are advisory from then on).
--   approved_at    set by the approve transaction.
-- State gains 'queued' (a counted claim waiting for the generator). At most one live draft per target.
--
-- ic_target_draft_edits: append-only before/after record of every edit (for later voice capture). A trigger
-- refuses UPDATE; no code path deletes.
--
-- ic_target_decisions.action gains 'approve' (the audit row of an approved draft).
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-026 precedent.

BEGIN;

ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1;
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'auto_first';
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS regen_of int REFERENCES ic_target_drafts(id) ON DELETE SET NULL;
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS cap_day date;
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS evidence_ids int[] NOT NULL DEFAULT '{}';
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS sentences jsonb;
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS fail_codes text[] NOT NULL DEFAULT '{}';
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS draft_version int NOT NULL DEFAULT 0;
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS text_hash text;
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS edited boolean NOT NULL DEFAULT false;
ALTER TABLE ic_target_drafts ADD COLUMN IF NOT EXISTS approved_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_target_drafts_origin_chk') THEN
    ALTER TABLE ic_target_drafts ADD CONSTRAINT ic_target_drafts_origin_chk
      CHECK (origin IN ('auto_first', 'auto_regen', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_target_drafts_claim_chk') THEN
    ALTER TABLE ic_target_drafts ADD CONSTRAINT ic_target_drafts_claim_chk
      CHECK (origin <> 'auto_regen' OR cap_day IS NULL);
  END IF;
END $$;

-- The state list gains 'queued'. Drop the original unnamed-by-us constraint (created inline in 023) by lookup.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'ic_target_drafts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%awaiting_approval%'
             AND conname <> 'ic_target_drafts_state_v2_chk'
  LOOP
    EXECUTE format('ALTER TABLE ic_target_drafts DROP CONSTRAINT %I', c);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_target_drafts_state_v2_chk') THEN
    ALTER TABLE ic_target_drafts ADD CONSTRAINT ic_target_drafts_state_v2_chk
      CHECK (state IN ('queued', 'draft', 'gate_failed', 'review_failed', 'awaiting_approval', 'approved', 'discarded'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ic_target_drafts_first_uq ON ic_target_drafts (target_id) WHERE origin = 'auto_first';
CREATE UNIQUE INDEX IF NOT EXISTS ic_target_drafts_regen_uq ON ic_target_drafts (regen_of) WHERE regen_of IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ic_target_drafts_live_uq ON ic_target_drafts (target_id) WHERE state IN ('queued', 'draft', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS ic_target_drafts_cap_idx ON ic_target_drafts (cap_day) WHERE cap_day IS NOT NULL;

CREATE TABLE IF NOT EXISTS ic_target_draft_edits (
  id serial PRIMARY KEY,
  draft_id int NOT NULL REFERENCES ic_target_drafts(id) ON DELETE CASCADE,
  actor text NOT NULL DEFAULT 'damian' CHECK (actor = 'damian'),
  at timestamptz NOT NULL DEFAULT now(),
  before jsonb NOT NULL,
  after jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ic_target_draft_edits_draft_idx ON ic_target_draft_edits (draft_id, id);

CREATE OR REPLACE FUNCTION ic_target_draft_edits_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ic_target_draft_edits is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ic_target_draft_edits_no_update_trg ON ic_target_draft_edits;
CREATE TRIGGER ic_target_draft_edits_no_update_trg BEFORE UPDATE ON ic_target_draft_edits
  FOR EACH ROW EXECUTE FUNCTION ic_target_draft_edits_no_update();

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'ic_target_decisions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%blocked_refused%'
             AND conname <> 'ic_target_decisions_action_v2_chk'
  LOOP
    EXECUTE format('ALTER TABLE ic_target_decisions DROP CONSTRAINT %I', c);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ic_target_decisions_action_v2_chk') THEN
    ALTER TABLE ic_target_decisions ADD CONSTRAINT ic_target_decisions_action_v2_chk
      CHECK (action IN ('reclassify', 'discard', 'restore', 'blocked_refused', 'approve'));
  END IF;
END $$;

COMMIT;
