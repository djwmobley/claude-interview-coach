// @ts-check
/**
 * Apply pipeline: applications and their state machine (slice 1, plan
 * `let-s-brainstorm-a-bit-humble-umbrella.md` section "1. Application concept", sql/012_applications.sql).
 *
 * TRANSITIONS below is the frozen, TOTAL state machine: every legal move from every state is listed
 * explicitly, and anything not listed throws VALIDATION. There is no catch-all "any state can go
 * anywhere" branch and no silent coercion -- a caller (this slice's tests, or a later slice's worker)
 * that asks for an illegal transition gets a clear, typed rejection before any row is touched.
 *
 * Rationale for the less obvious edges (recorded here, not only in the plan, so it survives independent
 * of the plan file):
 *   - needs_human -> submitted: "I applied by hand" (the dashboard's needs_human card offers this as an
 *     explicit action alongside Resume/Retry -- the human did the ATS form themselves and is telling the
 *     tracker so).
 *   - needs_human -> approved and failed -> approved: Resume and Retry. Both re-enter the approved state
 *     (the point the worker picks up submission from) and both increment `attempt`, via the resume()/
 *     retry() helpers rather than the general transition() function, so a caller can never increment
 *     attempt from an arbitrary transition by accident.
 *   - submitting -> failed: covers both a worker-reported failure AND stale-crash reconciliation
 *     (reconcileStale() below) -- a worker that dies mid-submit leaves a row stuck in 'submitting'
 *     forever unless something notices and moves it on.
 *   - confirmed and withdrawn are terminal: neither has any outgoing edge in TRANSITIONS.
 *
 * Every function here that mutates a row wraps its own transaction (withTransaction) and does a
 * `SELECT ... FOR UPDATE` before validating, so two concurrent callers (e.g. a dashboard click racing a
 * worker tick) serialize on the row rather than corrupting it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { withTransaction, isUniqueViolation } from './db.js';
import { JobSearchError } from './errors.js';
import { EVENT_ACTORS } from './events.js';
import { applyMark } from '../tools/mark_jobs.js';
import { STATUS_GROUPS } from './statuses.js';
import { resolveOutputPath } from './documents.js';
import { createFollowup } from './followups.js';

/**
 * `created_from` prefix for the unconditional 5-day-nudge follow-up markSubmittedUnwrapped creates below
 * (apply pipeline slice 7, amended spec: "The 5-day nudge is created UNCONDITIONALLY on every submitted
 * transition... Correlation via the followup's created_from field = 'apply-nudge:<application_id>'").
 * Exported so src/apply/mail-confirm.js can look the row back up by exact prefix+id when an application
 * confirms, without either module re-deriving or hardcoding the format twice.
 */
export const APPLY_NUDGE_PREFIX = 'apply-nudge:';

/** Milliseconds in the nudge's 5-day window. */
const APPLY_NUDGE_DAYS = 5;

/** ic_job_applications.ats_type CHECK values (sql/012_applications.sql). */
export const ATS_TYPES = Object.freeze([
  'greenhouse', 'lever', 'workday', 'dayforce', 'indeed_easy', 'linkedin_easy', 'icims', 'smartrecruiters', 'unknown',
]);

/** ic_job_applications.state CHECK values (sql/012_applications.sql). Keys of TRANSITIONS below, in the same order. */
export const APPLICATION_STATES = Object.freeze([
  'drafting', 'docs_ready', 'approved', 'submitting', 'submitted', 'confirmed', 'failed', 'needs_human', 'withdrawn',
]);

/**
 * The frozen, total state machine. Every array is itself frozen so a caller cannot mutate the allowed
 * set at runtime. A state with no outgoing edges (confirmed, withdrawn) is terminal.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TRANSITIONS = Object.freeze({
  drafting: Object.freeze(['docs_ready', 'needs_human', 'withdrawn']),
  docs_ready: Object.freeze(['approved', 'drafting', 'withdrawn']),
  approved: Object.freeze(['submitting', 'withdrawn']),
  submitting: Object.freeze(['submitted', 'needs_human', 'failed']),
  submitted: Object.freeze(['confirmed', 'withdrawn']),
  needs_human: Object.freeze(['approved', 'submitted', 'withdrawn']),
  failed: Object.freeze(['approved', 'withdrawn']),
  confirmed: Object.freeze([]),
  withdrawn: Object.freeze([]),
});

/** ic_job_application_events.kind CHECK values (sql/012_applications.sql). */
export const APPLICATION_EVENT_KINDS = Object.freeze(['state', 'note', 'error', 'progress']);

