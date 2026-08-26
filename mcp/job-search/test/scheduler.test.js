// @ts-check
/**
 * Scheduler and rate limiter: pure, no network, no DB.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSearch, STALE_LIMIT } from '../src/core/scheduler.js';
import { makeRateLimiter, backoffDelay, jitter, isRetryableStatus, sleep } from '../src/core/ratelimit.js';
import { defineAdapter, rawListing, titleMatches, withinWindow, relativeDate, validateTerm, decodeEntities } from '../src/adapters/base.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const WINDOW = new Date(NOW.getTime() - 7 * 86400000);

/**
 * Adapter that yields `perPage` listings per page for `pages` pages, with
 * postedAt from a function of (page, i). Records the directives it saw.
 * @param {{ pages: number, perPage: number, postedAt: (p: number, i: number) => string|null, dateOrdered?: boolean, queries?: string[] }} o
 */
function fakeAdapter(o) {
  /** @type {Array<{ query: string, pageIndex: number, directive: any }>} */
  const seen = [];
  const adapter = defineAdapter({
    name: 'fake',
    needsBrowser: false,
    dateOrdered: o.dateOrdered ?? true,
    domains: ['fake.test'],
    pathPatterns: ['^/'],
    blindSpots: [],
    async *search() {
      for (const query of o.queries ?? ['q1']) {
        for (let pageIndex = 1; pageIndex <= o.pages; pageIndex++) {
          let stop = false;
          for (let i = 0; i < o.perPage; i++) {
            const d = yield { kind: 'listing', query, pageIndex, listing: rawListing({ source: 'fake', url: `https://fake.test/${query}/${pageIndex}/${i}`, title: `T${pageIndex}-${i}`, company: 'C', postedAt: o.postedAt(pageIndex, i) }) };
            if (d && d.stopQuery) {
              stop = true;
              break;
            }
          }
          const d = yield { kind: 'batch', query, pageIndex, parsed: o.perPage };
          seen.push({ query, pageIndex, directive: d });
          if (stop || (d && d.stopQuery)) break;
        }
      }
    },
  });
  return { adapter, seen };
}

/** @returns {import('../src/adapters/base.js').AdapterCtx} */
function ctx() {
  const ac = new AbortController();
  return /** @type {any} */ ({ signal: ac.signal, now: NOW, windowStart: WINDOW, maxPages: 5, log() {} });
}
const profile = /** @type {any} */ ({ name: 'p', keywords: [], phrases: [], exclude_terms: [], locations: [], remote: 'any', posted_within_days: 7, max_pages: 3, sources: [] });

