// @ts-check
/**
 * Mail confirmation job (apply pipeline slice 7, plan `let-s-brainstorm-a-bit-humble-umbrella.md`
 * section "6. Confirmation tracking", amended by the slice-7 spec-adversary pass -- see the PR body for
 * the full list of amendments). DB- and Gmail-aware orchestration around the pure classifier in
 * mail-classifier.js: watches the owner's Gmail inbox for application-related mail, flips
 * submitted -> confirmed on a matched confirmation, and routes a matched rejection/position-closed mail
 * to the review queue. NEVER writes the listing `lost` status or any other automatic state itself --
 * received -> confirmed is the ONLY automatic transition this job performs (amended decision 1).
 *
 * Auth reuses src/core/google.js exactly the way src/apply/gmail-verify.js and src/adapters/gmail.js
 * already do: classifyAndConnect() with need: {gmailRead: true}, a plain GET against the Gmail REST
 * endpoints, and a total, never-throwing failure classification on any auth problem.
 *
 * CANDIDATE POOL (amended decision 3): built ONCE per run from `submitted` and `confirmed`
 * applications. A 'received' mail is only ever matched against the `submitted` subset (a 'confirmed'
 * application has nothing left to confirm); a 'rejected'/'closed' mail is matched against BOTH --
 * confirmed UNION submitted -- because a rejection can legitimately arrive after an earlier confirmation
 * mail already flipped the row, and that must still be visible (routed to review), never silently
 * dropped just because the automatic transition already happened.
 *
 * AMBIGUITY (amended decision 3): a company_norm match against more than one candidate application is
 * NEVER resolved by guessing (not by title similarity, not by "most recent", nothing) -- it is logged and,
 * for rejected/closed mail, every ambiguous candidate's LISTING is routed to review so a human resolves
 * it (each entry's `matches` names the sibling candidate listing ids). This is also how the plan's
 * "forwarded thank-you for a different role at the same company" classifier trap is handled: two
 * `submitted` applications for the same company_norm make a 'received' mail ambiguous -- no automatic
 * confirmation of either -- rather than confirming whichever happens to be found first.
 *
 * IDEMPOTENCY (amended decision 6): ic_gmail_processed_messages is checked before a message is acted on
 * and written only once its outcome is fully applied, so a message already handled in an earlier run is
 * never re-classified or re-applied. See sql/013_confirm_mail.sql's own doc comment for the crash-safety
 * argument. The MECHANISM differs by path, because a crash between an effect committing and the ledger
 * row committing (there is no single wrapping transaction across the whole job -- messages are handled
 * one at a time, each free to commit independently) has a different consequence on each path:
 *   - received -> confirmed: the state transition (submitted -> confirmed) IS the dedup guard. Once
 *     confirmed, the application drops out of the `submitted` candidate pool loadCandidates()/
 *     matchCandidates() build for the NEXT run, so a replayed message finds zero matches and is a
 *     harmless no-op (recorded `no_match`, not a second confirmation). RESIDUAL GAP: if the crash lands
 *     between transition()'s own commit and completeNudge()'s commit, the 5-day nudge follow-up is never
 *     completed on replay either (the application already dropped out of the pool) -- a stale "check
 *     status" reminder for an application that did confirm, cosmetic, not a data-integrity violation.
 *   - rejected/closed -> review: unlike the received path, re-entering 'review' is NOT self-guarding by
 *     status alone (the listing's status is already 'review' either way). routeListingToReview() below
 *     therefore (a) skips its own status UPDATE/recordEvent when the listing is ALREADY 'review' (a
 *     replay, or an unrelated review reason already in place, both look identical from here), and (b)
 *     checks for an existing OPEN ic_job_review_queue row for the candidate before inserting a new one --
 *     mirroring bin/migrate.js's own guard for the exact same invariant (sql/004_review_queue.sql: "every
 *     status='review' listing has exactly one open queue row", checked by queueInvariant()/--check).
 *     Each message's effects PLUS its ledger write are additionally wrapped in one transaction
 *     (withTransaction below), so a genuine crash mid-message leaves NEITHER committed, not a partial
 *     state the guard has to clean up after the fact -- the guard is defense in depth for the case a
 *     message is legitimately replayed for another reason (e.g. an operator re-running a --dry-run
 *     rehearsal against a real ledger, or a future caller that does not go through this one transaction),
 *     not the only thing standing between this job and a duplicate queue row.
 */