const APPLICATION_COLS = [
  'id', 'listing_id', 'ats_type', 'apply_url', 'account_email', 'state', 'resume_doc_id', 'coverletter_doc_id',
  'resume_hash', 'coverletter_hash', 'answers', 'pending_question', 'screenshot_rel_path', 'submitted_at',
  'confirmed_at', 'approved_at', 'confirmation_ref', 'error', 'attempt', 'created_at', 'updated_at',
].join(', ');

/**
 * @typedef {Object} PendingQuestion
 * @property {string} kind 'credential' | 'question' | any other string (total classification -- an
 *   unrecognized kind is still a valid pending_question, the dashboard renders it as a generic card)
 * @property {string} [target] required when kind === 'credential'
 * @property {string} [username] required when kind === 'credential'
 * @property {string} [label] required when kind === 'question'
 * @property {string} [page_url]
 */

/**
 * `answers` jsonb shape (documented here, not enforced by a CHECK in this slice -- A14):
 * @typedef {Object} AnswerEntry
 * @property {string} value
 * @property {'bank'|'human'} source
 * @property {string} answered_at ISO timestamp
 * @typedef {Record<string, AnswerEntry>} AnswersMap canonical_key -> AnswerEntry
 */

/**
 * needs_human requires a pending_question object with a string `kind`; kind 'credential' additionally
 * requires `target` and `username`; kind 'question' additionally requires `label`. Any other kind is
 * permitted as-is (total classification: the dashboard renders an unrecognized kind as a generic card).
 * @param {unknown} pq
 */
function validatePendingQuestion(pq) {
  if (pq === null || pq === undefined || typeof pq !== 'object' || Array.isArray(pq)) {
    throw new JobSearchError('VALIDATION', 'pending_question is required (an object with a string "kind") when entering needs_human');
  }
  const obj = /** @type {Record<string, unknown>} */ (pq);
  if (typeof obj.kind !== 'string' || !obj.kind.trim()) {
    throw new JobSearchError('VALIDATION', 'pending_question.kind must be a non-empty string');
  }
  if (obj.kind === 'credential') {
    if (typeof obj.target !== 'string' || !obj.target.trim()) throw new JobSearchError('VALIDATION', 'pending_question.target is required for kind "credential"');
    if (typeof obj.username !== 'string' || !obj.username.trim()) throw new JobSearchError('VALIDATION', 'pending_question.username is required for kind "credential"');
  } else if (obj.kind === 'question') {
    if (typeof obj.label !== 'string' || !obj.label.trim()) throw new JobSearchError('VALIDATION', 'pending_question.label is required for kind "question"');
  }
}

/**
 * A listing status the apply pipeline is allowed to overwrite with 'applied': NULL (untriaged) or any
 * status in the triage group (new/maybe/shortlisted). Everything else -- already 'applied' or further
 * along (interviewing/offer), any closed status (accepted/passed/lost/skip/dead), or the system 'review'
 * status -- is left untouched by markSubmitted (A12): overwriting any of those would either be a no-op
 * disguised as a write, or a regression of state the operator (or an earlier automated pass) already set
 * deliberately. This is a total two-way split of statuses.js's PIPELINE_STATUSES plus NULL, not an
 * allow-list of "closed" statuses picked by hand -- broader and safer than the plan's literal wording,
 * which only named the closed group as an example.
 * @param {string|null} status
 */
function isPreApplicationStatus(status) {
  return status === null || STATUS_GROUPS.triage.includes(status);
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ applicationId: number, kind: 'state'|'note'|'error'|'progress', fromState?: string|null, toState?: string|null, actor: string, note?: string|null, meta?: unknown }} input
 */