describe('scheduler', () => {
  test('stops a query after maxPages even though the adapter has more pages', async () => {
    const { adapter, seen } = fakeAdapter({ pages: 10, perPage: 2, postedAt: () => '2026-08-24' });
    const got = [];
    const r = await runSearch(adapter, profile, ctx(), { onListing: async (ev) => { got.push(ev.listing.title); } }, { maxPages: 3, windowStart: WINDOW });
    assert.equal(r.pages, 3);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[2].directive, { stopQuery: true });
    assert.equal(got.length, 6);
    assert.equal(r.queries.q1.stoppedBy, 'maxPages');
    assert.equal(r.completed, true);
    assert.equal(r.deepestPage, 3);
  });

  test('stops after 3 consecutive results older than the window and drops them (date-ordered source)', async () => {
    // page 1: 2 fresh then 3 stale then 2 fresh (never reached)
    const dates = ['2026-08-24', '2026-08-23', '2026-01-01', '2026-01-02', '2026-01-03', '2026-08-22', '2026-08-21'];
    const { adapter } = fakeAdapter({ pages: 4, perPage: 7, postedAt: (p, i) => dates[i] });
    const got = [];
    const r = await runSearch(adapter, profile, ctx(), { onListing: async (ev) => { got.push(ev.listing.postedAt); } }, { maxPages: 5, windowStart: WINDOW });
    assert.deepEqual(got, ['2026-08-24', '2026-08-23']);
    assert.equal(r.stale, STALE_LIMIT);
    assert.equal(r.queries.q1.stoppedBy, 'stale');
    assert.equal(r.pages, 1, 'the page that hit the stale limit is still counted; no further page is fetched');
  });

  test('a fresh result resets the consecutive-stale counter', async () => {
    const dates = ['2026-01-01', '2026-01-02', '2026-08-24', '2026-01-03', '2026-01-04', '2026-08-23'];
    const { adapter } = fakeAdapter({ pages: 1, perPage: 6, postedAt: (p, i) => dates[i] });
    const got = [];
    const r = await runSearch(adapter, profile, ctx(), { onListing: async (ev) => { got.push(ev.listing.postedAt); } }, { maxPages: 5, windowStart: WINDOW });
    assert.deepEqual(got, ['2026-08-24', '2026-08-23']);
    assert.equal(r.stale, 4);
    assert.equal(r.queries.q1.stoppedBy, null, 'one page only: neither cap was hit');
  });

  test('unordered sources (staleLimit Infinity) drop stale rows but never stop the query on them', async () => {
    const { adapter } = fakeAdapter({ pages: 2, perPage: 5, postedAt: (p, i) => (i < 4 ? '2026-01-01' : '2026-08-24'), dateOrdered: false });
    const got = [];
    const r = await runSearch(adapter, profile, ctx(), { onListing: async (ev) => { got.push(ev.pageIndex); } }, { maxPages: 5, windowStart: WINDOW, staleLimit: Number.POSITIVE_INFINITY });
    assert.deepEqual(got, [1, 2]);
    assert.equal(r.stale, 8);
    assert.equal(r.pages, 2);
  });

  test('listings without a date are inside the window', async () => {
    const { adapter } = fakeAdapter({ pages: 1, perPage: 4, postedAt: () => null });
    let n = 0;
    const r = await runSearch(adapter, profile, ctx(), { onListing: async () => { n++; } }, { maxPages: 1, windowStart: WINDOW });
    assert.equal(n, 4);
    assert.equal(r.stale, 0);
  });

  test('wall event with stopSource ends the adapter; without it only the query stops', async () => {
    const adapter = defineAdapter({
      name: 'walls', needsBrowser: true, dateOrdered: true, domains: ['w.test'], pathPatterns: ['^/'], blindSpots: [],
      async *search() {
        yield { kind: 'wall', query: 'a', pageIndex: 1, signals: { parsed: 0, emptyState: true } };
        yield { kind: 'batch', query: 'a', pageIndex: 1, parsed: 0 };
        yield { kind: 'wall', query: 'b', pageIndex: 1, signals: { parsed: 0, status: 403 } };
        yield { kind: 'listing', query: 'c', pageIndex: 1, listing: rawListing({ source: 'walls', url: 'https://w.test/1', title: 'never', company: 'x' }) };
      },
    });
    const walls = [];
    let listed = 0;
    const r = await runSearch(adapter, profile, ctx(), {
      onListing: async () => { listed++; },
      onWall: async (ev) => { walls.push(ev.query); return { stopSource: ev.signals.status === 403 }; },
    }, { maxPages: 3, windowStart: null });
    assert.deepEqual(walls, ['a', 'b']);
    assert.equal(listed, 0);
    assert.equal(r.stoppedBy, 'wall');
    assert.equal(r.completed, false);
  });

  test('abort signal stops the generator with CANCELLED', async () => {
    const { adapter } = fakeAdapter({ pages: 5, perPage: 2, postedAt: () => '2026-08-24' });
    const ac = new AbortController();
    const c = /** @type {any} */ ({ signal: ac.signal, now: NOW, windowStart: WINDOW, maxPages: 5, log() {} });
    let n = 0;
    await assert.rejects(
      runSearch(adapter, profile, c, { onListing: async () => { n++; if (n === 3) ac.abort(); } }, { maxPages: 5, windowStart: WINDOW }),
      (/** @type {any} */ e) => e.code === 'CANCELLED',
    );
    assert.equal(n, 3);
  });

  test('warnings are counted and forwarded', async () => {
    const adapter = defineAdapter({
      name: 'warn', needsBrowser: false, dateOrdered: false, domains: ['w.test'], pathPatterns: ['^/'], blindSpots: [],
      async *search() {
        yield { kind: 'warning', code: 'UNRENDERABLE', message: 'js only' };
        yield { kind: 'batch', query: 'q', pageIndex: 1, parsed: 0 };
      },
    });
    const codes = [];
    const r = await runSearch(adapter, profile, ctx(), { onListing: async () => {}, onWarning: async (ev) => { codes.push(ev.code); } }, { maxPages: 1, windowStart: null });
    assert.deepEqual(codes, ['UNRENDERABLE']);
    assert.equal(r.warnings, 1);
    assert.equal(r.completed, true);
  });
});

