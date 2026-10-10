// @ts-check
/**
 * Review-queue relevance gate and exact-match test (dedup scope-gate spec v1 + amendments v2).
 *
 * The review queue exists so the operator can rule on pairs that might be the same job. Most open
 * items pair two listings nobody would ever apply to; asking about those is pure friction. This module
 * decides, per listing row, whether the row is in scope for this job search:
 *
 *   scopeOf(row, profiles, opts) -> 'in' | 'out' | 'unknown'
 *
 * It is a TOTAL classification: every input lands on exactly one rule below, first match wins, and
 * every missing signal lands on 'unknown' (which always keeps the pair queued). Only 'out' on BOTH
 * sides of a pair (pairIsOutOfScope) lets a caller skip the operator.
 *
 *   (a) profiles missing, or no profile has any keyword/phrase      -> unknown  profiles_missing
 *   (b) blank title                                                  -> unknown  blank_title
 *   (c) status skip/passed set by a human (latest status event actor
 *       is anything but 'auto', or no status event at all)           -> in       status_human  (F7)
 *       status skip/passed set by 'auto'                             -> falls through to scoring (F7)
 *       status null/review                                           -> falls through
 *       any other status (applied, interviewing, offer, accepted,
 *       dead, lost, new, maybe, shortlisted, garbage)                -> in       status
 *   (d) fit_score >= SCOPE_FIT_FLOOR                                 -> in       fit_score    (F11)
 *   (e) titleMatches() true for ANY profile with keywords/phrases    -> in       title_match  (F12)
 *   (F0) title-gate.js drop verdict (Director level / non-tech)      -> out      title_gate
 *   (F1) any prescore.js SENIORITY token in the title                -> in       seniority
 *   (f) prescore null                                                -> unknown  prescore_null
 *   (g) prescore >= scope prescore floor                             -> in       prescore     (F11)
 *   (h) otherwise                                                    -> out      below_floor
 *
 * F11: the two thresholds are separate, named values and never one shared variable. The prescore
 * floor is config/triage.json's deterministic.floor (callers pass it as `prescoreFloor`); the fit
 * floor is the code constant SCOPE_FIT_FLOOR.
 */
import { titleMatches } from '../adapters/base.js';
import { SENIORITY_PATTERNS } from './prescore.js';
import { classifyTitle } from './title-gate.js';
import { isLocationEligible, isRemoteLocation } from './normalize.js';
import { surfaceException } from './sticky-skip.js';

/** fit_score at or above this keeps a row in scope (F11). Never shared with the prescore floor. */
export const SCOPE_FIT_FLOOR = 40;

/**
 * Fallback for the prescore floor only when a caller has no config at all (tests, old callers).
 * Production callers pass config/triage.json's deterministic.floor explicitly.
 */
export const DEFAULT_SCOPE_PRESCORE_FLOOR = 40;

/** Queue reasons the relevance gate may close (spec A, "GATED (decided)"). */
export const SCOPE_GATED_REASONS = Object.freeze([
  'title_similar_same_company',
  'company_similar_same_title',
  'company_description_match',
  'cross_source_uncorroborated',
  'hash_location_unknown',
  'legacy_exact',
  'description_match_other_company',
]);

/** Queue reasons that are never gated and never auto-closed by the backlog (spec A). */
export const SCOPE_NEVER_GATED_REASONS = Object.freeze(['url_reuse', 'branch1_conflict', 'redirect_url', 'separate_blocked_unique']);

/** Status-inheritance reasons (dedup.js inheritStatus): never gated (spec A5). */
export const STATUS_INHERITANCE_REASON_PREFIX = 'reopened_';
export const STATUS_INHERITANCE_REASONS = Object.freeze(['concurrent_review', 'unrecognized_status']);

/** @param {string|null|undefined} reason */
export function isStatusInheritanceReason(reason) {
  const r = String(reason ?? '');
  return r.startsWith(STATUS_INHERITANCE_REASON_PREFIX) || STATUS_INHERITANCE_REASONS.includes(r);
}

/** @param {string|null|undefined} reason */
export function isGatedReason(reason) {
  return typeof reason === 'string' && SCOPE_GATED_REASONS.includes(reason);
}

/** @param {string|null|undefined} reason */
export function isNeverGatedReason(reason) {
  const r = String(reason ?? '');
  return SCOPE_NEVER_GATED_REASONS.includes(r) || r.startsWith('adopt_') || isStatusInheritanceReason(r);
}

/**
 * @typedef {Object} ScopeProfile
 * @property {string} [name]
 * @property {string[]} [keywords]
 * @property {string[]} [phrases]
 * @property {string[]} [exclude_terms]
 */

