-- 020: the atomic submit marker (unattended ATS submit, spec v2 C3 + spec 1/4/6).
--
-- ic_job_submit_markers: at most ONE row per application, ever. A worker about to click a final Submit
-- control inserts this row (ON CONFLICT DO NOTHING) in the same transaction that writes the
-- 'submit_request_sent' application event, and commits BEFORE the click. Only the caller whose insert
-- returned a row may click; a second worker, a crash-recovered rerun, a Retry, or a Resume finds the row
-- and never clicks again. The primary key on application_id is the one statement only one caller can win.
--
-- `day` is the UTC budget day (src/core/budget.js budgetDay) the marker was reserved on: the daily
-- unattended SUBMIT cap (config/auto-apply.json unattendedSubmit.dailySubmitCap) counts these rows, under
-- a transaction-scoped advisory lock taken in the same transaction as the insert, so the cap slot is
-- reserved atomically with the marker.
--
-- Backfill: every application that already carries a 'submit_request_sent' progress event (any attempt)
-- gets one marker row dated by its earliest such event, so an application that may already have been
-- submitted before this migration can never be clicked again. Rows that already exist are left alone.
--
-- Pure idempotent DDL plus an idempotent backfill, safe on every startup. Registered in bin/migrate.js
-- MIGRATIONS, src/core/schema.js AUX_MIGRATIONS, and bin/bootstrap-test-db.js MIGRATIONS per the
-- sql/011-019 precedent.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_job_submit_markers (
  application_id int PRIMARY KEY REFERENCES ic_job_applications(id) ON DELETE CASCADE,
  ats_type text,
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ic_job_submit_markers_day_idx ON ic_job_submit_markers (day);

INSERT INTO ic_job_submit_markers (application_id, ats_type, day, created_at)
SELECT e.application_id, a.ats_type, (min(e.created_at) AT TIME ZONE 'UTC')::date, min(e.created_at)
  FROM ic_job_application_events e
  JOIN ic_job_applications a ON a.id = e.application_id
 WHERE e.kind = 'progress' AND e.note = 'submit_request_sent'
 GROUP BY e.application_id, a.ats_type
ON CONFLICT (application_id) DO NOTHING;

COMMIT;
