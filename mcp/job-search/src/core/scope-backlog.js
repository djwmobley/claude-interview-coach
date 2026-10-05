// @ts-check
/**
 * Backlog classification for review bulk mode 'scope' (dedup scope-gate spec C, amendments F3/F4/F5/
 * F6/F10). `classifyScopeItem()` is a TOTAL classification of one open review-queue item: every item
 * maps to exactly one action, checked in this order, and anything not positively established is
 * 'leave' (the item stays queued for the operator).
 *
 *   1. leave  not_open              item already resolved
 *   2. leave  candidate_missing     no candidate row
 *   3. leave  status_changed        candidate status is no longer 'review' (C2 step 1)
 *   4. leave  status_at_create      the item was created against a candidate carrying a status other
 *                                   than 'review' (F3; every scan-created item records 'review')
 *   5. leave  other_open_item       the candidate has another open queue item (F3)
 *   6. leave  reason_not_eligible   any reason outside SCOPE_BACKLOG_REASONS: status inheritance
 *                                   (reopened_*, concurrent_review, unrecognized_status), url_reuse,
 *                                   branch1_conflict, redirect_url, separate_blocked_unique, adopt_*
 *                                   (spec A5, "never gated"), and every other or future reason
 *   7. leave  no_matches            no match id other than the candidate itself
 *   8. merge | repost               B: every match resolves to ONE root (F6), that root is an exact
 *                                   match of the candidate (scope.js isExactMatch: B1 + F4 + F10), and
 *                                   inheriting the root's status needs no queue row (C3, F5). merge when
 *                                   the root's last_seen is within repostGapDays of the candidate's
 *                                   first_seen, else repost
 *   9. separate (rule location)     B3: title_similar_same_company, one match, same title-token key,
 *                                   different eligible non-remote locations (classifyForBulkSeparate)
 *  10. separate (rule scope)        A2: GATED reason and the candidate plus every matched row (and each
 *                                   matched row's root) classify 'out' (scope.js)
 *  11. leave  scope_in | scope_unknown:<rule> | match_rows_missing   gated reason, A2 not satisfied
 *  12. leave  reason_not_gated      any other reason (for example same_source_hash_within_gap that
 *                                   was not an exact match)
 *
 * Read-only: issues SELECTs only, so the bulk dry run can call it inside a READ ONLY transaction.
 */
import { inheritStatus, toDate } from './dedup.js';
import { classifyForBulkSeparate } from './review-bulk.js';
import { evaluatePairScope, isExactMatch, isGatedReason, isNeverGatedReason, SCOPE_GATED_REASONS } from './scope.js';

/** Every leave reason classifyScopeItem() can return, besides the dynamic `scope_unknown:<rule>`. */
export const SCOPE_BACKLOG_LEAVE_REASONS = Object.freeze([
  'not_open', 'candidate_missing', 'status_changed', 'status_at_create', 'other_open_item', 'reason_not_eligible',
  'no_matches', 'scope_in', 'match_rows_missing', 'reason_not_gated',
]);

/**
 * The reasons this mode may act on at all: the GATED near-miss reasons plus the live path's own
 * exact-hash reason. Every other reason (status inheritance, identity conflicts, propagation or
 * mail-classifier reasons, adopt_*, anything added later) maps to leave/reason_not_eligible.
 */
export const SCOPE_BACKLOG_REASONS = Object.freeze([...SCOPE_GATED_REASONS, 'same_source_hash_within_gap']);

const CAND_COLS =`l.id, l.title, l.status, l.fit_score, l.prescore, l.duplicate_of, l.source, l.external_id, l.url_normalized,
  l.title_norm, l.company_norm, l.location_norm, l.salary_max, l.apply_url, l.first_seen, l.last_seen,
  (SELECT e.actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'status' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS status_actor`;

/**
 * @typedef {{ action: 'leave', reason: string }
 *   | { action: 'merge'|'repost', targetId: number, rule: 'exact' }
 *   | { action: 'separate', rule: 'location'|'scope' }} ScopeItemDecision
 */

