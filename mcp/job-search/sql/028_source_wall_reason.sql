-- 028: Why a source was auto-disabled (LinkedIn false-positive walls, 2026-10-24).
--
-- ic_source_state gains the last wall's reason and a short history, so the reports and the dashboard can say
-- "auto-disabled after 3 failed scans (dates): reason" instead of a bare "manual disable":
--   last_wall_kind      closed classification of the last wall (login, throttle_or_block, unhydrated_after_retry,
--                       unknown, detail_blocked, or a wall.js verdict kind for the other sources); NULL when unrecorded.
--   last_wall_detail    short human detail for that wall.
--   last_wall_url       final URL of the page, query string already stripped by the capability.
--   last_wall_snapshot  BASENAME ONLY of the sanitized page snapshot under <logs>/linkedin-snapshots.
--   last_wall_run_id    the scan run that saw it (no foreign key: runs are pruned independently).
--   wall_history        the last 5 walls, oldest first: [{at, kind, detail, url, snapshot, run_id}].
--   reset_at            set by a re-enable; only history entries after it count toward "N failed scans".
--
-- No backfill: existing rows keep NULLs and render "reason not recorded". Pure idempotent DDL, safe on every
-- startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js AUX_MIGRATIONS, and
-- bin/bootstrap-test-db.js MIGRATIONS per the sql/011-027 precedent.

BEGIN;

ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS last_wall_kind text;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS last_wall_detail text;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS last_wall_url text;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS last_wall_snapshot text;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS last_wall_run_id bigint;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS wall_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ic_source_state ADD COLUMN IF NOT EXISTS reset_at timestamptz;

COMMIT;
