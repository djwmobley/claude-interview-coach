-- 006: follow-up reminders (spec 2.4). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_followups (
  id serial PRIMARY KEY,
  contact text NOT NULL,
  org text,
  listing_id int REFERENCES ic_job_listings(id),
  due_at timestamptz NOT NULL,
  channel text NOT NULL CHECK (channel IN ('phone', 'email', 'linkedin', 'other')),
  action text NOT NULL,
  notify text[] NOT NULL DEFAULT '{email}',
  status text NOT NULL CHECK (status IN ('open', 'done', 'snoozed', 'cancelled')) DEFAULT 'open',
  snoozed_until timestamptz,
  created_from text,
  reminded_at timestamptz,
  calendar_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ic_followups_status_due_idx ON ic_followups (status, due_at);

COMMIT;