/**
 * @typedef {Object} ScopeRow
 * @property {string|null} [title]
 * @property {string|null} [status]
 * @property {string|null} [status_actor] actor on the row's most recent kind='status' event, or null
 * @property {number|null} [fit_score]
 * @property {number|null} [prescore]
 */

/** @param {ScopeProfile} p */
function hasTerms(p) {
  return [...(p?.keywords ?? []), ...(p?.phrases ?? [])].some((t) => String(t ?? '').trim() !== '');
}

/** @param {string|null|undefined} title */
export function hasSeniorityToken(title) {
  const t = String(title ?? '');
  return SENIORITY_PATTERNS.some((re) => re.test(t));
}

/**
 * @param {ScopeRow|null|undefined} row
 * @param {ScopeProfile[]|null|undefined} profiles every ic_search_profiles row (F12)
 * @param {{ prescoreFloor?: number }} [opts]
 * @returns {{ scope: 'in'|'out'|'unknown', rule: string }}
 */
export function scopeDetail(row, profiles, opts = {}) {
  const usable = Array.isArray(profiles) ? profiles.filter(hasTerms) : [];
  if (usable.length === 0) return { scope: 'unknown', rule: 'profiles_missing' };
  if (!row) return { scope: 'unknown', rule: 'row_missing' };
  const title = String(row.title ?? '').trim();
  if (!title) return { scope: 'unknown', rule: 'blank_title' };

  const status = row.status ?? null;
  if (status === 'skip' || status === 'passed') {
    if (row.status_actor !== 'auto') return { scope: 'in', rule: 'status_human' };
    // auto-triage skip: falls through to scoring (F7)
  } else if (status !== null && status !== 'review') {
    return { scope: 'in', rule: 'status' };
  }

  if (row.fit_score !== null && row.fit_score !== undefined && Number(row.fit_score) >= SCOPE_FIT_FLOOR) {
    return { scope: 'in', rule: 'fit_score' };
  }
  if (usable.some((p) => titleMatches(title, p))) return { scope: 'in', rule: 'title_match' };
  // Title gate (src/core/title-gate.js): a dropped title (plain Director, non-technology function) is
  // out even though its title carries a SENIORITY token, so this check runs before F1.
  if (classifyTitle(title).verdict === 'drop') return { scope: 'out', rule: 'title_gate' };
  if (hasSeniorityToken(title)) return { scope: 'in', rule: 'seniority' };
  if (row.prescore === null || row.prescore === undefined || !Number.isFinite(Number(row.prescore))) {
    return { scope: 'unknown', rule: 'prescore_null' };
  }
  const floor = typeof opts.prescoreFloor === 'number' ? opts.prescoreFloor : DEFAULT_SCOPE_PRESCORE_FLOOR;
  if (Number(row.prescore) >= floor) return { scope: 'in', rule: 'prescore' };
  return { scope: 'out', rule: 'below_floor' };
}

/**
 * @param {ScopeRow|null|undefined} row
 * @param {ScopeProfile[]|null|undefined} profiles
 * @param {{ prescoreFloor?: number }} [opts]
 */
export function scopeOf(row, profiles, opts = {}) {
  return scopeDetail(row, profiles, opts).scope;
}

/**
 * A2 + F2: a pair is out of scope only when the candidate and EVERY related row are 'out', and the
 * caller actually loaded one row per distinct match id (at least one). Anything else queues.
 * @param {{ scope: string, rule: string }} candidate
 * @param {{ scope: string, rule: string }[]} related matched rows plus their roots
 * @param {number} expectedMatches distinct match ids the queue decision named
 * @param {number} loadedMatches matched rows actually loaded for those ids
 * @returns {{ out: boolean, why: string }}
 */
export function pairIsOutOfScope(candidate, related, expectedMatches, loadedMatches) {
  if (!(expectedMatches >= 1) || loadedMatches !== expectedMatches) return { out: false, why: 'match_rows_missing' };
  const all = [candidate, ...related];
  const unknown = all.find((d) => d.scope === 'unknown');
  if (unknown) return { out: false, why: `scope_unknown:${unknown.rule}` };
  if (all.some((d) => d.scope !== 'out')) return { out: false, why: 'scope_in' };
  return { out: true, why: 'out_of_scope' };
}

/**
 * @typedef {Object} ExactRow
 * @property {string|null} [source]
 * @property {string|null} [external_id]
 * @property {string|null} [url_normalized]
 * @property {string|null} [title_norm]
 * @property {string|null} [company_norm]
 * @property {string|null} [location_norm]
 * @property {number|null} [salary_max]
 * @property {string|null} [apply_url]
 */

