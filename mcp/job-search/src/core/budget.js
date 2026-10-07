// @ts-check
/**
 * Fan-out planning and per-day budgets (spec section 4).
 *
 * planned pages = (keywords + phrases) x locations x maxPages per browser
 * source, computed before the run; refused with BUDGET_EXCEEDED when over
 * the per-run cap. Per-day caps live in ic_scan_budget and are shared by MCP
 * and CLI; exhaustion is reported as BUDGET_EXHAUSTED by the caller.
 */
import crypto from 'node:crypto';
import { JobSearchError } from './errors.js';

/**
 * @typedef {Object} PlanInput
 * @property {string[]} keywords
 * @property {string[]} phrases
 * @property {string[]} locations
 * @property {number} maxPages
 * @property {string[]} sources
 */

/**
 * @typedef {Object} Plan
 * @property {number} planned total pages across sources
 * @property {Record<string, number>} bySource
 * @property {Array<{ source: string, query: string, location: string }>} queries randomized order
 */

/**
 * Compute the page plan. Fetch/API sources count one page per query per
 * board (they are cheap); browser and html sources count maxPages per
 * query x location. A source named in `ignoresQuery` (gmail: its Gmail
 * search is sender-based, not term/location-based) plans exactly
 * min(maxPages, maxPagesPerQuery) pages total, once, regardless of how many
 * keywords/phrases/locations the profile carries. Query order is randomized
 * per run.
 * @param {PlanInput} input
 * @param {import('./config.js').LoadedConfig['adapters']} adaptersCfg
 * @param {Set<string>} [ignoresQuery] source names that run one query regardless of terms/locations
 * @returns {Plan}
 */
export function planPages(input, adaptersCfg, ignoresQuery) {
  const terms = [...new Set([...(input.keywords ?? []), ...(input.phrases ?? [])].map((s) => String(s).trim()).filter(Boolean))];
  const locations = (input.locations ?? []).map((s) => String(s).trim()).filter(Boolean);
  const locs = locations.length > 0 ? locations : [''];
  const ignoreSet = ignoresQuery instanceof Set ? ignoresQuery : new Set();
  /** @type {Record<string, number>} */
  const bySource = {};
  /** @type {Plan['queries']} */
  const queries = [];
  for (const source of input.sources ?? []) {
    const a = adaptersCfg.adapters[source];
    if (!a) continue;
    if (ignoreSet.has(source)) {
      const n = Math.min(input.maxPages, a.maxPagesPerQuery);
      queries.push({ source, query: '*', location: '' });
      bySource[source] = n;
      continue;
    }
    const perQuery = a.transport === 'fetch' ? 1 : Math.min(input.maxPages, a.maxPagesPerQuery);
    let n = 0;
    for (const term of terms) {
      for (const loc of locs) {
        queries.push({ source, query: term, location: loc });
        n += perQuery;
      }
    }
    bySource[source] = n;
  }
  shuffle(queries);
  const planned = Object.values(bySource).reduce((s, n) => s + n, 0);
  return { planned, bySource, queries };
}

/**
 * Throw BUDGET_EXCEEDED when the plan is over the per-run cap.
 * @param {Plan} plan
 * @param {number} maxPlannedPagesPerRun
 */
export function assertPlanWithinCap(plan, maxPlannedPagesPerRun) {
  if (plan.planned > maxPlannedPagesPerRun) {
    throw new JobSearchError('BUDGET_EXCEEDED', `planned ${plan.planned} pages exceeds the per-run cap of ${maxPlannedPagesPerRun}`, {
      hint: 'reduce keywords, locations, or maxPages, or split the run by source',
      details: { planned: plan.planned, cap: maxPlannedPagesPerRun },
    });
  }
}

/**
 * Fisher-Yates with crypto randomness (no seed to leak, no Math.random pattern).
 * @template T
 * @param {T[]} arr
 */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * The budget day of `now`: the UTC date by default (every scan and LinkedIn pool, the submit cap), or the
 * local date in `timezone` when one is given (unblock-auto-apply Item 5, A7: only the workday_assisted
 * pool passes America/Chicago, so an evening attempt never consumes the next local morning's cap).
 * @param {Date} [now]
 * @param {string|null} [timezone] IANA zone; omitted or null means UTC
 */
export function budgetDay(now = new Date(), timezone = null) {
  if (!timezone) return now.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Remaining pages/details for a source today.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 * @param {{ dailyPages: number, dailyDetails: number }} caps
 * @param {Date} [now]
 * @param {string|null} [timezone] see budgetDay; omitted means the UTC day
 */
export async function remainingBudget(client, source, caps, now = new Date(), timezone = null) {
  const r = await client.query('SELECT pages, details FROM ic_scan_budget WHERE source = $1 AND day = $2', [source, budgetDay(now, timezone)]);
  const used = r.rows[0] ?? { pages: 0, details: 0 };
  return { pages: Math.max(0, caps.dailyPages - used.pages), details: Math.max(0, caps.dailyDetails - used.details), usedPages: used.pages, usedDetails: used.details };
}

/**
 * Atomically reserve `pages` and/or `details` for a source today. Returns
 * ok=false without consuming anything when the reservation would exceed a cap.
 * Single statement so the MCP and CLI processes cannot both slip under the cap.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 * @param {{ pages?: number, details?: number }} want
 * @param {{ dailyPages: number, dailyDetails: number }} caps
 * @param {Date} [now]
 * @param {string|null} [timezone] see budgetDay; omitted means the UTC day
 * @returns {Promise<{ ok: boolean, remainingPages: number, remainingDetails: number }>}
 */
export async function reserveBudget(client, source, want, caps, now = new Date(), timezone = null) {
  const p = Math.max(0, want.pages ?? 0);
  const d = Math.max(0, want.details ?? 0);
  const day = budgetDay(now, timezone);
  await client.query('INSERT INTO ic_scan_budget (source, day) VALUES ($1, $2) ON CONFLICT (source, day) DO NOTHING', [source, day]);
  const r = await client.query(
    `UPDATE ic_scan_budget SET pages = pages + $3, details = details + $4
     WHERE source = $1 AND day = $2 AND pages + $3 <= $5 AND details + $4 <= $6
     RETURNING pages, details`,
    [source, day, p, d, caps.dailyPages, caps.dailyDetails],
  );
  if (r.rowCount === 1) {
    return { ok: true, remainingPages: caps.dailyPages - r.rows[0].pages, remainingDetails: caps.dailyDetails - r.rows[0].details };
  }
  const rem = await remainingBudget(client, source, caps, now, timezone);
  return { ok: false, remainingPages: rem.pages, remainingDetails: rem.details };
}

/**
 * Give back part of a reservation made the same budget day (a reserved page load that never happened).
 * Never takes a counter below zero.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 * @param {{ pages?: number, details?: number }} give
 * @param {Date} [now] the reservation's own clock reading
 * @param {string|null} [timezone] see budgetDay
 */
export async function refundBudget(client, source, give, now = new Date(), timezone = null) {
  await client.query(
    'UPDATE ic_scan_budget SET pages = GREATEST(pages - $3, 0), details = GREATEST(details - $4, 0) WHERE source = $1 AND day = $2',
    [source, budgetDay(now, timezone), Math.max(0, give.pages ?? 0), Math.max(0, give.details ?? 0)],
  );
}
