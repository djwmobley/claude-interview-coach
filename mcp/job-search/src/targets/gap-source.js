// @ts-check
/**
 * Target finder source A: the internal listings DB, for the leadership-gap trigger (plan 14.4 A as amended
 * by 15.2 items 3, 4, 6). No network.
 *
 * Input: live, non-duplicate listings seen in the last 60 days, read with an explicit ORDER BY
 * (company_norm, last_seen DESC, id DESC) and a hard row cap. Grouped in JS by company_norm. A group is a
 * candidate when at least one title satisfies isHiringLeadershipTitle.
 *
 * Amendments from section 15:
 *   - departure_signal is informational only (the classifier no longer requires it).
 *   - CTO-level listings are ALWAYS placed first in `listings`, so a cap can never hide one; a group with
 *     more live listings than the cap sets listings_truncated (classifier: needs-review).
 *   - the row cap truncates only the LAST group in company order; that group is marked truncated too.
 *   - the stats record the row cap, rows read, and truncated group counts (nothing silent).
 */
import { createCollector } from './outcomes.js';
import { sanitizeText, boundExtracted, makeExcerpt } from './signal-text.js';
import { isCtoLevelTitle, isHiringLeadershipTitle, parseDay } from '../core/target-classify.js';
import { isUnknownCompany } from '../apply/exclusions.js';
import { normalizeCompany } from '../core/normalize.js';

export const GAP_SOURCE = 'listings';
export const GAP_PARSER_VERSION = 'gap-1';
export const GAP_REASONS = Object.freeze(['no_hiring_leadership_listing', 'company_unresolved', 'listing_url_missing', 'unknown_shape']);
export const GAP_ROW_CAP = 5000;
export const GAP_LISTING_CAP = 20;
export const GAP_DESCRIPTION_CAP = 2000;
export const DEPARTURE_LOOKBACK_DAYS = 120;

export const GAP_SQL = `SELECT id, title, company, company_norm, url_normalized, posted_at, first_seen, last_seen, description
FROM ic_job_listings
WHERE coalesce(record_kind, 'listing') = 'listing'
  AND duplicate_of IS NULL
  AND coalesce(absent_runs, 0) = 0
  AND last_seen >= now() - interval '60 days'
  AND company_norm IS NOT NULL AND company_norm <> ''
ORDER BY company_norm ASC, last_seen DESC, id DESC
LIMIT $1`;

export const DEPARTURE_SIGNALS_SQL = `SELECT extracted->>'company_norm' AS company_norm, extracted->'alias_norms' AS alias_norms
FROM ic_target_signals
WHERE extracted->>'trigger_kind' = 'exec_departure'
  AND extracted->>'parse_outcome' = 'parsed'
  AND fetched_at >= now() - ($1::int * interval '1 day')
LIMIT 5000`;

