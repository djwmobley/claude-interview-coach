-- 014: one-click apply (PR A) -- salary floor storage plus the independent headless review verdict
-- (plan `let-s-brainstorm-a-bit-humble-umbrella.md`'s apply pipeline, PR A spec items 1 and 6).
--
-- salary_floor: the resolved compensation floor (src/core/salary-floor.js's resolveFloor()) stored on the
-- application at creation time, so a screening-question salary answer always uses the floor that applied
-- to THIS application, never a floor that may have changed in config/auto-apply.json since. int, not
-- numeric: every floor value in this codebase is a whole-dollar annual figure.
--
-- review_verdict / review_findings: the independent headless CV review's own machine block (PR A spec
-- item 6, src/dashboard/review-runner.js), stored so the dashboard card can show why an application
-- parked at docs_ready instead of advancing to approved. review_verdict is free text, not a CHECK-
-- constrained enum: the runner already treats anything other than the literal string 'PASS' as failing to
-- advance (VERDICT: FAIL, or an unparseable result, or a runner-side error reason like
-- 'review_unparseable') and this column is diagnostic/audit output a human reads, not a value another
-- part of the system branches on by reading the column back -- the same reasoning sql/013's
-- ic_gmail_processed_messages.outcome column already documents for the identical shape of decision.
--
-- Pure idempotent DDL (ADD COLUMN IF NOT EXISTS), no data backfill -- same "safe to run on every server/
-- dashboard startup" convention sql/011-013 established. Registered in all three migration lists per that
-- precedent (bin/migrate.js MIGRATIONS, src/core/schema.js AUX_MIGRATIONS, bin/bootstrap-test-db.js
-- MIGRATIONS).

BEGIN;

ALTER TABLE ic_job_applications ADD COLUMN IF NOT EXISTS salary_floor int;
ALTER TABLE ic_job_applications ADD COLUMN IF NOT EXISTS review_verdict text;
ALTER TABLE ic_job_applications ADD COLUMN IF NOT EXISTS review_findings jsonb;

COMMIT;
