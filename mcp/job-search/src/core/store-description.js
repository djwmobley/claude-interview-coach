// @ts-check
/**
 * The single chokepoint for writing ic_job_listings.description (detail-block fix). A fetched "description"
 * can be a Cloudflare or Indeed verification page, a login wall, or an HTTP error body; storing that text
 * poisons fit scoring, resumes and submissions. Every description write goes through here (or through the
 * payload screen below, which upsert.js uses for scan writes):
 *
 *   - classify with classifyDetail (src/browser/detail-classify.js)
 *   - write the description only when the class is 'ok'
 *   - a non-ok class leaves the description NULL, REPLACES an existing description that itself classifies
 *     non-ok (no blind IS NULL guard), records the class in detail_outcome, and writes the rejected text
 *     (first 500 chars) to ic_job_events as an audit row
 *
 * test/store-description-structure.test.js scans src/ and bin/ and fails for any file that writes the
 * description column but is not on its explicit routed list.
 */
import { classifyDetail, isBlockedClass } from '../browser/detail-classify.js';
import { descriptionHash } from './normalize.js';
import { recordEvent } from './events.js';

/** Stored detail_outcome values. 'fetched' is how an 'ok' classification is recorded (pre-existing value). */
export const DETAIL_OUTCOME_VALUES = Object.freeze([
  'fetched', 'empty', 'error', 'skipped_budget', 'skipped_gate', 'skipped_cancelled', 'not_queued',
  'transient', 'too_short', 'unverified',
  'blocked:cloudflare_challenge', 'blocked:indeed_verification', 'blocked:captcha', 'blocked:login_wall', 'blocked:http_403',
]);
const OUTCOME_SET = new Set(DETAIL_OUTCOME_VALUES);

/** @param {string} v */
export function isKnownDetailOutcome(v) {
  return OUTCOME_SET.has(v);
}

/**
 * The detail_outcome value recorded for a classifyDetail class.
 * @param {string} cls
 */
export function outcomeForClass(cls) {
  return cls === 'ok' ? 'fetched' : cls;
}

/** Outcomes that count toward detail_attempts (the retry cap). Blocks and transient errors are the source's
 * fault, not the listing's, so they never use up a listing's attempts. */
export const ATTEMPT_COUNTING = Object.freeze(['empty', 'error', 'too_short', 'unverified']);

/**
 * @typedef {Object} StoreCtx
 * @property {string|null} [source]
 * @property {string|null} [url]
 * @property {number|null} [httpStatus]
 * @property {string|null} [cfMitigated]
 * @property {any} [wallSignals]
 * @property {number|null} [runId]
 * @property {Date} [now]
 * @property {boolean} [onlyIfMissing] write an ok description only when the row has none (or only a non-ok one)
 */

/**
 * Write the audit row for rejected text.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {string} cls
 * @param {unknown} text
 * @param {{ runId?: number|null, now?: Date }} [ctx]
 */
export async function recordRejection(client, id, cls, text, ctx = {}) {
  const sample = typeof text === 'string' ? text.slice(0, 500) : '';
  await recordEvent(client, {
    listingId: id, kind: 'note', actor: 'auto', runId: ctx.runId ?? null, at: ctx.now,
    note: `description rejected (${cls}): ${sample}`,
  });
}

/**
 * Description screen for scan writes (insertListing / updateListing). A description the list page itself
 * supplied (detailOutcome null, not_queued, or skipped_*) may be a short snippet: too_short / unverified /
 * empty text passes through unchanged for those, since it never came from a detail fetch. Blocked and
 * transient text never passes. A detail-fetched payload (any other detailOutcome) must classify ok.
 * Returns the (possibly nulled) description, its hash, the class, and the detailOutcome to record.
 * @param {{ description: string|null, description_hash: string|null }} rec
 * @param {string|null|undefined} detailOutcome
 * @param {{ source?: string|null, rejectedDescription?: { text: string|null, cls: string }|null }} [ctx]
 */
export function screenPayload(rec, detailOutcome, ctx = {}) {
  /** @type {{ text: string|null, cls: string }|null} */
  let rejected = ctx.rejectedDescription ?? null;
  let description = rec.description;
  let hash = rec.description_hash;
  let outcome = detailOutcome ?? null;
  const listSupplied = outcome === null || outcome === 'not_queued' || outcome === 'skipped_gate' || outcome === 'skipped_budget' || outcome === 'skipped_cancelled';
  if (description) {
    const cls = classifyDetail({ text: description, source: ctx.source ?? null });
    const tolerated = listSupplied && (cls === 'too_short' || cls === 'unverified' || cls === 'empty');
    if (cls !== 'ok' && !tolerated) {
      rejected = { text: description, cls };
      description = null;
      hash = null;
      if (!listSupplied) outcome = outcomeForClass(cls);
    }
  }
  return { description, description_hash: hash, detailOutcome: outcome, rejected };
}

