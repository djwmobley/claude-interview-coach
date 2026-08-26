// @ts-check
/**
 * Scheduler (spec section 4): drives one adapter's `search` generator and
 * stops a query after maxPages or after 3 consecutive results older than
 * the window. It is the only consumer of adapter events; the run loop
 * (scan-run.js) plugs in handlers for listings, walls, and warnings.
 *
 * Event protocol (see adapters/base.js): an adapter yields the `listing`
 * events of a page first, then one `batch` event for that page. The
 * scheduler answers every yield with a Directive; `{ stopQuery: true }`
 * means "do not fetch another page for this query". A stale listing (posted
 * before the window) is dropped, never handed to onListing.
 */
import { withinWindow } from '../adapters/base.js';
import { JobSearchError } from './errors.js';

export const STALE_LIMIT = 3;

/**
 * @typedef {Object} QueryState
 * @property {number} pages
 * @property {number} listings
 * @property {number} stale
 * @property {number} consecutiveStale
 * @property {'maxPages'|'stale'|'wall'|null} stoppedBy
 */

/**
 * @typedef {Object} ScheduleResult
 * @property {number} pages
 * @property {number} listings listings handed to onListing
 * @property {number} stale listings dropped as older than the window
 * @property {number} deepestPage
 * @property {boolean} completed generator ran to the end (no wall, no throw, no abort)
 * @property {string|null} stoppedBy 'wall' when a wall stopped the source, else null
 * @property {Record<string, QueryState>} queries
 * @property {number} warnings
 */

/**
 * @typedef {Object} ScheduleHandlers
 * @property {(ev: import('../adapters/base.js').ListingEvent) => Promise<void>} onListing
 * @property {(ev: import('../adapters/base.js').PageEvent) => Promise<void>} [onBatch]
 * @property {(ev: import('../adapters/base.js').WarningEvent) => Promise<void>} [onWarning]
 * @property {(ev: import('../adapters/base.js').WallEvent) => Promise<{ stopSource: boolean }>} [onWall]
 */

/**
 * @param {import('../adapters/base.js').Adapter} adapter
 * @param {import('../adapters/base.js').SearchProfile} profile
 * @param {import('../adapters/base.js').AdapterCtx} ctx
 * @param {ScheduleHandlers} handlers
 * @param {{ maxPages: number, windowStart: Date|null, staleLimit?: number }} opts
 * @returns {Promise<ScheduleResult>}
 */
export async function runSearch(adapter, profile, ctx, handlers, opts) {
  const staleLimit = opts.staleLimit ?? STALE_LIMIT;
  const maxPages = Math.max(1, opts.maxPages);
  /** @type {Record<string, QueryState>} */
  const queries = {};
  const state = (/** @type {string} */ q) => {
    if (!queries[q]) queries[q] = { pages: 0, listings: 0, stale: 0, consecutiveStale: 0, stoppedBy: null };
    return queries[q];
  };
  /** @type {ScheduleResult} */
  const result = { pages: 0, listings: 0, stale: 0, deepestPage: 0, completed: false, stoppedBy: null, queries, warnings: 0 };

  const gen = adapter.search(profile, ctx);
  /** @type {import('../adapters/base.js').Directive} */
  let directive = undefined;
  try {
    for (;;) {
      if (ctx.signal.aborted) throw new JobSearchError('CANCELLED', 'run aborted', { details: { source: adapter.name } });
      const step = await gen.next(directive);
      if (step.done) break;
      const ev = step.value;
      directive = undefined;
      if (ev.kind === 'listing') {
        const q = state(ev.query);
        if (q.stoppedBy) {
          directive = { stopQuery: true };
          continue;
        }
        if (!withinWindow(ev.listing.postedAt, opts.windowStart)) {
          q.stale++;
          q.consecutiveStale++;
          result.stale++;
          if (q.consecutiveStale >= staleLimit) {
            q.stoppedBy = 'stale';
            directive = { stopQuery: true };
          }
          continue;
        }
        q.consecutiveStale = 0;
        q.listings++;
        result.listings++;
        await handlers.onListing(ev);
      } else if (ev.kind === 'batch') {
        const q = state(ev.query);
        q.pages++;
        result.pages++;
        if (ev.pageIndex > result.deepestPage) result.deepestPage = ev.pageIndex;
        if (handlers.onBatch) await handlers.onBatch(ev);
        if (q.pages >= maxPages && !q.stoppedBy) q.stoppedBy = 'maxPages';
        if (q.stoppedBy) directive = { stopQuery: true };
      } else if (ev.kind === 'warning') {
        result.warnings++;
        if (handlers.onWarning) await handlers.onWarning(ev);
      } else if (ev.kind === 'wall') {
        const q = state(ev.query);
        q.stoppedBy = 'wall';
        const r = handlers.onWall ? await handlers.onWall(ev) : { stopSource: true };
        if (r.stopSource) {
          result.stoppedBy = 'wall';
          await gen.return(undefined);
          return result;
        }
        directive = { stopQuery: true };
      }
    }
    result.completed = true;
    return result;
  } catch (err) {
    try {
      await gen.return(undefined);
    } catch {
      /* generator already closed */
    }
    throw err;
  }
}
