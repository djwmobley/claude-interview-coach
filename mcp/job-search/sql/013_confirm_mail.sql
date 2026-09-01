-- 013: mail classifier + confirmation job + 5-day nudge (apply pipeline slice 7, plan
-- `let-s-brainstorm-a-bit-humble-umbrella.md` section "6. Confirmation tracking", amended by the
-- slice-7 spec-adversary pass -- see the PR body for the full list of amendments).
--
-- ic_gmail_processed_messages: the idempotency ledger the confirmation job (src/apply/mail-confirm.js,
-- bin/confirm.js) checks BEFORE acting on a Gmail message and writes AFTER acting on it, so a re-run
-- (the job runs daily and a message can still be in the mailbox window on the next run) never re-applies
-- a classification decision twice: no double state transition, no duplicate review-queue entry. A message
-- is inserted here only once its outcome has been fully applied to the database -- if the process crashes
-- mid-message, the row is simply absent and the message is safely reprocessed on the next run.
--
-- The GUARANTEE differs by path (see mail-confirm.js's own module doc comment for the full detail):
--   - received -> confirmed: self-guarding by the application's own state. Once confirmed, the row drops
--     out of the `submitted` candidate pool the next run builds, so a replay finds no match and is a
--     harmless no-op (never a second confirmation). A crash between the transition committing and the
--     5-day nudge follow-up completing is a known, non-blocking residual gap (a stale reminder for an
--     application that did confirm), not a data-integrity violation.
--   - rejected/closed -> review: every routeListingToReview() call for a message PLUS this table's own
--     insert for that message are committed as ONE transaction (withTransaction in mail-confirm.js), so a
--     crash mid-message leaves NEITHER the review-queue effects NOR this ledger row committed -- never
--     effects-without-ledger, which is what would let a replay insert a second open
--     ic_job_review_queue row for the same listing and violate sql/004_review_queue.sql's invariant
--     ("every status='review' listing has exactly one open queue row", checked by bin/migrate.js's
--     queueInvariant()/--check). routeListingToReview() additionally guards itself against being replayed
--     outside that transaction for any other reason (an existing open queue row for the candidate is
--     reused, never duplicated), mirroring bin/migrate.js's own established pattern for this same
--     invariant.
--
-- company_raw is stored alongside company_norm on every row (amended decision: "every classification
-- decision logs the RAW company string from the mail alongside company_norm") so a wrong-company match
-- class (the plan's own "Mercy Ships vs Mercy Health confusion" example) is diagnosable from this table
-- alone, without re-fetching the original message from Gmail.
--
-- Pure idempotent DDL (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS), no data backfill --
-- follows the same "safe to run on every server/dashboard startup" convention sql/011 and sql/012
-- established. Registered in all three migration lists per that precedent (bin/migrate.js MIGRATIONS,
-- src/core/schema.js AUX_MIGRATIONS, bin/bootstrap-test-db.js MIGRATIONS).

BEGIN;

CREATE TABLE IF NOT EXISTS ic_gmail_processed_messages (
  message_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now(),
  -- Total classification the mail body/subject produced (src/apply/mail-classifier.js's classifyApplicationMail):
  -- every message maps to exactly one of these four, 'unknown' is the default branch, never a fifth value.
  kind text NOT NULL
    CONSTRAINT ic_gmail_processed_messages_kind_check
    CHECK (kind IN ('received', 'rejected', 'closed', 'unknown')),
  company_raw text,
  company_norm text,
  -- Set only when the message was correlated to exactly one application (never on an ambiguous match --
  -- amended decision: ambiguity is resolved per-application-id, never a guess, so an ambiguous message's
  -- row here always has application_id NULL even though `outcome` records that it was ambiguous).
  application_id int REFERENCES ic_job_applications(id) ON DELETE SET NULL,
  -- Free text, not a closed enum: what the job actually did with this message (e.g. 'confirmed',
  -- 'already_confirmed', 'ambiguous_received', 'no_match', 'routed_review', 'ambiguous_review', 'unknown').
  -- Kept as free text rather than a CHECK-constrained list because this column is diagnostic/audit
  -- output, not a value another part of the system branches on by reading the column back.
  outcome text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ic_gmail_processed_messages_application_id_idx ON ic_gmail_processed_messages (application_id);
CREATE INDEX IF NOT EXISTS ic_gmail_processed_messages_processed_at_idx ON ic_gmail_processed_messages (processed_at);

COMMIT;
