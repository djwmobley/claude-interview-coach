-- 029: Personal mail intake ledger and per-capability Google health (2026-10-24).
--
-- A recruiter email (Gmail Promotions tab) was never surfaced because the Gmail adapter only parsed 12
-- allowlisted job-alert senders. The intake pass classifies every message in the window into exactly one bucket
-- and records it here; recruiter_like and thread_reply rows are the review items.
--
--   ic_mail_intake          one row per Gmail message id (NOT ic_gmail_processed_messages, which belongs to
--                           confirm.js). bucket is a closed vocabulary (CHECK). rules_version is the classifier
--                           version that placed the row; a version change reprocesses unsorted rows.
--                           Display fields (subject, snippet, from_name, reply_to, labels) are stored only for the
--                           buckets that surface (recruiter_like, thread_reply, unsorted); other buckets keep the
--                           sender address and counts. status is open or dismissed (the Review page's Dismiss).
--                           surfaced_run_id is the scan run whose report first listed the row.
--   ic_google_capability    last good read / send / calendar and the first failure since, one row per capability,
--                           so the report can say "Gmail send BROKEN since <date>" even though reading still works.
--
-- Pure idempotent DDL, safe on every startup. Registered in bin/migrate.js MIGRATIONS, src/core/schema.js
-- AUX_MIGRATIONS and bin/bootstrap-test-db.js MIGRATIONS per the sql/011-028 precedent.

BEGIN;

CREATE TABLE IF NOT EXISTS ic_mail_intake (
  message_id        text PRIMARY KEY,
  thread_id         text,
  bucket            text NOT NULL CHECK (bucket IN ('self','registered_alert','application_mail','internal','thread_reply','recruiter_like','bulk_noise','unsorted')),
  rules_version     text NOT NULL,
  signal            text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  surfaced_run_id   bigint,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed')),
  dismissed_at      timestamptz,
  from_addr         text,
  from_name         text,
  reply_to          text,
  reply_to_differs  boolean NOT NULL DEFAULT false,
  subject           text,
  snippet           text,
  msg_date          timestamptz,
  labels            text[] NOT NULL DEFAULT '{}',
  spam              boolean NOT NULL DEFAULT false,
  body_unreadable   boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ic_mail_intake_bucket_idx ON ic_mail_intake (bucket, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS ic_mail_intake_thread_idx ON ic_mail_intake (thread_id);

CREATE TABLE IF NOT EXISTS ic_google_capability (
  capability     text PRIMARY KEY CHECK (capability IN ('read','send','calendar')),
  last_good_at   timestamptz,
  last_fail_at   timestamptz,
  broken_since   timestamptz,
  last_state     text,
  missing_scopes text[] NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMIT;
