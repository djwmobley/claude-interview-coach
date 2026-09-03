// @ts-check
/**
 * Bulk-separate classification for the review-queue bulk-resolve feature (review-bulk spec S1).
 * `classifyForBulkSeparate()` is a TOTAL classification over one open review-queue item plus its
 * candidate row and (at most one) matched listing row: every input maps to exactly one of the ten
 * branches below (one separate branch, nine leave branches), checked in the precedence order they are
 * listed in. There is no silent fall-through and the function never throws, even on malformed input
 * (a missing candidate or match row still resolves to a leave branch).
 *
 * Deliberately STRICTER than the branch-4 creator that originally queued a title_similar_same_company
 * item (src/core/dedup.js ~line 444-449): that creator accepts EITHER an identical titleTokenKey OR a
 * trigram title_sim >= titleSimilarity threshold. This classifier accepts ONLY an identical titleTokenKey
 * match. A bulk, largely-unattended separate of many items at once must never rely on a fuzzy numeric
 * similarity threshold nobody reviewed case-by-case; anything that only cleared the trigram-similarity
 * bar (and not the exact token-key bar) stays queued for ordinary, one-at-a-time review.
 */
import { isLocationEligible, isRemoteLocation, titleTokenKey } from './normalize.js';

/** The one rule this module currently knows how to auto-separate. */
export const BULK_SEPARATE_RULE = 'same_title_diff_location';

/**
 * The closed list of nine review-queue reasons the bulk-resolve feature's mode:'reason' accepts
 * (review-bulk spec, FACTS). This is a fixed enumeration, not derived from src/core/statuses.js's
 * QUEUE_REASONS: it also includes 'title_similar_same_company', 'same_source_hash_within_gap',
 * 'branch1_conflict', 'hash_location_unknown', and 'cross_source_uncorroborated' (dedup.js branch-4/
 * branch-1/branch-2/branch-3 near-miss reasons) and 'company_similar_same_title', none of which are
 * status-reopen or mail-classifier reasons and so are not in QUEUE_REASONS.
 */
export const BULK_REASON_REASONS = Object.freeze([
  'title_similar_same_company',
  'same_source_hash_within_gap',
  'branch1_conflict',
  'hash_location_unknown',
  'concurrent_review',
  'reopened_skip',
  'title_renormalized',
  'cross_source_uncorroborated',
  'company_similar_same_title',
]);

/** The closed list of reasons `classifyForBulkSeparate` can hand back on the leave branch, in precedence order. */
export const BULK_LEAVE_REASONS = Object.freeze([
  'not_open',
  'wrong_reason',
  'multi_match',
  'status_changed',
  'company_differs',
  'title_key_differs',
  'location_unknown',
  'location_same',
  'remote_involved',
]);

/**
 * @typedef {Object} BulkQueueItem
 * @property {string|null} [resolution]
 * @property {string} [reason]
 * @property {number[]} [matches]
 */

/**
 * @typedef {Object} BulkListingRow
 * @property {string|null} [status]
 * @property {string|null} [company_norm]
 * @property {string|null} [title_norm]
 * @property {string|null} [location_norm]
 */

/**
 * @typedef {{ decision: 'separate', rule: 'same_title_diff_location' } | { decision: 'leave', reason: typeof BULK_LEAVE_REASONS[number] }} BulkDecision
 */

/**
 * @param {BulkQueueItem|null|undefined} item the open review-queue row
 * @param {BulkListingRow|null|undefined} candidate the candidate listing row (item.candidate_id)
 * @param {BulkListingRow|null|undefined} match the single matched listing row (item.matches[0]), when it
 *   was resolved by the caller; null/undefined when it could not be loaded (e.g. deleted since queuing)
 * @returns {BulkDecision}
 */
export function classifyForBulkSeparate(item, candidate, match) {
  if (!item || item.resolution != null) return { decision: 'leave', reason: 'not_open' };
  if (item.reason !== 'title_similar_same_company') return { decision: 'leave', reason: 'wrong_reason' };
  const matches = Array.isArray(item.matches) ? item.matches : [];
  if (matches.length !== 1 || !match) return { decision: 'leave', reason: 'multi_match' };
  if (!candidate || candidate.status !== 'review') return { decision: 'leave', reason: 'status_changed' };
  if (candidate.company_norm !== match.company_norm) return { decision: 'leave', reason: 'company_differs' };
  if (titleTokenKey(candidate.title_norm ?? '') !== titleTokenKey(match.title_norm ?? '')) return { decision: 'leave', reason: 'title_key_differs' };
  if (!isLocationEligible(candidate.location_norm) || !isLocationEligible(match.location_norm)) return { decision: 'leave', reason: 'location_unknown' };
  if (candidate.location_norm === match.location_norm) return { decision: 'leave', reason: 'location_same' };
  if (isRemoteLocation(candidate.location_norm) || isRemoteLocation(match.location_norm)) return { decision: 'leave', reason: 'remote_involved' };
  return { decision: 'separate', rule: BULK_SEPARATE_RULE };
}
