// @ts-check
/**
 * Assisted LinkedIn Easy Apply: database state (sql/018_easy_apply_assisted.sql). Leases (spec B2: every
 * easy_apply tool call validates application id, nonce, expiry), the persisted circuit breaker (G11), the
 * daily cap through src/core/budget.js's reserveBudget (G10, also charged to LinkedIn's own budget), the
 * in-flight check (G9), and the awaiting_submit park (G12). The tab-set helpers the scan side needs live in
 * src/core/easy-apply-tabs.js (no applications.js import there) and are re-exported here.
 */
import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { JobSearchError } from './errors.js';
import { reserveBudget, budgetDay } from './budget.js';
import { transitionUnwrapped } from './applications.js';
import { AWAITING_SUBMIT_KIND } from './easy-apply-tabs.js';

export { listAwaitingTargets, demoteAbandonedTabs, markStaleAwaiting, AWAITING_SUBMIT_KIND, ABANDONED_TAB_KIND } from './easy-apply-tabs.js';

/** Environment variable the runner sets in the generated MCP config: "<applicationId>.<nonce hex>". */
export const LEASE_ENV = 'JOBSEARCH_EASY_APPLY_LEASE';
/**
 * Canonical lease env for the assisted_apply tool (src/tools/assisted_apply.js). LEASE_ENV above stays as
 * the easy_apply alias's env for one release (spec v2 A14); the same lease token format and table back both.
 */
export const ASSISTED_LEASE_ENV = 'JOBSEARCH_ASSISTED_APPLY_LEASE';
/** ic_scan_budget source name for the Easy Apply daily cap. */
export const EASY_APPLY_BUDGET_SOURCE = 'linkedin_easy_apply';
/** ic_scan_budget source name for the assisted Workday daily cap (its own budget, spec v1 clause 9). */
export const WORKDAY_ASSISTED_BUDGET_SOURCE = 'workday_assisted';
/** The breaker/lease key every pre-019 caller means. */
const DEFAULT_ATS = 'linkedin_easy';

/** @param {string} s */
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * @param {unknown} token
 * @returns {{ applicationId: number, nonce: string }|null}
 */
export function parseLeaseToken(token) {
  if (typeof token !== 'string') return null;
  const m = /^(\d{1,10})\.([0-9a-f]{32,128})$/.exec(token.trim());
  if (!m) return null;
  const applicationId = Number(m[1]);
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  return { applicationId, nonce: m[2] };
}

/**
 * @param {string} reason
 * @param {string} message
 */
function leaseError(reason, message) {
  return new JobSearchError('VALIDATION', `${reason}: ${message}`, { details: { reason } });
}

/**
 * Issue a lease for one attempt. Returns the token the runner passes to the MCP server.
 * @param {import('pg').ClientBase} client
 * @param {{ applicationId: number, trigger: 'morning'|'dashboard', targetId: string|null, ttlMs: number, now?: Date, ats?: string }} input
 *   ats defaults to 'linkedin_easy' (the LinkedIn callers predate sql/019); the column refuses any value
 *   outside the assisted ATS vocabulary.
 */