/**
 * B1 + F4 + F10: same source, both locations dedup-eligible, identical non-null title_norm,
 * company_norm and location_norm, no SURFACE-EXCEPTION, AND an identity tie: equal non-null
 * external_id, OR equal non-null url_normalized, OR external_id null on both sides. A remote
 * location_norm needs the stronger tie: equal non-null external_id only.
 * @param {ExactRow} a
 * @param {ExactRow} b
 */
export function isExactMatch(a, b) {
  if (!a || !b) return false;
  if (a.source == null || b.source == null || a.source !== b.source) return false;
  if (!isLocationEligible(a.location_norm ?? null) || !isLocationEligible(b.location_norm ?? null)) return false;
  for (const k of /** @type {const} */ (['title_norm', 'company_norm', 'location_norm'])) {
    if (a[k] == null || b[k] == null || a[k] !== b[k]) return false;
  }
  if (surfaceException(a, b) || surfaceException(b, a)) return false;
  const sameExt = a.external_id != null && b.external_id != null && a.external_id === b.external_id;
  if (isRemoteLocation(a.location_norm) || isRemoteLocation(b.location_norm)) return sameExt;
  const sameUrl = a.url_normalized != null && b.url_normalized != null && a.url_normalized === b.url_normalized;
  const bothExtNull = a.external_id == null && b.external_id == null;
  return sameExt || sameUrl || bothExtNull;
}

/**
 * Every ic_search_profiles row (F12), not the single profile a scan runs with.
 * @param {import('pg').ClientBase} client
 * @returns {Promise<ScopeProfile[]>}
 */
export async function loadScopeProfiles(client) {
  const r = await client.query('SELECT name, keywords, phrases, exclude_terms FROM ic_search_profiles ORDER BY name');
  return r.rows.map((p) => ({ name: String(p.name), keywords: p.keywords ?? [], phrases: p.phrases ?? [], exclude_terms: p.exclude_terms ?? [] }));
}

const SCOPE_ROW_SQL = `
  SELECT l.id, l.title, l.status, l.fit_score, l.prescore, l.duplicate_of,
    (SELECT e.actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'status' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS status_actor
  FROM ic_job_listings l WHERE l.id = ANY($1::int[])`;

/**
 * Point query for the scope signal of the given ids (one round trip), plus their roots when a row
 * is itself a duplicate (a second round trip only when needed).
 * @param {import('pg').ClientBase} client
 * @param {number[]} ids
 * @returns {Promise<{ matched: any[], roots: any[], missingRoots: number }>}
 */
export async function loadScopeRows(client, ids) {
  const distinct = [...new Set(ids.filter((n) => Number.isInteger(Number(n))).map(Number))];
  if (distinct.length === 0) return { matched: [], roots: [], missingRoots: 0 };
  const matched = (await client.query(SCOPE_ROW_SQL, [distinct])).rows;
  const have = new Set(matched.map((r) => Number(r.id)));
  const rootIds = [...new Set(matched.filter((r) => r.duplicate_of != null).map((r) => Number(r.duplicate_of)).filter((n) => !have.has(n)))];
  const roots = rootIds.length ? (await client.query(SCOPE_ROW_SQL, [rootIds])).rows : [];
  return { matched, roots, missingRoots: rootIds.length - roots.length };
}

/**
 * Full A2 evaluation for one candidate against the ids a queue decision named.
 * @param {import('pg').ClientBase} client
 * @param {ScopeRow} candidate
 * @param {number[]} matchIds
 * @param {ScopeProfile[]|null|undefined} profiles
 * @param {{ prescoreFloor?: number, excludeId?: number|null }} [opts]
 * @returns {Promise<{ out: boolean, why: string }>}
 */
export async function evaluatePairScope(client, candidate, matchIds, profiles, opts = {}) {
  const ids = [...new Set((matchIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n !== opts.excludeId))];
  const cand = scopeDetail(candidate, profiles, opts);
  if (cand.scope === 'unknown') return { out: false, why: `scope_unknown:${cand.rule}` };
  if (cand.scope === 'in') return { out: false, why: 'scope_in' };
  const { matched, roots, missingRoots } = await loadScopeRows(client, ids);
  if (missingRoots > 0) return { out: false, why: 'match_rows_missing' };
  const related = [...matched, ...roots].map((r) => scopeDetail(r, profiles, opts));
  return pairIsOutOfScope(cand, related, ids.length, matched.length);
}
