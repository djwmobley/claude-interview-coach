// @ts-check
/**
 * Day coverage and closed reason codes for the target runner (plan 17.2 and 17.5). Pure.
 *
 * COVERED. An item counts as covered only when a document was read, or the item was refused for a permanent
 * recorded reason. The classification is TOTAL and defaults to NOT covered: a reason that is not on the
 * permanent list (including one added to an adapter later) keeps the day partial, which is visible friction,
 * never a silent skip.
 *
 *   parsed        covered unless doc_fetch is anything other than 'ok' (partial, failed, or an unknown value)
 *   out_of_scope  covered only for PERMANENT_OUT_OF_SCOPE (run_cap is NOT permanent)
 *   unparseable   covered only for PERMANENT_UNPARSEABLE (doc_fetch_failed, adapter_exception, fetch_refused are not)
 *
 * A day is complete only when discovery is complete for every form request (every page ok, and the distinct
 * hits seen equal the final total) and every item is covered.
 */
import crypto from 'node:crypto';

/** Out of scope for a reason that will not change on a re-read of the same accession. */
export const PERMANENT_OUT_OF_SCOPE = Object.freeze([
  'fund_like_name_prefilter', 'item_not_502', 'no_cto_class_role', 'appointment_only', 'query_disabled',
]);

/** Unparseable for a reason that a re-read of the same accession cannot fix. */
export const PERMANENT_UNPARSEABLE = Object.freeze([
  'xml_malformed', 'issuer_name_missing', 'accession_malformed', 'cik_malformed', 'name_too_long', 'company_missing',
  'section_not_found', 'no_date_at_all', 'hit_shape_unknown', 'unknown_shape',
]);

/**
 * @param {{ outcome?: string|null, reason?: string|null, doc_fetch?: string|null }} x
 * @returns {boolean}
 */
export function isCovered(x) {
  const docFetch = x.doc_fetch ?? null;
  if (x.outcome === 'parsed') return docFetch === null || docFetch === 'ok';
  if (x.outcome === 'out_of_scope') return PERMANENT_OUT_OF_SCOPE.includes(String(x.reason));
  if (x.outcome === 'unparseable') return PERMANENT_UNPARSEABLE.includes(String(x.reason));
  return false;
}

/** @param {import('./outcomes.js').TargetItem} item @returns {boolean} */
export function itemCovered(item) {
  const ex = /** @type {Record<string, any>} */ (item.extracted ?? {});
  return isCovered({ outcome: item.outcome, reason: item.reason, doc_fetch: typeof ex.doc_fetch === 'string' ? ex.doc_fetch : (typeof item.signal?.doc_fetch === 'string' ? item.signal.doc_fetch : null) });
}

/**
 * The reason a not-covered item holds its day, as a closed code.
 * @param {import('./outcomes.js').TargetItem} item
 * @returns {string}
 */
export function holdReasonOfItem(item) {
  if (item.reason === 'run_cap') return 'run_cap';
  if (item.reason === 'doc_fetch_failed') return 'doc_fetch';
  if (item.reason === 'adapter_exception') return 'adapter_exception';
  if (item.outcome === 'parsed') return 'doc_fetch';
  return 'unknown_reason';
}

/**
 * @typedef {Object} DayAssessment
 * @property {boolean} complete
 * @property {string[]} reasons closed hold reasons (empty when complete)
 * @property {number|null} total sum of the per-form totals the index reported
 * @property {number} distinct sum of distinct hits seen
 * @property {boolean} overflow
 * @property {number} uncovered items that held the day
 */

/**
 * @param {{ stats: import('./outcomes.js').SourceStats & { overflow?: boolean }, items: import('./outcomes.js').TargetItem[] }} out one adapter call for one day
 * @returns {DayAssessment}
 */
export function assessDay(out) {
  const { stats, items } = out;
  /** @type {Set<string>} */
  const reasons = new Set();
  const cov = stats.coverage;
  let total = 0;
  let distinct = 0;
  let totalKnown = false;
  if (!cov) {
    reasons.add('no_coverage');
  } else {
    for (const fc of Object.values(cov.forms)) {
      if (fc.total !== null) { total += fc.total; totalKnown = true; }
      distinct += fc.distinct ?? 0;
      if (fc.status === 'complete') continue;
      if (fc.pages.some((p) => !p.ok)) reasons.add('request_failed');
      else reasons.add('discovery_incomplete');
    }
    if (cov.source !== 'complete' && reasons.size === 0) reasons.add('discovery_incomplete');
  }
  const overflow = Boolean(stats.overflow);
  if (overflow) reasons.add('day_overflow');
  let uncovered = 0;
  for (const it of items) {
    if (itemCovered(it)) continue;
    uncovered += 1;
    reasons.add(holdReasonOfItem(it));
  }
  return { complete: reasons.size === 0, reasons: [...reasons].sort(), total: totalKnown ? total : null, distinct, overflow, uncovered };
}

/**
 * Closed reason codes. Digest and subject render these and nothing else; raw error text never reaches them.
 */
export const CLOSED_REASONS = Object.freeze([
  'sec_contact_missing', 'sec_blocked', 'gmail_auth_expired', 'config_invalid', 'no_time', 'deadline', 'timeout',
  'request_failed', 'discovery_incomplete', 'day_overflow', 'run_cap', 'doc_fetch', 'adapter_exception', 'suspicious_empty',
  'unknown_reason', 'no_coverage', 'exception', 'already_running', 'weekend', 'test_guard', 'dry_run', 'message_cap',
  'gmail_unavailable', 'stage_failed', 'stage_timeout', 'connect_timeout', 'crashed', 'other',
]);

/**
 * Map any raw skip or hold text to one closed code.
 * @param {unknown} raw
 * @returns {string}
 */
export function closedReason(raw) {
  const s = String(raw ?? '');
  if (CLOSED_REASONS.includes(s)) return s;
  if (s === 'auth_unavailable') return 'gmail_auth_expired';
  if (s.startsWith('config_invalid')) return 'config_invalid';
  if (s.startsWith('discovery_')) return 'request_failed';
  if (s.startsWith('gmail_list') || s.startsWith('gmail_')) return 'gmail_unavailable';
  return 'other';
}

/**
 * Stable hash of a source's config (queries, forms, window). A change resets the cursor.
 * @param {unknown} config
 * @returns {string}
 */
export function configHash(config) {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16);
}

/** @param {unknown} v @returns {string} */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = /** @type {Record<string, unknown>} */ (v);
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