export async function issueLease(client, input) {
  const now = input.now ?? new Date();
  const nonce = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const r = await client.query(
    `INSERT INTO ic_easy_apply_leases (application_id, nonce_hash, trigger, target_id, issued_at, expires_at, ats)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.applicationId, sha256(nonce), input.trigger, input.targetId, now, expiresAt, input.ats ?? DEFAULT_ATS],
  );
  return { leaseId: Number(r.rows[0].id), token: `${input.applicationId}.${nonce}`, expiresAt };
}

/**
 * Validate a lease token. Total: every failure is a VALIDATION error whose message starts with one closed
 * reason: lease_missing | lease_invalid | lease_closed | lease_expired | application_not_submitting.
 * @param {import('pg').ClientBase} client
 * @param {unknown} token
 * @param {Date} [now]
 */
export async function validateLease(client, token, now = new Date()) {
  const parsed = parseLeaseToken(token);
  if (!parsed) throw leaseError('lease_missing', 'no valid Easy Apply lease token in this session');
  const r = await client.query(
    `SELECT l.*, a.state AS application_state FROM ic_easy_apply_leases l JOIN ic_job_applications a ON a.id = l.application_id
      WHERE l.application_id = $1 AND l.nonce_hash = $2 ORDER BY l.id DESC LIMIT 1`,
    [parsed.applicationId, sha256(parsed.nonce)],
  );
  if (r.rowCount === 0) throw leaseError('lease_invalid', 'lease does not match any issued lease for this application');
  const lease = r.rows[0];
  if (lease.closed_at) throw leaseError('lease_closed', 'this lease is closed; the session is over');
  if (new Date(lease.expires_at).getTime() <= now.getTime()) throw leaseError('lease_expired', 'this lease has expired');
  if (lease.application_state !== 'submitting') throw leaseError('application_not_submitting', `application is "${lease.application_state}", not "submitting"`);
  return lease;
}

/** @param {import('pg').ClientBase} client @param {number} leaseId */
export async function getLease(client, leaseId) {
  const r = await client.query('SELECT * FROM ic_easy_apply_leases WHERE id = $1', [leaseId]);
  if (r.rowCount === 0) throw new JobSearchError('NOT_FOUND', `lease ${leaseId} not found`);
  return r.rows[0];
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} leaseId
 * @param {{ state?: unknown, ledger?: unknown, lastActionAt?: Date }} patch
 */
export async function updateLeaseState(client, leaseId, patch) {
  await client.query(
    `UPDATE ic_easy_apply_leases
        SET state = coalesce($2::jsonb, state), ledger = coalesce($3::jsonb, ledger), last_action_at = coalesce($4, last_action_at)
      WHERE id = $1`,
    [leaseId, patch.state === undefined ? null : JSON.stringify(patch.state), patch.ledger === undefined ? null : JSON.stringify(patch.ledger), patch.lastActionAt ?? null],
  );
}

/**
 * Close a lease (idempotent: an already-closed lease keeps its first stop reason and finish result).
 * @param {import('pg').ClientBase} client
 * @param {number} leaseId
 * @param {{ stopReason: string, finishResult?: unknown }} o
 */
export async function closeLease(client, leaseId, o) {
  await client.query(
    `UPDATE ic_easy_apply_leases SET closed_at = now(), stop_reason = $2, finish_result = coalesce($3::jsonb, finish_result)
      WHERE id = $1 AND closed_at IS NULL`,
    [leaseId, o.stopReason, o.finishResult === undefined ? null : JSON.stringify(o.finishResult)],
  );
}

/**
 * Latest lease issue time for one ATS (LinkedIn's spacing rule reads its own leases only).
 * @param {import('pg').ClientBase} client
 * @param {string} [ats]
 * @returns {Promise<Date|null>}
 */
export async function lastAttemptAt(client, ats = DEFAULT_ATS) {
  const r = await client.query('SELECT max(issued_at) AS t FROM ic_easy_apply_leases WHERE ats = $1', [ats]);
  return r.rows[0].t ? new Date(r.rows[0].t) : null;
}

/**
 * The circuit breaker for one ATS (sql/019: keyed per ATS; default LinkedIn).
 * @param {import('pg').ClientBase} client
 * @param {Date} [now]
 * @param {string} [ats]
 * @returns {Promise<{ tripped: boolean, until: Date|null, reason: string|null, trippedAt: Date|null }>}
 */
export async function breakerStatus(client, now = new Date(), ats = DEFAULT_ATS) {
  const r = await client.query('SELECT tripped_until, tripped_at, reason FROM ic_easy_apply_breaker WHERE ats = $1', [ats]);
  if (r.rowCount === 0 || !r.rows[0].tripped_until) return { tripped: false, until: null, reason: null, trippedAt: null };
  const until = new Date(r.rows[0].tripped_until);
  return { tripped: until.getTime() > now.getTime(), until, reason: r.rows[0].reason ?? null, trippedAt: r.rows[0].tripped_at ? new Date(r.rows[0].tripped_at) : null };
}

/**
 * Trip the breaker for `hours` from `now` (never shortens a longer existing trip).
 * @param {import('pg').ClientBase} client
 * @param {{ reason: string, applicationId: number|null, hours: number, now?: Date, ats?: string }} o
 */
export async function tripBreaker(client, o) {
  const now = o.now ?? new Date();
  const until = new Date(now.getTime() + o.hours * 3600000);
  await client.query(
    `INSERT INTO ic_easy_apply_breaker (ats, tripped_until, tripped_at, reason, application_id) VALUES ($5, $1, $2, $3, $4)
     ON CONFLICT (ats) DO UPDATE SET tripped_until = GREATEST(coalesce(ic_easy_apply_breaker.tripped_until, $1), $1), tripped_at = $2, reason = $3, application_id = $4`,
    [until, now, o.reason, o.applicationId, o.ats ?? DEFAULT_ATS],
  );
}

/** Test seam only. @param {import('pg').ClientBase} client */
export async function clearBreakerForTests(client) {
  await client.query('DELETE FROM ic_easy_apply_breaker');
}

class LinkedInBudgetRefused extends Error {}

/**
 * Consume one Easy Apply attempt (spec G10: "consumed at attempt start, also counted against the LinkedIn
 * budget"): one page against linkedin_easy_apply's daily cap AND one detail against LinkedIn's own daily
 * budget, in one transaction -- either both are charged or neither is.
 * @param {import('pg').ClientBase} client
 * @param {{ easyApplyDaily: number, linkedinCaps: { source?: string, dailyPages: number, dailyDetails: number }, now?: Date }} o
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'easy_apply_daily_cap'|'linkedin_budget' }>}
 */
export async function reserveEasyApplyAttempt(client, o) {
  const now = o.now ?? new Date();
  try {
    return await withTransaction(client, async (c) => {
      const mine = await reserveBudget(c, EASY_APPLY_BUDGET_SOURCE, { pages: 1 }, { dailyPages: o.easyApplyDaily, dailyDetails: 1_000_000_000 }, now);
      if (!mine.ok) return /** @type {const} */ ({ ok: false, reason: 'easy_apply_daily_cap' });
      const li = await reserveBudget(c, o.linkedinCaps.source ?? 'linkedin', { details: 1 }, { dailyPages: o.linkedinCaps.dailyPages, dailyDetails: o.linkedinCaps.dailyDetails }, now);
      if (!li.ok) throw new LinkedInBudgetRefused();
      return /** @type {const} */ ({ ok: true });
    });
  } catch (err) {
    if (err instanceof LinkedInBudgetRefused) return { ok: false, reason: 'linkedin_budget' };
    throw err;
  }
}

/**
 * Undo one reserveEasyApplyAttempt for the same day (the worker calls this when the claim that follows the
 * reservation is refused, so no attempt ran). One transaction: the linkedin_easy_apply page and the
 * LinkedIn detail are returned together. Never takes a counter below zero.
 * @param {import('pg').ClientBase} client
 * @param {{ linkedinSource?: string, now: Date }} o `now` must be the reservation's own clock reading
 */
export async function refundEasyApplyAttempt(client, o) {
  const day = budgetDay(o.now);
  await withTransaction(client, async (c) => {
    await c.query('UPDATE ic_scan_budget SET pages = GREATEST(pages - 1, 0) WHERE source = $1 AND day = $2', [EASY_APPLY_BUDGET_SOURCE, day]);
    await c.query('UPDATE ic_scan_budget SET details = GREATEST(details - 1, 0) WHERE source = $1 AND day = $2', [o.linkedinSource ?? 'linkedin', day]);
  });
}

/**
 * Whether this ATS's single assisted in-flight slot is taken (a row in 'submitting', or parked at
 * awaiting_submit). sql/019's per-ATS unique index is the database backstop for the same rule.
 * @param {import('pg').ClientBase} client
 * @param {string} ats
 */
export async function hasAssistedInFlight(client, ats) {
  const r = await client.query(
    `SELECT 1 FROM ic_job_applications WHERE ats_type = $1
       AND (state = 'submitting' OR (state = 'needs_human' AND pending_question->>'kind' = '${AWAITING_SUBMIT_KIND}')) LIMIT 1`,
    [ats],
  );
  return (r.rowCount ?? 0) > 0;
}

/** LinkedIn's slot (the pre-019 name). @param {import('pg').ClientBase} client */
export async function hasEasyApplyInFlight(client) {
  return hasAssistedInFlight(client, 'linkedin_easy');
}

/**
 * Local day the workday_assisted pool counts by (unblock-auto-apply Item 5, A7). Every other pool, the
 * LinkedIn ones and the unattended submit cap included, stays on the UTC day.
 */
export const WORKDAY_BUDGET_TIMEZONE = 'America/Chicago';

/**
 * Consume one assisted Workday attempt against its own daily cap (spec v1 clause 9), counted by the
 * America/Chicago local day (A7), so an evening attempt never uses the next local morning's slot. The
 * charged day is returned so a refund goes back to the same day even after midnight.
 * @param {import('pg').ClientBase} client
 * @param {{ daily: number, now?: Date }} o
 * @returns {Promise<{ ok: true, day: string } | { ok: false, reason: 'workday_daily_cap' }>}
 */
export async function reserveWorkdayAttempt(client, o) {
  const now = o.now ?? new Date();
  const r = await reserveBudget(client, WORKDAY_ASSISTED_BUDGET_SOURCE, { pages: 1 }, { dailyPages: o.daily, dailyDetails: 1_000_000_000 }, now, WORKDAY_BUDGET_TIMEZONE);
  return r.ok ? { ok: true, day: budgetDay(now, WORKDAY_BUDGET_TIMEZONE) } : { ok: false, reason: 'workday_daily_cap' };
}

/**
 * Undo one reserveWorkdayAttempt (a refused claim: no attempt ran) against the day the charge was made on
 * (A7: the stored day, never "today"). Never below zero. `now` is accepted for a charge recorded before the
 * day was stored and maps to its local day.
 * @param {import('pg').ClientBase} client
 * @param {{ day?: string, now?: Date }} o
 */
export async function refundWorkdayAttempt(client, o) {
  const day = o.day ?? budgetDay(o.now ?? new Date(), WORKDAY_BUDGET_TIMEZONE);
  await client.query('UPDATE ic_scan_budget SET pages = GREATEST(pages - 1, 0) WHERE source = $1 AND day = $2', [WORKDAY_ASSISTED_BUDGET_SOURCE, day]);
}

/**
 * submitting -> needs_human kind awaiting_submit, storing the tab's CDP target id and the fill ledger
 * (spec G12). Called by the worker ONLY after finish's verified result (or the G2 uncertain_last_step
 * path with every field verified).
 * @param {import('pg').ClientBase} client
 * @param {number} applicationId
 * @param {{ targetId: string, ledger: unknown[], screenshotRelPath: string|null, note: string, pageUrl?: string|null, reason?: string, atsLabel?: string, prefilledUnledgered?: string[] }} o
 *   atsLabel names the site on the card (default LinkedIn Easy Apply); prefilledUnledgered lists the
 *   questions the SITE filled (resume parse, saved draft) that no server-side answer wrote (clause 10).
 */
export async function parkAwaitingSubmit(client, applicationId, o) {
  const atsLabel = o.atsLabel ?? 'LinkedIn Easy Apply';
  return withTransaction(client, (c) => transitionUnwrapped(c, applicationId, 'needs_human', {
    actor: 'apply',
    note: o.note,
    pending_question: {
      kind: AWAITING_SUBMIT_KIND,
      label: `${atsLabel} is filled and waiting on the Review screen in the scan Chrome. Review it there and click Submit yourself, then press "I submitted".`,
      ats_label: atsLabel,
      target_id: o.targetId,
      ledger: o.ledger,
      prefilled_unledgered: Array.isArray(o.prefilledUnledgered) ? o.prefilledUnledgered : [],
      awaiting_since: new Date().toISOString(),
      page_url: o.pageUrl ?? null,
      reason: o.reason ?? 'finish_verified',
    },
  }, o.screenshotRelPath ? { extraSet: { screenshot_rel_path: o.screenshotRelPath } } : {}));
}