/**
 * When a scan update carries no usable description, an existing stored description that classifies
 * non-ok is junk from before this gate: null it (and its hash) and record why. Returns the class when it
 * did, else null. The SQL prefilter keeps the common case (long, ordinary text) from being fetched.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ runId?: number|null, now?: Date }} [ctx]
 * @returns {Promise<string|null>}
 */
export async function purgeJunkDescription(client, id, ctx = {}) {
  const r = await client.query(
    `SELECT description FROM ic_job_listings
      WHERE id = $1 AND description IS NOT NULL
        AND (length(description) < 1300
             OR description ~* '(ray id|cloudflare|verification required|verify you are|captcha|access denied|request blocked|unusual traffic|are you a robot|sign in to continue|just a moment|checking your browser)')`,
    [id],
  );
  if (!r.rowCount) return null;
  const existing = String(r.rows[0].description);
  const cls = classifyDetail({ text: existing });
  if (cls === 'ok') return null;
  // A short list snippet that merely classifies too_short/unverified is not junk; only blocked/transient text is purged here.
  if (!isBlockedClass(cls) && cls !== 'transient') return null;
  await client.query(`UPDATE ic_job_listings SET description = NULL, description_hash = NULL, detail_outcome = $2 WHERE id = $1`, [id, outcomeForClass(cls)]);
  await recordRejection(client, id, cls, existing, ctx);
  return cls;
}

/**
 * Clear a stored description that classifies non-ok (the repair path, bin/repair-blocked-descriptions.js):
 * description and hash NULL, detail_outcome set to the class, and, because any fit was scored against junk,
 * fit_score and fit_basis NULL. The old text goes to the audit trail (first 500 chars).
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {string} cls a non-ok classifyDetail class
 * @param {string|null} oldText
 * @param {{ runId?: number|null, now?: Date }} [ctx]
 */
export async function clearRejectedDescription(client, id, cls, oldText, ctx = {}) {
  await client.query(
    `UPDATE ic_job_listings SET description = NULL, description_hash = NULL, detail_outcome = $2, fit_score = NULL, fit_basis = NULL WHERE id = $1`,
    [id, outcomeForClass(cls)],
  );
  await recordRejection(client, id, cls, oldText, ctx);
}

/**
 * @typedef {Object} StoreResult
 * @property {boolean} ok text classified ok and was written
 * @property {string} cls the classifyDetail class
 * @property {string} outcome the detail_outcome recorded (or that would apply)
 * @property {boolean} stored the description column was written
 * @property {boolean} replacedJunk an existing non-ok description was removed or replaced
 */

/**
 * Classify `text` and store it for listing `id` only when it is ok.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {string|null} text
 * @param {StoreCtx} [ctx]
 * @returns {Promise<StoreResult>}
 */
export async function storeDescription(client, id, text, ctx = {}) {
  const cls = classifyDetail({ text, url: ctx.url ?? null, source: ctx.source ?? null, httpStatus: ctx.httpStatus ?? null, cfMitigated: ctx.cfMitigated ?? null, wallSignals: ctx.wallSignals ?? null });
  const outcome = outcomeForClass(cls);
  const cur = await client.query('SELECT description FROM ic_job_listings WHERE id = $1', [id]);
  if (!cur.rowCount) return { ok: false, cls, outcome, stored: false, replacedJunk: false };
  const existing = cur.rows[0].description == null ? null : String(cur.rows[0].description);
  const existingCls = existing === null ? null : classifyDetail({ text: existing });
  const existingJunk = existingCls !== null && existingCls !== 'ok';

  if (cls === 'ok') {
    if (ctx.onlyIfMissing && existing !== null && !existingJunk) {
      return { ok: true, cls, outcome, stored: false, replacedJunk: false };
    }
    const h = descriptionHash(text).hash;
    await client.query(
      `UPDATE ic_job_listings SET description = $2, description_hash = coalesce($3, description_hash), detail_outcome = 'fetched', detail_attempts = 0 WHERE id = $1`,
      [id, text, h],
    );
    return { ok: true, cls, outcome, stored: true, replacedJunk: existingJunk };
  }

  // Non-ok: never write the text. An existing GOOD description is kept as is (and its outcome untouched);
  // an existing junk or missing one is cleared and the outcome recorded.
  if (existing !== null && !existingJunk) {
    await recordRejection(client, id, cls, text, ctx);
    return { ok: false, cls, outcome, stored: false, replacedJunk: false };
  }
  const counts = ATTEMPT_COUNTING.includes(outcome);
  await client.query(
    `UPDATE ic_job_listings SET description = NULL, description_hash = NULL, detail_outcome = $2,
            detail_attempts = detail_attempts + $3 WHERE id = $1`,
    [id, outcome, counts ? 1 : 0],
  );
  await recordRejection(client, id, cls, text ?? existing, ctx);
  return { ok: false, cls, outcome, stored: false, replacedJunk: existingJunk };
}
