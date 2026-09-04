// @ts-check
/**
 * Sticky-skip shared definitions (sticky-skip spec: "final, adversary-corrected"). STICKY-ELIGIBLE,
 * MATCH-TEST, and SURFACE-EXCEPTION are defined once here and reused by all three surfaces that need
 * them:
 *
 *   A. src/tools/review.js resolveItem -- merge/repost into a STICKY-ELIGIBLE root bypasses
 *      inheritStatus entirely (the candidate inherits the root's sticky status directly, no reopen).
 *   B. src/core/upsert.js applyDecision -- scan-time dedup auto-merges a new listing into a
 *      STICKY-ELIGIBLE root instead of queuing it for review.
 *   C. src/core/review-bulk.js / bin/review-bulk.js -- bulk mode 'sticky-skip' resolves many open
 *      queue rows the same way, one at a time, through resolveItem.
 *
 * MATCH-TEST and SURFACE-EXCEPTION are pure (no DB access): they compare two plain row-shaped objects.
 * STICKY-ELIGIBLE requires the target's most recent status-change event, which is a DB read; the
 * `stickyEligibleFor`/`loadStickyEligibility` helpers below are the one place that read runs, so A, B,
 * and C never re-implement it with slightly different SQL.
 *
 * auto-skip-sticky amendment: an `actor: 'auto'` status event (skip_low, skip_noise, model band, or any
 * other freeform note -- the note text is no longer inspected at all) is STICKY-ELIGIBLE when BOTH (a)
 * the CANDIDATE listing's own prescore is non-null and strictly below the current triage floor
 * (config/triage.json's `deterministic.floor`, default 40, same source src/core/triage.js reads), AND
 * (b) the root carries no event of any kind other than 'status' recorded after that status event (an
 * operator note/edit after the auto skip means a human touched the root since, so it is no longer purely
 * an unattended auto decision). This is a per-candidate gate, not a per-root one: the same auto-skipped
 * root can be sticky for one low-prescore candidate and not for another, higher-prescore one, so the
 * candidate's prescore is always an explicit input here, never read off the root row.
 */
import { isLocationEligible } from './normalize.js';
import { STICKY_STATUSES } from './statuses.js';

export { STICKY_STATUSES };

/** @param {string|null|undefined} status */
export function isStickyStatus(status) {
  return typeof status === 'string' && /** @type {readonly string[]} */ (STICKY_STATUSES).includes(status);
}

/**
 * Fallback floor used only when a caller does not supply one explicitly (old direct callers, tests).
 * Mirrors config.js's `triageSchema.deterministic.floor` default -- production call sites always pass
 * the REAL configured floor (config/triage.json, or this same default when triage.json is absent), so
 * this constant only matters when a caller genuinely has no config available.
 */
export const DEFAULT_STICKY_FLOOR = 40;

/**
 * STICKY-ELIGIBLE (spec Definitions), given the root's status and its most recent kind='status' event
 * whose to_status equals that status. A sticky status with NO recorded status-change event to it at all
 * (e.g. very old, pre-event-log data, or a row whose status was set some other way) is never eligible:
 * fail closed, per this repo's total-classification convention (an allow-list's failure mode is silent
 * escape; friction -- staying queued for ordinary review -- is the safer default here).
 *
 * Total classification over `event.actor`: 'dashboard'/'mcp'/'cli' (a human decision) is always
 * eligible; 'auto' is eligible only when BOTH conditions in `auto` hold (see module doc comment above);
 * every other actor (seed, migration, apply, or any other value) is never eligible.
 * @param {string|null|undefined} rootStatus
 * @param {{ actor: string, note: string|null }|null|undefined} event
 * @param {{ candidatePrescore?: number|null, floor?: number, hasLaterNonStatusEvent?: boolean }} [auto]
 *   only consulted when `event.actor === 'auto'`: `candidatePrescore` is the CANDIDATE listing's own
 *   prescore (never the root's), `floor` is the current triage floor (defaults to DEFAULT_STICKY_FLOOR
 *   when omitted), `hasLaterNonStatusEvent` is whether the root carries a kind<>'status' event recorded
 *   after the status event being checked.
 */
export function isStickyEligible(rootStatus, event, auto) {
  if (!isStickyStatus(rootStatus)) return false;
  if (!event) return false;
  if (event.actor === 'dashboard' || event.actor === 'mcp' || event.actor === 'cli') return true;
  if (event.actor === 'auto') {
    if (auto?.hasLaterNonStatusEvent) return false;
    const candidatePrescore = auto?.candidatePrescore;
    if (candidatePrescore == null) return false;
    const floor = typeof auto?.floor === 'number' ? auto.floor : DEFAULT_STICKY_FLOOR;
    return Number(candidatePrescore) < floor;
  }
  // seed/migration/apply (or any actor outside EVENT_ACTORS that somehow reaches here): never eligible.
  return false;
}

/**
 * Read the most recent kind='status' event on `rootId` whose to_status equals `rootStatus`, and report
 * STICKY-ELIGIBLE for `candidatePrescore` against `floor`. Runs on the caller's client/transaction, so a
 * caller already holding a transaction (resolveItem, applyDecision's savepoint, bulkResolve's per-item
 * transaction) gets a read consistent with everything else it just wrote/read in that same transaction.
 *
 * The "any event of any kind other than status recorded after that status event" check only ever runs
 * when the found event's actor is 'auto' (the only branch that needs it) -- a non-sticky or
 * human-actor root never pays for the extra query.
 * @param {import('pg').ClientBase} client
 * @param {number} rootId
 * @param {string|null|undefined} rootStatus
 * @param {number|null} [candidatePrescore] the CANDIDATE listing's own prescore; only consulted on the
 *   'auto'-actor branch, ignored otherwise
 * @param {number} [floor] current triage floor; defaults to DEFAULT_STICKY_FLOOR when omitted
 * @returns {Promise<boolean>}
 */