/** @param {unknown} v @returns {string|null} YYYY-MM-DD */
function dayOf(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const d = parseDay(v);
    return d === null ? null : new Date(d).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * True only when both exec_departure feeds ran without a skip or an abort this run.
 * @param {{ fts?: import('./outcomes.js').SourceStats|null, k8?: import('./outcomes.js').SourceStats|null }} feeds
 * @returns {boolean}
 */
export function departureFeedsRanClean(feeds) {
  const ok = (/** @type {import('./outcomes.js').SourceStats|null|undefined} */ s) => Boolean(s) && s.skipped === null && !s.warnings.includes('sec_blocked');
  return ok(feeds?.fts) && ok(feeds?.k8);
}

/**
 * @param {Object} ctx
 * @param {(sql: string, params: unknown[]) => Promise<{ rows: any[] }>} ctx.query
 * @param {{ fts?: import('./outcomes.js').SourceStats|null, k8?: import('./outcomes.js').SourceStats|null }} [ctx.departureFeeds]
 */
export async function runGapSource(ctx) {
  const c = createCollector(GAP_SOURCE, GAP_REASONS, GAP_PARSER_VERSION);
  const res = await ctx.query(GAP_SQL, [GAP_ROW_CAP + 1]);
  let rows = res.rows;
  let rowCapHit = false;
  if (rows.length > GAP_ROW_CAP) {
    rowCapHit = true;
    rows = rows.slice(0, GAP_ROW_CAP);
    c.bump('row_cap_hit');
    c.warn(`row_cap_hit:${GAP_ROW_CAP}`);
  }
  c.stats.read = rows.length;
  c.stats.discovery_total = rowCapHit ? null : rows.length;

  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const r of rows) {
    const k = String(r.company_norm ?? '');
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const lastGroupKey = rowCapHit && rows.length ? String(rows[rows.length - 1].company_norm ?? '') : null;

  // Known recent exec_departure companies (informational departure_signal).
  const feedsClean = departureFeedsRanClean(ctx.departureFeeds ?? {});
  /** @type {Set<string>} */
  const departed = new Set();
  if (feedsClean) {
    try {
      const d = await ctx.query(DEPARTURE_SIGNALS_SQL, [DEPARTURE_LOOKBACK_DAYS]);
      for (const row of d.rows) {
        if (row.company_norm) departed.add(String(row.company_norm));
        if (Array.isArray(row.alias_norms)) for (const a of row.alias_norms) if (typeof a === 'string' && a) departed.add(a);
      }
    } catch {
      c.warn('departure_lookup_failed');
    }
  }

  for (const [norm, group] of groups) {
    await c.guard(norm || 'unknown', () => processGroup(norm, group, norm === lastGroupKey));
  }
  return { items: c.items, stats: c.stats, departureFeedsClean: feedsClean };

  /**
   * @param {string} norm
   * @param {any[]} group
   * @param {boolean} rowCapTruncated
   */
  function processGroup(norm, group, rowCapTruncated) {
    if (!norm || norm.startsWith('confidential:') || isUnknownCompany(String(group[0].company ?? ''), norm)) {
      c.tally('out_of_scope', 'company_unresolved');
      return;
    }
    const titleOf = (/** @type {any} */ r) => String(r.title ?? '');
    const hiring = group.filter((r) => isHiringLeadershipTitle(titleOf(r)));
    if (hiring.length === 0) { c.tally('out_of_scope', 'no_hiring_leadership_listing'); return; }

    const freshness = (/** @type {any} */ r) => dayOf(r.posted_at) ?? dayOf(r.first_seen) ?? '';
    let newest = hiring[0];
    for (const r of hiring) if (freshness(r) > freshness(newest)) newest = r;
    const postedDays = hiring.map((r) => dayOf(r.posted_at)).filter(/** @returns {d is string} */ (d) => d !== null);
    const eventDate = postedDays.length ? postedDays.sort().at(-1) ?? null : (dayOf(newest.first_seen));

    // Most frequent company string; ties go to the most recently seen (rows are last_seen DESC).
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const r of group) counts.set(String(r.company ?? ''), (counts.get(String(r.company ?? '')) ?? 0) + 1);
    const names = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const company = sanitizeText(names[0]?.[0] ?? '', 200);
    const aliases = names.slice(1).map(([n]) => sanitizeText(n, 200)).filter((n) => n && n !== company).slice(0, 10);

    // CTO-level first, then hiring leadership (newest first), then the rest in query order.
    const cto = group.filter((r) => isCtoLevelTitle(titleOf(r)));
    const hiringSorted = [...hiring].sort((a, b) => (freshness(a) < freshness(b) ? 1 : freshness(a) > freshness(b) ? -1 : 0));
    const taken = new Set([...cto, ...hiringSorted].map((r) => r.id));
    const rest = group.filter((r) => !taken.has(r.id));
    const ordered = [...cto, ...hiringSorted, ...rest];
    const included = ordered.slice(0, GAP_LISTING_CAP);
    const truncated = ordered.length > GAP_LISTING_CAP || rowCapTruncated;
    if (truncated) c.bump('truncated_groups');

    const listingIds = included.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
    const url = typeof newest.url_normalized === 'string' && newest.url_normalized.trim() ? newest.url_normalized.trim() : null;
    const base = { company, company_norm: norm, listing_count: group.length, included: included.length, truncated, row_cap_truncated: rowCapTruncated };
    if (!url) { c.add('unparseable', 'listing_url_missing', { key: norm, listing_ids: listingIds, extracted: { ...base, listing_ids: listingIds } }); return; }

    const aliasNorms = aliases.map((a) => normalizeCompany(a).company_norm);
    const knownDeparture = feedsClean && (departed.has(norm) || aliasNorms.some((a) => departed.has(a)));
    const text = sanitizeText(`${titleOf(newest)} ${company}`, 400);
    const signal = {
      trigger_kind: 'leadership_gap',
      company,
      aliases,
      acquirer: null,
      investor: null,
      pe_firm: null,
      text,
      evidence_url: url,
      evidence_source: 'listings',
      event_date: eventDate,
      filing_date: null,
      size: null,
      employees: null,
      listings: included.map((r) => ({ title: sanitizeText(titleOf(r), 200), description: sanitizeText(r.description ?? '', GAP_DESCRIPTION_CAP) })),
      listings_truncated: truncated,
      departure_signal: knownDeparture ? true : (feedsClean ? false : null),
    };
    c.add('parsed', 'ok', {
      key: norm,
      signal,
      contact: null,
      url,
      listing_ids: listingIds,
      excerpt: makeExcerpt(text),
      extracted: boundExtracted({
        ...base,
        trigger_kind: 'leadership_gap',
        listing_ids: listingIds,
        alias_norms: [],
        event_date: eventDate,
        departure_signal: signal.departure_signal,
        titles: included.map((r) => titleOf(r)).slice(0, 20),
      }),
    });
  }
}