/**
 * @param {import('pg').ClientBase} c
 * @param {{ id: number, candidate_id: number|null, matches: number[]|null, reason: string, resolution?: string|null, resolved_at?: Date|string|null, status_at_create?: string|null }} item
 * @param {{ profiles: import('./scope.js').ScopeProfile[], prescoreFloor?: number, repostGapDays?: number }} opts
 * @returns {Promise<ScopeItemDecision>}
 */
export async function classifyScopeItem(c, item, opts) {
  if (!item || item.resolution != null || item.resolved_at != null) return { action: 'leave', reason: 'not_open' };
  if (item.candidate_id == null) return { action: 'leave', reason: 'candidate_missing' };
  const cand = (await c.query(`SELECT ${CAND_COLS} FROM ic_job_listings l WHERE l.id = $1`, [item.candidate_id])).rows[0];
  if (!cand) return { action: 'leave', reason: 'candidate_missing' };
  if (cand.status !== 'review') return { action: 'leave', reason: 'status_changed' };
  if (item.status_at_create != null && item.status_at_create !== 'review') return { action: 'leave', reason: 'status_at_create' };
  const other = await c.query('SELECT 1 FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL AND id <> $2 LIMIT 1', [cand.id, item.id]);
  if (other.rowCount > 0) return { action: 'leave', reason: 'other_open_item' };
  if (isNeverGatedReason(item.reason) || !SCOPE_BACKLOG_REASONS.includes(item.reason)) return { action: 'leave', reason: 'reason_not_eligible' };

  const matchIds = [...new Set((Array.isArray(item.matches) ? item.matches : []).map(Number).filter((n) => Number.isInteger(n) && n !== Number(cand.id)))];
  if (matchIds.length === 0) return { action: 'leave', reason: 'no_matches' };

  // B: exact-match closure (B1, F4, F5, F6, F10, C3).
  const matched = (await c.query('SELECT id, duplicate_of FROM ic_job_listings WHERE id = ANY($1::int[])', [matchIds])).rows;
  if (matched.length === matchIds.length) {
    const rootIds = new Set(matched.map((r) => Number(r.duplicate_of ?? r.id)));
    if (rootIds.size === 1) {
      const rootId = [...rootIds][0];
      const root = rootId === Number(cand.id) ? null : (await c.query(`SELECT ${CAND_COLS} FROM ic_job_listings l WHERE l.id = $1`, [rootId])).rows[0];
      if (root && root.duplicate_of == null && isExactMatch(cand, root) && !inheritStatus(root.status).queueReason) {
        const gapMs = (opts.repostGapDays ?? 30) * 86400000;
        const rootSeen = toDate(root.last_seen);
        const candFirst = toDate(cand.first_seen);
        const within = rootSeen !== null && candFirst !== null && candFirst.getTime() - rootSeen.getTime() <= gapMs;
        return { action: within ? 'merge' : 'repost', targetId: Number(root.id), rule: 'exact' };
      }
    }
  }

  // B3: different location, same title-token key, never merged.
  if (item.reason === 'title_similar_same_company' && matchIds.length === 1) {
    const match = (await c.query('SELECT id, status, company_norm, title_norm, location_norm FROM ic_job_listings WHERE id = $1', [matchIds[0]])).rows[0] ?? null;
    const verdict = classifyForBulkSeparate({ resolution: null, reason: item.reason, matches: matchIds }, cand, match);
    if (verdict.decision === 'separate') return { action: 'separate', rule: 'location' };
  }

  // A: relevance gate, GATED reasons only.
  if (!isGatedReason(item.reason)) return { action: 'leave', reason: 'reason_not_gated' };
  const verdict = await evaluatePairScope(c, cand, matchIds, opts.profiles, { prescoreFloor: opts.prescoreFloor, excludeId: Number(cand.id) });
  if (verdict.out) return { action: 'separate', rule: 'scope' };
  return { action: 'leave', reason: verdict.why };
}