async function insertApplicationEvent(client, input) {
  if (!APPLICATION_EVENT_KINDS.includes(input.kind)) {
    throw new JobSearchError('VALIDATION', `application event kind must be one of ${APPLICATION_EVENT_KINDS.join(', ')}`);
  }
  if (!EVENT_ACTORS.includes(input.actor)) {
    throw new JobSearchError('VALIDATION', `application event actor must be one of ${EVENT_ACTORS.join(', ')}`);
  }
  await client.query(
    `INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor, note, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.applicationId, input.kind, input.fromState ?? null, input.toState ?? null, input.actor,
      input.note ?? null, input.meta !== undefined ? JSON.stringify(input.meta) : null,
    ],
  );
}

/**
 * Create a new application in state 'drafting'. Fails with a clean VALIDATION error (not a raw
 * postgres unique-violation) when an active (non-withdrawn) application already exists for the listing
 * (A6, sql/012_applications.sql's partial unique index).
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, atsType?: string, applyUrl?: string|null, accountEmail?: string, actor?: string, note?: string|null }} input
 */
export async function createApplication(client, input) {
  if (typeof input?.listingId !== 'number') throw new JobSearchError('VALIDATION', 'createApplication: listingId is required');
  const atsType = input.atsType ?? 'unknown';
  if (!ATS_TYPES.includes(atsType)) throw new JobSearchError('VALIDATION', `ats_type must be one of ${ATS_TYPES.join(', ')}`);
  const actor = input.actor ?? 'mcp';
  if (!EVENT_ACTORS.includes(actor)) throw new JobSearchError('VALIDATION', `application event actor must be one of ${EVENT_ACTORS.join(', ')}`);

  return withTransaction(client, async (c) => {
    /** @type {any} */
    let row;
    try {
      const r = await c.query(
        `INSERT INTO ic_job_applications (listing_id, ats_type, apply_url, account_email)
         VALUES ($1, $2, $3, $4) RETURNING ${APPLICATION_COLS}`,
        [input.listingId, atsType, input.applyUrl ?? null, input.accountEmail ?? 'djwmobley@gmail.com'],
      );
      row = r.rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new JobSearchError('VALIDATION', `an active application already exists for listing ${input.listingId}`, {
          details: { listing_id: input.listingId },
        });
      }
      throw err;
    }
    await insertApplicationEvent(c, { applicationId: row.id, kind: 'state', fromState: null, toState: 'drafting', actor, note: input.note ?? null });
    return row;
  });
}

/**
 * Core of every state change. Assumes it is already running inside a transaction (the caller -- transition
 * or one of its wrappers below -- opens it); does the row lock, the TRANSITIONS check, the
 * pending_question rule, the optional attempt increment / expected-from-state guard, and the single
 * atomic UPDATE + event insert.
 *
 * Exported (apply pipeline slice 7, post-review fix) for src/apply/mail-confirm.js: calling the wrapped
 * transition() from a caller that has ALREADY opened its own transaction/savepoint boundary would issue a
 * NESTED BEGIN/COMMIT -- Postgres treats the nested BEGIN as a harmless no-op WARNING, but the matching
 * COMMIT is NOT a no-op, it commits the caller's OUTER boundary early. This is the exact hazard this
 * function's own callers below (approve(), onDocumentLinked(), markSubmittedUnwrapped() via
 * markSubmitted()/markAppliedByHand()) already avoid by calling transitionUnwrapped() directly instead of
 * transition() from inside their own withTransaction() -- mail-confirm.js's confirmation path now follows
 * the identical pattern rather than introducing a second, divergent way to avoid the same bug.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {string} toState
 * @param {{ actor?: string, note?: string|null, meta?: unknown, pending_question?: unknown, error?: string|null }} opts
 * @param {{ incrementAttempt?: boolean, expectedFromState?: string|null, helperName?: string|null, extraSet?: Record<string, unknown> }} extra
 */
export async function transitionUnwrapped(client, id, toState, opts, extra = {}) {
  const { incrementAttempt = false, expectedFromState = null, helperName = null, extraSet = {} } = extra;
  const actor = opts.actor ?? 'mcp';
  if (!EVENT_ACTORS.includes(actor)) {
    throw new JobSearchError('VALIDATION', `application event actor must be one of ${EVENT_ACTORS.join(', ')}`);
  }
  const cur = await client.query(`SELECT ${APPLICATION_COLS} FROM ic_job_applications WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new JobSearchError('NOT_FOUND', `application ${id} not found`);
  const row = cur.rows[0];
  const fromState = row.state;

  if (expectedFromState && fromState !== expectedFromState) {
    throw new JobSearchError('VALIDATION', `${helperName}() requires application ${id} to be in state "${expectedFromState}", it is "${fromState}"`, {
      details: { from: fromState, expected: expectedFromState },
    });
  }
  const allowed = TRANSITIONS[fromState] ?? [];
  if (!allowed.includes(toState)) {
    throw new JobSearchError('VALIDATION', `cannot transition application ${id} from "${fromState}" to "${toState}"`, {
      details: { from: fromState, to: toState },
    });
  }

  let pendingQuestion = row.pending_question;
  if (toState === 'needs_human') {
    validatePendingQuestion(opts.pending_question);
    pendingQuestion = opts.pending_question;
  } else if (fromState === 'needs_human') {
    pendingQuestion = null;
  }

  const error = opts.error !== undefined ? opts.error : row.error;
  const attempt = incrementAttempt ? row.attempt + 1 : row.attempt;

  // submitted_at/confirmed_at are populated here as a natural side effect of entering those states and
  // are never cleared once set. Unlike those two, approved_at is deliberately NOT touched by this slice
  // (A5: "populated at Approve by a later slice; schema ships now") -- the column exists so a later
  // slice's Approve action has somewhere to write it, but nothing in this file ever sets it.
  const submittedAt = toState === 'submitted' ? new Date() : row.submitted_at;
  const confirmedAt = toState === 'confirmed' ? new Date() : row.confirmed_at;

  const setSql = ['state = $2', 'pending_question = $3::jsonb', 'error = $4', 'attempt = $5', 'submitted_at = $6', 'confirmed_at = $7', 'updated_at = now()'];
  const params = /** @type {unknown[]} */ ([
    id, toState, pendingQuestion !== null && pendingQuestion !== undefined ? JSON.stringify(pendingQuestion) : null, error, attempt, submittedAt, confirmedAt,
  ]);
  for (const [col, val] of Object.entries(extraSet)) {
    params.push(val);
    setSql.push(`${col} = $${params.length}`);
  }
  const r = await client.query(`UPDATE ic_job_applications SET ${setSql.join(', ')} WHERE id = $1 RETURNING ${APPLICATION_COLS}`, params);
  await insertApplicationEvent(client, { applicationId: id, kind: 'state', fromState, toState, actor, note: opts.note ?? null, meta: opts.meta });
  return r.rows[0];
}

/**
 * General-purpose transition, validated against the frozen TRANSITIONS map. Runs inside its own
 * transaction with `SELECT ... FOR UPDATE` on the application row; writes the row update and exactly one
 * `ic_job_application_events` row (kind 'state') atomically (A9).
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {string} toState
 * @param {{ actor?: string, note?: string|null, meta?: unknown, pending_question?: unknown, error?: string|null }} [opts]
 */
export async function transition(client, id, toState, opts = {}) {
  return withTransaction(client, (c) => transitionUnwrapped(c, id, toState, opts, {}));
}

/**
 * needs_human -> approved ("Resume" in the dashboard credential/question prompt), incrementing `attempt`.
 * Rejects with VALIDATION if the application is not currently in needs_human (rather than silently
 * falling through to TRANSITIONS' own less specific rejection).
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ actor?: string, note?: string|null, meta?: unknown }} [opts]
 */
export async function resume(client, id, opts = {}) {
  return withTransaction(client, (c) => transitionUnwrapped(c, id, 'approved', opts, {
    incrementAttempt: true, expectedFromState: 'needs_human', helperName: 'resume',
  }));
}

/**
 * failed -> approved ("Retry" in the dashboard), incrementing `attempt`. Rejects with VALIDATION if the
 * application is not currently 'failed'.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ actor?: string, note?: string|null, meta?: unknown }} [opts]
 */
export async function retry(client, id, opts = {}) {
  return withTransaction(client, (c) => transitionUnwrapped(c, id, 'approved', opts, {
    incrementAttempt: true, expectedFromState: 'failed', helperName: 'retry',
  }));
}

/**
 * Reacts to a document being linked to a listing (A11). A strict no-op -- `{ ignored: true, reason }` --
 * unless an application for that listing exists AND is currently 'drafting': never overwrites doc links
 * after drafting (protects the DOCX hash the Approve step will compare against later), and never acts on
 * a listing with no application at all or one that has moved on/been withdrawn.
 *
 * Cross-listing integrity: verifies the referenced ic_job_documents row's own listing_id equals the
 * application's listing_id before linking, so a caller cannot (accidentally or otherwise) attach a
 * document that belongs to a different listing's resume/cover-letter to this application.
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {'resume'|'coverletter'|string} docKind
 * @param {number} docId
 * @param {{ actor?: string }} [opts]
 */
export async function onDocumentLinked(client, listingId, docKind, docId, opts = {}) {
  const actor = opts.actor ?? 'mcp';
  return withTransaction(client, async (c) => {
    const appRes = await c.query(
      `SELECT ${APPLICATION_COLS} FROM ic_job_applications WHERE listing_id = $1 AND state <> 'withdrawn' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [listingId],
    );
    if (appRes.rowCount === 0) return { ignored: true, reason: 'no_application' };
    const app = appRes.rows[0];
    if (app.state !== 'drafting') return { ignored: true, reason: 'not_drafting' };
    if (docKind !== 'resume' && docKind !== 'coverletter') return { ignored: true, reason: 'unsupported_doc_kind' };

    const docRes = await c.query('SELECT listing_id FROM ic_job_documents WHERE id = $1', [docId]);
    if (docRes.rowCount === 0) throw new JobSearchError('VALIDATION', `document ${docId} not found`);
    const docListingId = Number(docRes.rows[0].listing_id);
    if (docListingId !== Number(listingId)) {
      throw new JobSearchError('VALIDATION', `document ${docId} belongs to listing ${docListingId}, not listing ${listingId}`, {
        details: { document_listing_id: docListingId, listing_id: listingId },
      });
    }

    const col = docKind === 'resume' ? 'resume_doc_id' : 'coverletter_doc_id';
    await c.query(`UPDATE ic_job_applications SET ${col} = $2, updated_at = now() WHERE id = $1`, [app.id, docId]);

    if (docKind === 'resume') {
      const updated = await transitionUnwrapped(c, app.id, 'docs_ready', { actor, note: `resume linked (document ${docId})` }, {});
      return { ignored: false, application: updated };
    }
    const refreshed = await c.query(`SELECT ${APPLICATION_COLS} FROM ic_job_applications WHERE id = $1`, [app.id]);
    return { ignored: false, application: refreshed.rows[0] };
  });
}

/**
 * Core of markSubmitted() (below) and markAppliedByHand() (apply pipeline slice 5): both need the SAME
 * "transition to submitted + conditionally mark the listing applied" logic to run inside ONE already-open
 * transaction (markAppliedByHand additionally validates its own from-state before this runs) -- the same
 * "call the *Unwrapped core directly, never the withTransaction-wrapped export, from inside an existing
 * transaction" pattern approve() above uses for the identical reason (a nested BEGIN would otherwise
 * silently create a savepoint-less sub-transaction and break atomicity).
 * @param {import('pg').ClientBase} client already inside a transaction
 * @param {number} id
 * @param {{ confirmationRef?: string|null, actor?: string, note?: string|null, meta?: unknown }} opts
 */
async function markSubmittedUnwrapped(client, id, opts) {
  const actor = opts.actor ?? 'apply';
  const row = await transitionUnwrapped(client, id, 'submitted', { actor, note: opts.note, meta: opts.meta }, {
    extraSet: { confirmation_ref: opts.confirmationRef ?? null },
  });
  const listingRes = await client.query('SELECT status, company, title FROM ic_job_listings WHERE id = $1', [row.listing_id]);
  const currentStatus = listingRes.rowCount ? listingRes.rows[0].status : null;
  if (isPreApplicationStatus(currentStatus)) {
    await applyMark(client, { id: row.listing_id, status: 'applied' }, { now: new Date(), explicit: true, actor: 'apply' });
  } else {
    await insertApplicationEvent(client, {
      applicationId: id, kind: 'note', actor,
      note: `listing status left at "${currentStatus}" (not pre-application); not overwritten with "applied"`,
    });
  }

  // Apply pipeline slice 7, amended spec (decision 5): the 5-day nudge is created UNCONDITIONALLY on
  // every submitted transition -- this is the documented mitigation for the mail classifier's sender/
  // keyword-query blind spot (src/apply/mail-confirm.js): if the classifier never sees the confirmation
  // mail, the nudge still fires. Runs inside the SAME transaction as the transition above (this function
  // is always called from within an open transaction -- see markSubmitted()/markAppliedByHand() below --
  // so there is never a window where an application is 'submitted' without its nudge already existing).
  // The state machine guarantees this fires at most once per application (see TRANSITIONS: 'submitted'
  // has no outgoing edge back to 'submitting', so an application reaches 'submitted' at most once in its
  // lifetime), so no de-duplication guard is needed here.
  const listingRow = listingRes.rowCount ? listingRes.rows[0] : null;
  const company = listingRow && listingRow.company ? String(listingRow.company) : null;
  const title = listingRow && listingRow.title ? String(listingRow.title) : null;
  const dueAt = new Date(/** @type {Date} */ (row.submitted_at).getTime() + APPLY_NUDGE_DAYS * 24 * 60 * 60 * 1000);
  await createFollowup(client, {
    contact: company ?? 'Unknown company',
    org: company ?? null,
    listing_id: row.listing_id,
    due_at: dueAt.toISOString(),
    channel: 'other',
    action: `Check application status${title ? ` for ${title}` : ''}: no confirmation email received within ${APPLY_NUDGE_DAYS} days of submitting.`,
    notify: ['email'],
    created_from: `${APPLY_NUDGE_PREFIX}${id}`,
  });

  return row;
}

/**
 * submitting -> submitted (A12). After the state transition, updates the listing's own status to
 * 'applied' via the same applyMark() helper the dashboard uses (actor 'apply', explicit: true) -- but
 * ONLY when the listing's current status is a pre-application status (see isPreApplicationStatus above).
 * When it is not, the listing status is left untouched and a 'note' event records why, rather than
 * silently doing nothing or silently overwriting operator-set state.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ confirmationRef?: string|null, actor?: string, note?: string|null, meta?: unknown }} [opts]
 */
export async function markSubmitted(client, id, opts = {}) {
  return withTransaction(client, (c) => markSubmittedUnwrapped(c, id, opts));
}

/**
 * Records the durable "submit_request_sent" marker (apply pipeline slice 5, amended spec: "Record a
 * submit_request_sent event BEFORE the final submit POST leaves. Any abort/crash after that event ->
 * needs_human, NEVER a retryable failed (duplicate-application guard)"). A plain 'progress' event
 * (APPLICATION_EVENT_KINDS already includes it), written on its own -- NOT wrapped in withTransaction --
 * so the write commits immediately and independently of whatever happens next in the worker: a hard crash
 * a millisecond after this call still leaves the durable row behind for hasSubmitRequestSentThisAttempt()/
 * reconcileStale() to find on the next process start. Called by src/apply/worker.js immediately before an
 * adapter's final submit click.
 * @param {import('pg').ClientBase} client
 * @param {number} applicationId
 */
export async function recordSubmitRequestSent(client, applicationId) {
  await client.query(
    `INSERT INTO ic_job_application_events (application_id, kind, actor, note) VALUES ($1, 'progress', 'apply', 'submit_request_sent')`,
    [applicationId],
  );
}

/**
 * Whether recordSubmitRequestSent() fired during the application's CURRENT 'submitting' attempt --
 * scoped to events created at or after the most recent state-transition-into-submitting event, so a stale
 * submit_request_sent event left over from an EARLIER attempt (Retry/Resume increments `attempt` and
 * re-enters 'submitting' from scratch) never leaks into this attempt's crash-safety decision. No rows in
 * ic_job_application_events at all for this application -> false (an application that never reached
 * 'submitting' obviously never sent a submit request).
 * @param {import('pg').ClientBase} client
 * @param {number} applicationId
 * @returns {Promise<boolean>}
 */
export async function hasSubmitRequestSentThisAttempt(client, applicationId) {
  const since = await client.query(
    `SELECT created_at FROM ic_job_application_events WHERE application_id = $1 AND kind = 'state' AND to_state = 'submitting' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [applicationId],
  );
  if (since.rowCount === 0) return false;
  const r = await client.query(
    `SELECT 1 FROM ic_job_application_events WHERE application_id = $1 AND kind = 'progress' AND note = 'submit_request_sent' AND created_at >= $2 LIMIT 1`,
    [applicationId, since.rows[0].created_at],
  );
  return r.rowCount > 0;
}

/**
 * Moves every application stuck in 'submitting' for longer than `maxAgeMinutes` on (A13). Amended by
 * apply pipeline slice 5's duplicate-application guard: a stale row whose CURRENT attempt already recorded
 * "submit_request_sent" (hasSubmitRequestSentThisAttempt above) goes to 'needs_human' with a
 * pending_question asking Damian to verify manually, never 'failed' -- retrying a 'failed' application
 * resubmits the form from scratch, which after a submit request has actually left the browser risks a
 * second, duplicate application at the ATS. A stale row that never got that far (worker died, or was
 * still filling the form) goes to 'failed' exactly as before this slice -- the pre-existing test coverage
 * for that path (test/applications.test.js) is unchanged by this addition. bin/apply.js calls this at
 * worker startup (this is that "later slice" the original doc comment referred to).
 * @param {import('pg').ClientBase} client
 * @param {{ maxAgeMinutes?: number }} [opts]
 */
export async function reconcileStale(client, opts = {}) {
  const maxAgeMinutes = opts.maxAgeMinutes ?? 10;
  return withTransaction(client, async (c) => {
    const stale = await c.query(
      `SELECT id FROM ic_job_applications WHERE state = 'submitting' AND updated_at < now() - ($1 || ' minutes')::interval FOR UPDATE`,
      [maxAgeMinutes],
    );
    const results = [];
    for (const staleRow of stale.rows) {
      const sent = await hasSubmitRequestSentThisAttempt(c, staleRow.id);
      if (sent) {
        results.push(await transitionUnwrapped(c, staleRow.id, 'needs_human', {
          actor: 'apply',
          note: 'stale submitting reconciled after submit request was sent; verify manually before retrying',
          pending_question: {
            kind: 'post_submit_uncertain',
            label: 'The submit request was sent but the run did not confirm completion (crash or timeout). Check the site or your email for a confirmation before retrying, to avoid a duplicate application.',
          },
        }, {}));
      } else {
        results.push(await transitionUnwrapped(c, staleRow.id, 'failed', {
          actor: 'apply', note: 'stale submitting reconciled', error: 'stale submitting reconciled',
        }, {}));
      }
    }
    return results;
  });
}

/**
 * needs_human -> submitted ("I applied by hand" in the dashboard's needs_human card, plan section 7 /
 * src/core/applications.js's own module doc comment on this exact edge). Rejects with VALIDATION if the
 * application is not currently 'needs_human'. Does NOT increment `attempt` (unlike resume()/retry()): this
 * is not a re-entry into the automated flow, it is the human declaring the flow finished outside it.
 * markSubmitted()'s own listing-status side effect (mark the listing 'applied' when it is still in a
 * pre-application status) applies here identically, via the same helper.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ actor?: string, note?: string|null }} [opts]
 */
export async function markAppliedByHand(client, id, opts = {}) {
  return withTransaction(client, async (c) => {
    const cur = await c.query(`SELECT ${APPLICATION_COLS} FROM ic_job_applications WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.rowCount === 0) throw new JobSearchError('NOT_FOUND', `application ${id} not found`);
    if (cur.rows[0].state !== 'needs_human') {
      throw new JobSearchError('VALIDATION', `markAppliedByHand() requires application ${id} to be in state "needs_human", it is "${cur.rows[0].state}"`, {
        details: { from: cur.rows[0].state, expected: 'needs_human' },
      });
    }
    return markSubmittedUnwrapped(c, id, { ...opts, note: opts.note ?? 'marked applied by hand' });
  });
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} id
 */
export async function getApplication(client, id) {
  const r = await client.query(`SELECT ${APPLICATION_COLS} FROM ic_job_applications WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new JobSearchError('NOT_FOUND', `application ${id} not found`);
  return r.rows[0];
}

/**
 * The application a listing detail page (or the Approve route) cares about: the most recent non-
 * withdrawn application for the listing, or null when none exists. Mirrors onDocumentLinked's own
 * "most recent non-withdrawn" lookup (A6's partial unique index only ever allows one active application
 * per listing at a time, but a withdrawn-then-recreated history can leave more than one row).
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @returns {Promise<any|null>}
 */
export async function getApplicationForListing(client, listingId) {
  const r = await client.query(
    `SELECT ${APPLICATION_COLS} FROM ic_job_applications WHERE listing_id = $1 AND state <> 'withdrawn' ORDER BY id DESC LIMIT 1`,
    [listingId],
  );
  return r.rowCount === 0 ? null : r.rows[0];
}

/**
 * sha256 hex digest of a document already linked under outputRoot, resolved through
 * documents.resolveOutputPath's own safe-path rules (never a raw fs.readFileSync on a caller-supplied
 * path). Used only by approve() below.
 * @param {string} outputRoot
 * @param {string} relPath
 * @returns {string}
 */
function hashOutputFile(outputRoot, relPath) {
  const resolved = resolveOutputPath(outputRoot, relPath);
  if (!resolved.ok) throw new JobSearchError('VALIDATION', `cannot hash document: ${resolved.reason}`, { details: { reason: resolved.reason } });
  return crypto.createHash('sha256').update(fs.readFileSync(resolved.absPath)).digest('hex');
}

/**
 * docs_ready -> approved ("Approve" in the dashboard, plan section 7 / section 1's "Store the DOCX hash
 * at Approve"). Everything happens inside ONE transaction (the plan's explicit requirement): validate
 * the application is in docs_ready with a linked resume, hash the linked resume DOCX (and cover letter,
 * if linked) via documents.resolveOutputPath's safe path resolution, transition to 'approved', and store
 * resume_hash/coverletter_hash/approved_at on the SAME row UPDATE the transition itself performs (via
 * transitionUnwrapped's extraSet -- never a second, separately-committed UPDATE after the transition).
 *
 * This slice ships the only writer of approved_at in the whole apply pipeline: transitionUnwrapped's own
 * doc comment on submitted_at/confirmed_at notes "approved_at is deliberately NOT touched by this slice
 * -- the column exists so a later slice's Approve action has somewhere to write it." This is that slice.
 *
 * Deliberately calls transitionUnwrapped directly rather than the exported transition() helper:
 * transition() opens its own withTransaction, which would nest a second BEGIN inside this function's
 * own and break the "same transaction" requirement for the hash writes.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ outputRoot: string, actor?: string, note?: string|null }} opts
 */
export async function approve(client, id, opts) {
  const actor = opts.actor ?? 'dashboard';
  return withTransaction(client, async (c) => {
    const cur = await c.query(`SELECT ${APPLICATION_COLS} FROM ic_job_applications WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.rowCount === 0) throw new JobSearchError('NOT_FOUND', `application ${id} not found`);
    const row = cur.rows[0];
    if (row.state !== 'docs_ready') {
      throw new JobSearchError('VALIDATION', `approve() requires application ${id} to be in state "docs_ready", it is "${row.state}"`, {
        details: { from: row.state, expected: 'docs_ready' },
      });
    }
    if (!row.resume_doc_id) {
      throw new JobSearchError('VALIDATION', `approve() requires application ${id} to have a linked resume document`);
    }
    const resumeDoc = await c.query('SELECT rel_path FROM ic_job_documents WHERE id = $1', [row.resume_doc_id]);
    if (resumeDoc.rowCount === 0) throw new JobSearchError('NOT_FOUND', `document ${row.resume_doc_id} not found`);
    const resumeHash = hashOutputFile(opts.outputRoot, resumeDoc.rows[0].rel_path);
    let coverletterHash = null;
    if (row.coverletter_doc_id) {
      const clDoc = await c.query('SELECT rel_path FROM ic_job_documents WHERE id = $1', [row.coverletter_doc_id]);
      if (clDoc.rowCount === 0) throw new JobSearchError('NOT_FOUND', `document ${row.coverletter_doc_id} not found`);
      coverletterHash = hashOutputFile(opts.outputRoot, clDoc.rows[0].rel_path);
    }
    return transitionUnwrapped(c, id, 'approved', { actor, note: opts.note ?? 'approved in dashboard' }, {
      extraSet: { resume_hash: resumeHash, coverletter_hash: coverletterHash, approved_at: new Date() },
    });
  });
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} applicationId
 */
export async function listApplicationEvents(client, applicationId) {
  const r = await client.query(
    `SELECT id, application_id, kind, from_state, to_state, actor, note, meta, created_at
     FROM ic_job_application_events WHERE application_id = $1 ORDER BY created_at ASC, id ASC`,
    [applicationId],
  );
  return r.rows;
}