export async function stickyEligibleFor(client, rootId, rootStatus, candidatePrescore = null, floor = DEFAULT_STICKY_FLOOR) {
  if (!isStickyStatus(rootStatus)) return false;
  const r = await client.query(
    `SELECT id, at, actor, note FROM ic_job_events WHERE listing_id = $1 AND kind = 'status' AND to_status = $2 ORDER BY at DESC, id DESC LIMIT 1`,
    [rootId, rootStatus],
  );
  const event = r.rows[0] ?? null;
  let hasLaterNonStatusEvent = false;
  if (event && event.actor === 'auto') {
    const later = await client.query(
      `SELECT 1 FROM ic_job_events WHERE listing_id = $1 AND kind <> 'status' AND (at, id) > ($2, $3) LIMIT 1`,
      [rootId, event.at, event.id],
    );
    hasLaterNonStatusEvent = later.rowCount > 0;
  }
  return isStickyEligible(rootStatus, event, { candidatePrescore, floor, hasLaterNonStatusEvent });
}

/**
 * Re-read a listing's current status, then STICKY-ELIGIBLE for it ("re-read the target root status
 * inside the transaction", spec part A). Two queries (status, then its event) rather than one join, so
 * a non-sticky root (the common case) never pays for the event query at all.
 * @param {import('pg').ClientBase} client
 * @param {number} rootId
 * @param {number|null} [candidatePrescore] the CANDIDATE listing's own prescore (see stickyEligibleFor)
 * @param {number} [floor] current triage floor; defaults to DEFAULT_STICKY_FLOOR when omitted
 * @returns {Promise<{ eligible: boolean, status: string|null }>}
 */
export async function loadStickyEligibility(client, rootId, candidatePrescore = null, floor = DEFAULT_STICKY_FLOOR) {
  const r = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [rootId]);
  const status = r.rows[0]?.status ?? null;
  const eligible = await stickyEligibleFor(client, rootId, status, candidatePrescore, floor);
  return { eligible, status };
}

/**
 * @typedef {Object} StickyMatchRow
 * @property {string|null} [url_normalized]
 * @property {string|null} [url_kind] only ever supplied by a caller holding a freshly-normalized
 *   incoming record (upsert.js's `rec`); a caller comparing two ALREADY-STORED listing rows omits it,
 *   because ic_job_listings has no url_kind column. That omission is safe by construction: a
 *   normalizeListing() 'redirect'-kind result always carries url_normalized: null (src/core/normalize.js
 *   never persists a non-null url_normalized alongside kind:'redirect'), so a genuinely-redirect row can
 *   never have a non-null url_normalized to match on in the first place. A future write path that sets
 *   url_normalized on a stored row without going through normalizeListing() would not be caught by this
 *   invariant -- see the module's blind-spot note in the sticky-skip PR description.
 * @property {string|null} [source]
 * @property {string|null} [title_norm]
 * @property {string|null} [company_norm]
 * @property {string|null} [location_norm]
 * @property {number|null} [salary_max]
 * @property {string|null} [apply_url]
 */

/**
 * MATCH-TEST(cand, root) (spec Definitions): (i) same url as root AND cand.url_kind is not redirect; OR
 * (ii) same source AND isLocationEligible true on both sides AND equal title_norm, company_norm,
 * location_norm. Never treats null as equal to null: every field compared must be non-null on BOTH
 * sides, in both clauses, or the clause does not match.
 * @param {StickyMatchRow} cand
 * @param {StickyMatchRow} root
 */
export function matchTest(cand, root) {
  if (cand.url_normalized != null && root.url_normalized != null && cand.url_normalized === root.url_normalized) {
    if (cand.url_kind !== 'redirect') return true;
  }
  if (
    cand.source != null && root.source != null && cand.source === root.source
    && isLocationEligible(cand.location_norm ?? null) && isLocationEligible(root.location_norm ?? null)
    && cand.title_norm != null && root.title_norm != null && cand.title_norm === root.title_norm
    && cand.company_norm != null && root.company_norm != null && cand.company_norm === root.company_norm
    && cand.location_norm != null && root.location_norm != null && cand.location_norm === root.location_norm
  ) {
    return true;
  }
  return false;
}

/**
 * SURFACE-EXCEPTION(cand, root) (spec Definitions): MATCH-TEST passes but the two rows disagree loudly
 * enough (salary, apply URL) that a human should still see this rather than have it silently merge.
 * Independent of matchTest() here -- callers run matchTest() first and only check this once it passed,
 * per the spec's "MATCH-TEST passes but ..." phrasing -- but this function does not itself require that
 * order.
 * @param {StickyMatchRow} cand
 * @param {StickyMatchRow} root
 */
export function surfaceException(cand, root) {
  if (cand.salary_max != null && root.salary_max != null && Number(cand.salary_max) > Number(root.salary_max) * 1.1) return true;
  if (cand.apply_url != null && root.apply_url != null && cand.apply_url !== root.apply_url) return true;
  return false;
}

/**
 * MATCH-TEST passing and SURFACE-EXCEPTION not applying, combined (the condition every one of A/B/C
 * actually gates auto-merge on).
 * @param {StickyMatchRow} cand
 * @param {StickyMatchRow} root
 */
export function stickyMergeCandidate(cand, root) {
  return matchTest(cand, root) && !surfaceException(cand, root);
}