import { classifyAndConnect } from '../core/google.js';
import { transition, getApplication, APPLY_NUDGE_PREFIX } from '../core/applications.js';
import { completeFollowup } from '../core/followups.js';
import { recordEvent } from '../core/events.js';
import { enqueueReview } from '../core/upsert.js';
import { withTransaction } from '../core/db.js';
import { JobSearchError } from '../core/errors.js';
import { classifyApplicationMail, mailUrlContradictsCandidate } from './mail-classifier.js';

export const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
/** How far back the Gmail search looks. Decoupled from the 5-day nudge window on purpose: a mail that
 * arrives on day 6 (after the nudge already fired) must still be found and processed. */
export const MAILBOX_WINDOW_DAYS = 21;
const LIST_PAGE_SIZE = 50;
const MAX_PAGES = 3;

/**
 * base64url (Gmail body.data) -> utf8 text. Duplicated from src/adapters/gmail.js / src/apply/gmail-verify.js
 * deliberately (both of those already duplicate this same ~3-line decode rather than share it across the
 * scan/apply boundary -- see gmail-verify.js's own doc comment for the rationale this module follows too).
 * @param {string} s
 */
function base64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * @param {any} payload
 * @param {string} name
 * @returns {string|null}
 */
function headerValue(payload, name) {
  const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
  const h = headers.find((/** @type {any} */ x) => String(x.name ?? '').toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : null;
}

/** The display-name portion of a From header ("Acme Careers <hr@acme.com>" -> "Acme Careers"), or null. */
function fromDisplayName(fromHeader) {
  if (!fromHeader) return null;
  const m = /^([^<]+)<[^>]+>$/.exec(fromHeader.trim());
  const name = m ? m[1].trim().replace(/^"|"$/g, '') : null;
  return name && name.length ? name : null;
}

/**
 * Recursively walk a Gmail message payload to any depth, collecting the first text/plain and first
 * text/html leaf found. Duplicated from src/adapters/gmail.js / gmail-verify.js (same rationale).
 * @param {any} part
 * @param {{ text: string|null, html: string|null }} out
 */
function collectBodyParts(part, out) {
  if (!part) return;
  if (part.mimeType === 'text/plain' && !out.text && part.body && typeof part.body.data === 'string') {
    out.text = base64urlDecode(part.body.data);
  }
  if (part.mimeType === 'text/html' && !out.html && part.body && typeof part.body.data === 'string') {
    out.html = base64urlDecode(part.body.data);
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectBodyParts(p, out);
  }
}

/**
 * Candidate applications for correlation: every `submitted` or `confirmed` application, joined to its
 * listing's company_norm/company/title/status and the application's own apply_url (for the URL-veto
 * check in mail-classifier.js's mailUrlContradictsCandidate).
 * @param {import('pg').ClientBase} client
 * @returns {Promise<Array<{ application_id: number, listing_id: number, state: string, apply_url: string|null, company: string|null, company_norm: string|null, title: string|null, listing_status: string|null }>>}
 */
async function loadCandidates(client) {
  const r = await client.query(
    `SELECT a.id AS application_id, a.listing_id, a.state, a.apply_url,
            l.company, l.company_norm, l.title, l.status AS listing_status
     FROM ic_job_applications a
     JOIN ic_job_listings l ON l.id = a.listing_id
     WHERE a.state = ANY($1::text[])`,
    [['submitted', 'confirmed']],
  );
  return r.rows.map((row) => ({
    application_id: Number(row.application_id),
    listing_id: Number(row.listing_id),
    state: row.state,
    apply_url: row.apply_url,
    company: row.company,
    company_norm: row.company_norm,
    title: row.title,
    listing_status: row.listing_status,
  }));
}

/**
 * Company_norm match within `pool`, with the URL-veto check applied (classifier traps). Never guesses:
 * returns the matches array as-is (0, 1, or many) for the caller to branch on.
 * @param {Array<ReturnType<typeof loadCandidates> extends Promise<infer T> ? T[number] : never>} pool
 * @param {string} companyNorm
 * @param {string} mailText
 */
function matchCandidates(pool, companyNorm, mailText) {
  if (!companyNorm) return [];
  return pool.filter((c) => c.company_norm === companyNorm && !mailUrlContradictsCandidate(mailText, c.apply_url));
}

/**
 * Route one listing to the review queue with a mail-sourced reason (amended decision 2: a rejection or
 * closed mail NEVER writes a status transition other than 'review' -- confirmed/lost/anything else is
 * never touched here). Mirrors the direct recordEvent + enqueueReview pattern src/core/upsert.js already
 * uses for its own review-routing (applyMark's OWN internal review branch is deliberately NOT reused
 * here -- see the PR body's "spec deviations" section for why: that branch hardcodes reason
 * 'propagation_conflict' and only fires when the row's marked_at is already set, neither of which fits a
 * mail-sourced reason).
 *
 * INVARIANT GUARD (sql/004_review_queue.sql: "every status='review' listing has exactly one open queue
 * row", enforced by bin/migrate.js's queueInvariant()/--check): two separate no-ops protect it, both
 * mirroring bin/migrate.js's own established pattern for the identical invariant (see that file's
 * title_renormalized and legacy_url_conflict/legacy_ext_conflict backfills) --
 *   (1) the status UPDATE + its recordEvent are skipped entirely when the listing is ALREADY 'review'
 *       (nothing changed, so nothing to log -- matches src/tools/mark_jobs.js's applyMark's own "one
 *       event per field that actually changed" rule);
 *   (2) the queue INSERT is skipped when an OPEN row already exists for this candidate_id, regardless of
 *       ITS reason -- a row already queued for an unrelated reason (e.g. a scan-side dedup ambiguity)
 *       must not get a second, competing queue entry either, exactly bin/migrate.js's own comment on its
 *       identical check ("not just one with reason=X").
 * This makes routeListingToReview() itself idempotent under replay (called twice for the same listing
 * with the caller never checking for that itself). The caller (handleMessage) additionally wraps each
 * message's calls here PLUS its ic_gmail_processed_messages ledger write in one transaction, so replay
 * only happens at all if this function is invoked outside that transaction wrap for some other reason --
 * this guard is defense in depth, not the sole mechanism (see the module doc comment's IDEMPOTENCY
 * section).
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, reason: 'mail_rejected'|'mail_closed', matches: number[], note: string }} o
 * @returns {Promise<number|null>} the review-queue row id (existing or newly created), or null if the
 *   listing no longer exists
 */
async function routeListingToReview(client, o) {
  const cur = await client.query('SELECT status FROM ic_job_listings WHERE id = $1 FOR UPDATE', [o.listingId]);
  if (cur.rowCount === 0) return null;
  const fromStatus = cur.rows[0].status ?? null;
  if (fromStatus !== 'review') {
    await client.query(`UPDATE ic_job_listings SET status = 'review' WHERE id = $1`, [o.listingId]);
    await recordEvent(client, { listingId: o.listingId, kind: 'status', fromStatus, toStatus: 'review', note: o.note, actor: 'apply', runId: null });
  }
  const already = await client.query(`SELECT id FROM ic_job_review_queue WHERE resolved_at IS NULL AND candidate_id = $1`, [o.listingId]);
  if (already.rowCount > 0) return Number(already.rows[0].id);
  const queued = await enqueueReview(client, { runId: null, candidate: null, candidateId: o.listingId, matches: o.matches, reason: o.reason, statusAtCreate: fromStatus });
  return queued;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {string} messageId
 */
async function alreadyProcessed(client, messageId) {
  const r = await client.query('SELECT 1 FROM ic_gmail_processed_messages WHERE message_id = $1', [messageId]);
  return r.rowCount > 0;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ messageId: string, kind: string, companyRaw: string|null, companyNorm: string|null, applicationId: number|null, outcome: string, note?: string|null }} o
 */
async function recordProcessed(client, o) {
  await client.query(
    `INSERT INTO ic_gmail_processed_messages (message_id, kind, company_raw, company_norm, application_id, outcome, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id) DO NOTHING`,
    [o.messageId, o.kind, o.companyRaw, o.companyNorm || null, o.applicationId, o.outcome, o.note ?? null],
  );
}

/**
 * Complete the unconditional 5-day nudge follow-up correlated to `applicationId` (created_from =
 * `apply-nudge:<id>`), if one is still open/snoozed. Best-effort: a completion failure is logged and
 * swallowed, never allowed to undo the confirmation transition that already committed (mirrors
 * createFollowup's own "calendar failure is a warning, not a throw" posture for the SAME reason -- the
 * follow-up bookkeeping must never be able to roll back the fact that the application confirmed).
 * @param {import('pg').ClientBase} client
 * @param {number} applicationId
 * @param {(fields: Record<string, unknown>) => void} logError
 */
async function completeNudge(client, applicationId, logError) {
  try {
    const r = await client.query(
      `SELECT id FROM ic_followups WHERE created_from = $1 AND status IN ('open', 'snoozed') ORDER BY id ASC LIMIT 1`,
      [`${APPLY_NUDGE_PREFIX}${applicationId}`],
    );
    if (r.rowCount === 0) return;
    await completeFollowup(client, Number(r.rows[0].id));
  } catch (err) {
    logError({ evt: 'confirm_nudge_complete_failed', application_id: applicationId, ...errFieldsLite(err) });
  }
}

/** Local, dependency-free version of core/errors.js's errFields (avoids importing it just for this one log line). */
function errFieldsLite(err) {
  const message = err && typeof err === 'object' && 'message' in err ? String(/** @type {any} */ (err).message) : String(err);
  return { err_message: message.slice(0, 300) };
}

/**
 * Handle one already-fetched, already-decoded message. Returns the outcome string recorded to
 * ic_gmail_processed_messages, or throws (the caller decides whether to record `unknown`/skip on error --
 * see runMailConfirm's per-message try/catch).
 * @param {import('pg').ClientBase} client
 * @param {{ messageId: string, subject: string, text: string, html: string, fromName: string|null }} msg
 * @param {Awaited<ReturnType<typeof loadCandidates>>} candidates
 * @param {(fields: Record<string, unknown>) => void} log
 * @param {(fields: Record<string, unknown>) => void} logError
 */
async function handleMessage(client, msg, candidates, log, logError) {
  const classified = classifyApplicationMail({ subject: msg.subject, text: msg.text, html: msg.html, fromName: msg.fromName });
  const mailText = `${msg.subject}\n${msg.text}\n${msg.html}`;
  log({ evt: 'confirm_message_classified', message_id: msg.messageId, kind: classified.kind, company_raw: classified.company_raw, company_norm: classified.company_norm });

  if (classified.kind === 'unknown') {
    await recordProcessed(client, { messageId: msg.messageId, kind: 'unknown', companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId: null, outcome: 'unknown' });
    return 'unknown';
  }

  if (classified.kind === 'received') {
    const pool = candidates.filter((c) => c.state === 'submitted');
    const matches = matchCandidates(pool, classified.company_norm, mailText);
    if (matches.length === 0) {
      await recordProcessed(client, { messageId: msg.messageId, kind: 'received', companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId: null, outcome: 'no_match' });
      return 'no_match';
    }
    if (matches.length > 1) {
      await recordProcessed(client, {
        messageId: msg.messageId, kind: 'received', companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId: null,
        outcome: 'ambiguous_received', note: `${matches.length} candidates: application ids ${matches.map((m) => m.application_id).join(',')}`,
      });
      return 'ambiguous_received';
    }
    const applicationId = matches[0].application_id;
    const fresh = await getApplication(client, applicationId);
    if (fresh.state === 'confirmed') {
      await completeNudge(client, applicationId, logError);
      await recordProcessed(client, { messageId: msg.messageId, kind: 'received', companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId, outcome: 'already_confirmed' });
      return 'already_confirmed';
    }
    if (fresh.state !== 'submitted') {
      // Race: the row moved on (e.g. withdrawn) between loadCandidates() and now. Never a guessed action.
      await recordProcessed(client, { messageId: msg.messageId, kind: 'received', companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId, outcome: `skipped_state_${fresh.state}` });
      return `skipped_state_${fresh.state}`;
    }
    await transition(client, applicationId, 'confirmed', {
      actor: 'apply', note: 'confirmed via mail classifier',
      meta: { message_id: msg.messageId, company_raw: classified.company_raw, company_norm: classified.company_norm, matched_phrase: classified.matchedPhrase },
    });
    await completeNudge(client, applicationId, logError);
    await recordProcessed(client, { messageId: msg.messageId, kind: 'received', companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId, outcome: 'confirmed' });
    return 'confirmed';
  }

  // rejected / closed (amended decision 2 and 3): pool is submitted UNION confirmed (all of `candidates`).
  const reason = classified.kind === 'rejected' ? 'mail_rejected' : 'mail_closed';
  const matches = matchCandidates(candidates, classified.company_norm, mailText);
  if (matches.length === 0) {
    await recordProcessed(client, { messageId: msg.messageId, kind: classified.kind, companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId: null, outcome: 'no_match' });
    return 'no_match';
  }
  // Crash-safety fix (review-queue invariant, sql/004_review_queue.sql / bin/migrate.js's
  // queueInvariant()): every routeListingToReview() call PLUS the ic_gmail_processed_messages ledger
  // write for this message are committed as ONE transaction, so a crash mid-message leaves either
  // NOTHING committed (safely retried next run, routeListingToReview()'s own guard makes the retry a
  // no-op even if it were not) or EVERYTHING committed (the ledger row makes the next run skip it
  // entirely via alreadyProcessed()) -- never effects-committed-without-the-ledger-row, which is exactly
  // the gap that let a replay insert a second open queue row for the same listing.
  if (matches.length === 1) {
    const m = matches[0];
    return withTransaction(client, async (c) => {
      await routeListingToReview(c, { listingId: m.listing_id, reason, matches: [], note: `${reason}: ${classified.matchedPhrase ?? ''}`.slice(0, 200) });
      await recordProcessed(c, { messageId: msg.messageId, kind: classified.kind, companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId: m.application_id, outcome: 'routed_review' });
      return 'routed_review';
    });
  }
  // Ambiguous (amended decision 3): route EVERY candidate listing to review, each naming its siblings in
  // `matches`, so a human resolves which one the mail was actually about -- never a guess. All of it
  // (every listing's routing plus the ledger write) is one transaction, same rationale as above.
  return withTransaction(client, async (c) => {
    for (const m of matches) {
      const siblingListingIds = matches.filter((x) => x.listing_id !== m.listing_id).map((x) => x.listing_id);
      await routeListingToReview(c, { listingId: m.listing_id, reason, matches: siblingListingIds, note: `ambiguous ${reason} (${matches.length} candidates): ${classified.matchedPhrase ?? ''}`.slice(0, 200) });
    }
    await recordProcessed(c, {
      messageId: msg.messageId, kind: classified.kind, companyRaw: classified.company_raw, companyNorm: classified.company_norm, applicationId: null,
      outcome: 'ambiguous_review', note: `${matches.length} candidates: application ids ${matches.map((m) => m.application_id).join(',')}`,
    });
    return 'ambiguous_review';
  });
}

/**
 * @typedef {Object} RunMailConfirmResult
 * @property {boolean} ok
 * @property {number} code 0 ok, 1 auth or fatal failure
 * @property {string|null} google_auth_state classification slug (mirrors runRemind's own field), or null on success
 * @property {number} candidates
 * @property {number} messages_seen
 * @property {number} already_processed
 * @property {Record<string, number>} outcomes outcome string -> count
 * @property {string|null} reason set only on a non-auth early exit (e.g. no candidates)
 */

/**
 * @param {{ client: import('pg').ClientBase, tokenFile: string|null|undefined, fetch?: typeof fetch,
 *   now?: Date, windowDays?: number, log?: (f: Record<string, unknown>) => void, logError?: (f: Record<string, unknown>) => void,
 *   deps?: { readTokenFile?: Function, makeOAuthClient?: Function, getAccessToken?: Function } }} o
 * @returns {Promise<RunMailConfirmResult>}
 */
export async function runMailConfirm(o) {
  const log = o.log ?? (() => {});
  const logError = o.logError ?? (() => {});
  const fetchFn = o.fetch ?? fetch;
  const windowDays = o.windowDays ?? MAILBOX_WINDOW_DAYS;

  const candidates = await loadCandidates(o.client);
  log({ evt: 'confirm_candidates_loaded', count: candidates.length });
  if (candidates.length === 0) {
    return { ok: true, code: 0, google_auth_state: null, candidates: 0, messages_seen: 0, already_processed: 0, outcomes: {}, reason: 'no_candidates' };
  }

  if (!o.tokenFile) {
    return { ok: false, code: 1, google_auth_state: 'no_token_file', candidates: candidates.length, messages_seen: 0, already_processed: 0, outcomes: {}, reason: null };
  }
  const { state, accessToken } = await classifyAndConnect(o.tokenFile, { gmailRead: true }, o.deps ?? {});
  if (state.state !== 'ok' || !accessToken) {
    logError({ evt: 'confirm_auth_failed', google_auth_state: state.state });
    return { ok: false, code: 1, google_auth_state: state.state, candidates: candidates.length, messages_seen: 0, already_processed: 0, outcomes: {}, reason: null };
  }

  const authHeader = { Authorization: `Bearer ${accessToken}` };
  // Broad, keyword-based query (documented blind spot: a mail whose subject/body matches none of these
  // words is invisible to this job -- the unconditional 5-day nudge, amended decision 5, is the
  // mitigation, exactly the same shape as gmail.js's own alert-sender-allowlist blind spot).
  const q = `newer_than:${windowDays}d (subject:application OR subject:applying OR subject:candidacy OR "thank you for applying" OR "your application" OR "application status" OR "not moving forward" OR "position has been filled")`;

  let messagesSeen = 0;
  let alreadyProcessedCount = 0;
  /** @type {Record<string, number>} */
  const outcomes = {};
  const bump = (/** @type {string} */ k) => { outcomes[k] = (outcomes[k] ?? 0) + 1; };

  /** @type {string|null} */
  let pageToken = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listUrl = new URL(GMAIL_MESSAGES_URL);
    listUrl.searchParams.set('q', q);
    listUrl.searchParams.set('maxResults', String(LIST_PAGE_SIZE));
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
    /** @type {Response} */
    let listRes;
    try {
      listRes = await fetchFn(listUrl.toString(), { headers: authHeader });
    } catch (err) {
      logError({ evt: 'confirm_list_network_error', ...errFieldsLite(err) });
      break;
    }
    if (listRes.status === 401) {
      logError({ evt: 'confirm_list_401' });
      break;
    }
    if (listRes.status !== 200) {
      logError({ evt: 'confirm_list_bad_status', status: listRes.status });
      break;
    }
    /** @type {any} */
    const listJson = await listRes.json();
    const ids = Array.isArray(listJson.messages) ? listJson.messages.map((/** @type {any} */ m) => String(m.id)) : [];

    for (const id of ids) {
      messagesSeen++;
      if (await alreadyProcessed(o.client, id)) {
        alreadyProcessedCount++;
        continue;
      }
      /** @type {Response} */
      let getRes;
      try {
        getRes = await fetchFn(`${GMAIL_MESSAGES_URL}/${id}?format=full`, { headers: authHeader });
      } catch (err) {
        logError({ evt: 'confirm_get_network_error', message_id: id, ...errFieldsLite(err) });
        continue; // one bad message never aborts the run; it is simply retried next time (not recorded processed)
      }
      if (getRes.status === 401) {
        logError({ evt: 'confirm_get_401', message_id: id });
        continue;
      }
      if (getRes.status !== 200) {
        logError({ evt: 'confirm_get_bad_status', message_id: id, status: getRes.status });
        continue;
      }
      /** @type {any} */
      let msgJson;
      try {
        msgJson = await getRes.json();
      } catch (err) {
        logError({ evt: 'confirm_get_bad_json', message_id: id, ...errFieldsLite(err) });
        continue;
      }
      const subject = headerValue(msgJson.payload, 'Subject') ?? '';
      const fromName = fromDisplayName(headerValue(msgJson.payload, 'From'));
      /** @type {{ text: string|null, html: string|null }} */
      const parts = { text: null, html: null };
      collectBodyParts(msgJson.payload, parts);

      try {
        const outcome = await handleMessage(o.client, { messageId: id, subject, text: parts.text ?? '', html: parts.html ?? '', fromName }, candidates, log, logError);
        bump(outcome);
      } catch (err) {
        // A single message's handling failing (e.g. a state-machine VALIDATION race) never aborts the
        // run and is never recorded processed -- it is simply retried on the next run.
        const f = err instanceof JobSearchError ? { err_code: err.code, err_message: err.message.slice(0, 300) } : errFieldsLite(err);
        logError({ evt: 'confirm_message_failed', message_id: id, ...f });
      }
    }

    pageToken = typeof listJson.nextPageToken === 'string' ? listJson.nextPageToken : null;
    if (!pageToken) break;
  }

  log({ evt: 'confirm_done', messages_seen: messagesSeen, already_processed: alreadyProcessedCount, outcomes });
  return {
    ok: true, code: 0, google_auth_state: null, candidates: candidates.length,
    messages_seen: messagesSeen, already_processed: alreadyProcessedCount, outcomes, reason: null,
  };
}
