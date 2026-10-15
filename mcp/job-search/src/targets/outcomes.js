// @ts-check
/**
 * Target finder parse outcomes (plan section 14.2 and 14.5, 15.3). Every raw item an adapter sees gets
 * EXACTLY ONE outcome with a reason from the adapter's closed reason set:
 *
 *   parsed        a signal object was built and handed to classifySignal
 *   unparseable   plausible trigger, but required structure is missing, malformed, or of unknown shape
 *                 (default branch for anything the adapter does not recognize: unknown_shape)
 *   out_of_scope  understood, but not a trigger (or dropped by a per-run cap, reason run_cap)
 *
 * createCollector() is the only way adapters record items. It is TOTAL: a reason outside the adapter's
 * closed set is recorded as unparseable/unknown_shape (with the original reason kept in stats.warnings),
 * and guard() turns any exception inside an adapter step into unparseable/adapter_exception. Nothing is
 * dropped without a count.
 */
import crypto from 'node:crypto';
import { sanitizeText } from './signal-text.js';

export const OUTCOMES = Object.freeze(['parsed', 'unparseable', 'out_of_scope']);

/** Reasons every adapter may emit in addition to its own list. */
export const COMMON_REASONS = Object.freeze(['adapter_exception', 'name_too_long', 'fetch_refused', 'unknown_shape']);

/**
 * @typedef {Object} SourceStats
 * @property {number} raw
 * @property {number} parsed
 * @property {number} unparseable
 * @property {number} out_of_scope
 * @property {number} capped items dropped by a per-run cap (also counted in out_of_scope / run_cap)
 * @property {Record<string, number>} reasons count per "<outcome>:<reason>"
 * @property {string|null} skipped reason the whole source was skipped, else null
 * @property {string[]} warnings
 * @property {number|null} discovery_total how many hits the source says exist
 * @property {number} read how many were actually read
 * @property {Record<string, number>} extra adapter-specific counters (message cap, row cap, truncation flags)
 * @property {{ source: 'complete'|'partial', forms: Record<string, { status: 'complete'|'partial'|'none', total: number|null, read: number, pages: Array<{ from: number, hits: number, ok: boolean, reason: string|null }> }> }|null} coverage
 *   per-form discovery coverage (PR2b); null for sources with no discovery. The source is complete ONLY when
 *   every form request returned all its pages, anything else is partial (undercoverage).
 */

/** @returns {SourceStats} */
export function newStats() {
  return { raw: 0, parsed: 0, unparseable: 0, out_of_scope: 0, capped: 0, reasons: {}, skipped: null, warnings: [], discovery_total: null, read: 0, extra: {}, coverage: null };
}

/**
 * @typedef {Object} TargetItem
 * @property {string} source
 * @property {string} key stable key (the dedup key without the source prefix)
 * @property {'parsed'|'unparseable'|'out_of_scope'} outcome
 * @property {string} reason
 * @property {Record<string, any>|null} signal classifier input when outcome is parsed
 * @property {{ role: string|null, name: string|null }|null} contact
 * @property {string} excerpt
 * @property {string|null} url
 * @property {Record<string, unknown>} extracted
 * @property {number[]} [listing_ids]
 * @property {{ source: string, key: string }} [supersedes] earlier item this one replaces (amendments)
 */

/**
 * url_hash = sha256 hex of "<source>|<stable key>".
 * @param {string} source
 * @param {string} key
 * @returns {string}
 */
export function urlHash(source, key) {
  return crypto.createHash('sha256').update(`${source}|${key}`).digest('hex');
}

/**
 * @param {string} source
 * @param {readonly string[]} reasons the adapter's closed reason set
 * @param {string} parserVersion
 */