describe('ratelimit', () => {
  test('jitter stays within the range and backoff doubles up to the cap; Retry-After raises the delay', () => {
    assert.equal(jitter([4000, 9000], () => 0), 4000);
    assert.equal(jitter([4000, 9000], () => 0.999), 8995);
    assert.equal(backoffDelay(0, { maxDelayMs: 300000 }), 5000);
    assert.equal(backoffDelay(3, { maxDelayMs: 300000 }), 40000);
    assert.equal(backoffDelay(10, { maxDelayMs: 300000 }), 300000);
    assert.equal(backoffDelay(0, { maxDelayMs: 300000 }, '30'), 30000);
    assert.equal(backoffDelay(0, { maxDelayMs: 300000 }, '9999'), 300000);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(500), false);
    assert.equal(isRetryableStatus(200), false);
  });

  test('per-key concurrency 1 with the jittered gap; different keys do not wait on each other', async () => {
    let clock = 0;
    const slept = [];
    const rl = makeRateLimiter({ delayMs: [1000, 1000], backoff: { maxDelayMs: 1000, retries: 0 }, sleep: async (ms) => { slept.push(ms); clock += ms; }, random: () => 0, now: () => clock });
    await rl.wait('a');
    await rl.wait('a');
    await rl.wait('b');
    assert.deepEqual(slept, [1000]);
    assert.equal(rl.stats().waits, 3);
  });

  test('withRetry backs off on 429/503 and aborts the adapter after `retries`', async () => {
    const slept = [];
    const rl = makeRateLimiter({ delayMs: [0, 0], backoff: { maxDelayMs: 20000, retries: 3, baseMs: 1000 }, sleep: async (ms) => { slept.push(ms); }, random: () => 0, now: () => 0 });
    let calls = 0;
    const r = await rl.withRetry('h', async () => { calls++; return { status: calls < 3 ? 503 : 200 }; });
    assert.equal(r.status, 200);
    assert.equal(calls, 3);
    assert.deepEqual(slept, [1000, 2000]);
    calls = 0;
    await assert.rejects(rl.withRetry('h', async () => { calls++; return { status: 429, retryAfter: '2' }; }), (/** @type {any} */ e) => e.code === 'ADAPTER_ABORTED');
    assert.equal(calls, 4, 'initial try plus 3 retries');
    assert.equal(rl.stats().aborted, 1);
  });

  test('sleep rejects with CANCELLED when the signal aborts', async () => {
    const ac = new AbortController();
    const p = sleep(10000, ac.signal);
    ac.abort();
    await assert.rejects(p, (/** @type {any} */ e) => e.code === 'CANCELLED');
  });
});

describe('adapter base helpers', () => {
  test('titleMatches: substring for long terms, whole-token for short acronyms, exclude wins', () => {
    const p = /** @type {any} */ ({ keywords: ['CTO', 'Chief Technology Officer'], phrases: ['VP Technology'], exclude_terms: ['Assistant'] });
    assert.equal(titleMatches('Chief Technology Officer', p), true);
    assert.equal(titleMatches('CTO, Platform', p), true);
    assert.equal(titleMatches('Director', p), false);
    assert.equal(titleMatches('Assistant to the CTO', p), false);
    assert.equal(titleMatches('Octopus wrangler', p), false, 'cto inside a word is not a match');
    assert.equal(titleMatches('anything', /** @type {any} */ ({ keywords: [], phrases: [] })), true);
  });

  test('withinWindow, relativeDate, validateTerm, decodeEntities', () => {
    assert.equal(withinWindow('2026-08-24', WINDOW), true);
    assert.equal(withinWindow('2026-08-01', WINDOW), false);
    assert.equal(withinWindow(null, WINDOW), true);
    assert.equal(withinWindow('garbage', WINDOW), true);
    assert.equal(relativeDate('Posted Today', NOW), '2026-08-25');
    assert.equal(relativeDate('Posted Yesterday', NOW), '2026-08-24');
    assert.equal(relativeDate('Posted 3 Days Ago', NOW), '2026-08-22');
    assert.equal(relativeDate('Posted 30+ Days Ago', NOW), '2026-07-26');
    assert.equal(relativeDate('whenever', NOW), null);
    assert.equal(validateTerm(" VP Payments Strategy ", 'k'), 'VP Payments Strategy');
    assert.throws(() => validateTerm('drop table; --', 'keyword'), (/** @type {any} */ e) => e.code === 'VALIDATION');
    assert.throws(() => validateTerm('a'.repeat(81), 'keyword'), (/** @type {any} */ e) => e.code === 'VALIDATION');
    assert.equal(decodeEntities('&lt;p&gt;A &amp; B &#39;x&#39; &#x41;&lt;/p&gt;'), "<p>A & B 'x' A</p>");
  });
});