export function createCollector(source, reasons, parserVersion) {
  const allowed = new Set([...reasons, ...COMMON_REASONS, 'ok']);
  const stats = newStats();
  /** @type {TargetItem[]} */
  const items = [];

  /**
   * @param {'parsed'|'unparseable'|'out_of_scope'} outcome
   * @param {string} reason
   * @param {Partial<TargetItem> & { key: string }} fields
   * @returns {TargetItem}
   */
  function add(outcome, reason, fields) {
    let o = OUTCOMES.includes(outcome) ? outcome : 'unparseable';
    let r = outcome === 'parsed' ? 'ok' : reason;
    if (o !== outcome || !allowed.has(r)) {
      stats.warnings.push(`reason_coerced:${sanitizeText(`${outcome}/${reason}`, 80)}`);
      o = 'unparseable';
      r = 'unknown_shape';
    }
    stats.raw += 1;
    stats[o] += 1;
    const k = `${o}:${r}`;
    stats.reasons[k] = (stats.reasons[k] ?? 0) + 1;
    if (o === 'out_of_scope' && r === 'run_cap') stats.capped += 1;
    const item = /** @type {TargetItem} */ ({
      source,
      key: fields.key,
      outcome: o,
      reason: r,
      signal: o === 'parsed' ? (fields.signal ?? null) : null,
      contact: fields.contact ?? null,
      excerpt: fields.excerpt ?? '',
      url: fields.url ?? null,
      extracted: { ...(fields.extracted ?? {}), parse_outcome: o, parse_reason: r, parser_version: parserVersion, source },
      ...(fields.listing_ids ? { listing_ids: fields.listing_ids } : {}),
      ...(fields.supersedes ? { supersedes: fields.supersedes } : {}),
    });
    items.push(item);
    return item;
  }

  /**
   * Count an item without persisting it (aggregate-only outcomes, e.g. gap groups that are not candidates).
   * @param {'parsed'|'unparseable'|'out_of_scope'} outcome
   * @param {string} reason
   */
  function tally(outcome, reason) {
    let o = OUTCOMES.includes(outcome) ? outcome : 'unparseable';
    let r = reason;
    if (o !== outcome || !allowed.has(r)) {
      stats.warnings.push(`reason_coerced:${sanitizeText(`${outcome}/${reason}`, 80)}`);
      o = 'unparseable';
      r = 'unknown_shape';
    }
    stats.raw += 1;
    stats[o] += 1;
    const k = `${o}:${r}`;
    stats.reasons[k] = (stats.reasons[k] ?? 0) + 1;
  }

  /**
   * Run one adapter step for one raw item; an exception becomes unparseable/adapter_exception.
   * @param {string} key
   * @param {() => Promise<TargetItem|void>|TargetItem|void} fn
   */
  async function guard(key, fn) {
    try {
      await fn();
    } catch (err) {
      add('unparseable', 'adapter_exception', { key, extracted: { error: sanitizeText(err instanceof Error ? err.message : String(err), 160) } });
    }
  }

  /** @param {string} w */
  function warn(w) {
    const t = sanitizeText(w, 200);
    if (t && !stats.warnings.includes(t) && stats.warnings.length < 50) stats.warnings.push(t);
  }

  /** @param {string} reason */
  function skip(reason) {
    stats.skipped = reason;
    warn(`skipped:${reason}`);
  }

  /** @param {string} name @param {number} [by] */
  function bump(name, by = 1) {
    stats.extra[name] = (stats.extra[name] ?? 0) + by;
  }

  return { add, tally, guard, warn, skip, bump, stats, items, source, parserVersion };
}

/** @typedef {ReturnType<typeof createCollector>} Collector */

/**
 * Add the stats of several sources into a run-level summary.
 * @param {Record<string, SourceStats>} perSource
 */
export function summarizeStats(perSource) {
  const total = { raw: 0, parsed: 0, unparseable: 0, out_of_scope: 0 };
  for (const s of Object.values(perSource)) {
    total.raw += s.raw;
    total.parsed += s.parsed;
    total.unparseable += s.unparseable;
    total.out_of_scope += s.out_of_scope;
  }
  return total;
}
