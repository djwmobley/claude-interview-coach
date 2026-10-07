// @ts-check
/**
 * Fan-out plan, per-run cap, and the atomic daily budget against the real
 * ic_scan_budget table (source zz-test-budget-<pid>, deleted afterwards).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { planPages, assertPlanWithinCap, reserveBudget, remainingBudget, budgetDay, shuffle } from '../src/core/budget.js';
import { newClient, testConfig } from './helpers/scan-fixtures.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { reserveWorkdayAttempt, refundWorkdayAttempt } from '../src/core/easy-apply-state.js';

const SRC = `zz-test-budget-${process.pid}`;
/** @type {import('pg').Client} */
let client;

before(async () => {
  client = await newClient();
  await client.query('DELETE FROM ic_scan_budget WHERE source LIKE $1', ['zz-test-budget-%']);
});
after(async () => {
  try {
    await client.query('DELETE FROM ic_scan_budget WHERE source LIKE $1', ['zz-test-budget-%']);
  } finally {
    await client.end();
  }
});

describe('planPages', () => {
  const cfg = testConfig().adapters;
  test('browser sources count terms x locations x min(maxPages, maxPagesPerQuery); fetch sources one per query', () => {
    const plan = planPages({ keywords: ['CTO', 'CIO'], phrases: ['VP Technology'], locations: ['Houston, TX', 'Dallas, TX'], maxPages: 5, sources: ['linkedin', 'indeed', 'greenhouse'] }, cfg);
    assert.equal(plan.bySource.linkedin, 3 * 2 * 3, 'linkedin clamps to 3 pages');
    assert.equal(plan.bySource.indeed, 3 * 2 * 5);
    assert.equal(plan.bySource.greenhouse, 3 * 2 * 1);
    assert.equal(plan.planned, 18 + 30 + 6);
    assert.equal(plan.queries.length, 18);
  });
  test('duplicate terms collapse; unknown sources are ignored; empty locations still plan one query', () => {
    const plan = planPages({ keywords: ['CTO', 'cto', 'CTO '], phrases: [], locations: [], maxPages: 1, sources: ['indeed', 'nope'] }, cfg);
    assert.equal(plan.bySource.indeed, 2, 'CTO and cto are distinct strings after trim');
    assert.equal(plan.bySource.nope, undefined);
  });
  test('assertPlanWithinCap refuses with BUDGET_EXCEEDED', () => {
    const plan = planPages({ keywords: Array.from({ length: 20 }, (_, i) => `k${i}`), phrases: [], locations: ['a', 'b'], maxPages: 5, sources: ['indeed'] }, cfg);
    assert.equal(plan.planned, 200);
    assert.throws(() => assertPlanWithinCap(plan, 120), (/** @type {any} */ e) => e.code === 'BUDGET_EXCEEDED' && e.details.planned === 200);
    assert.doesNotThrow(() => assertPlanWithinCap(plan, 200));
  });
  test('shuffle keeps the multiset', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const b = shuffle([...a]);
    assert.deepEqual([...b].sort(), a);
  });

  test('R13: ADAPTERS.gmail.ignoresQuery is true and no other adapter sets it', () => {
    assert.equal(ADAPTERS.gmail.ignoresQuery, true);
    for (const [name, a] of Object.entries(ADAPTERS)) {
      if (name === 'gmail') continue;
      assert.notEqual(a.ignoresQuery, true, `${name} must not set ignoresQuery`);
    }
  });

  test('R13: a source in the ignoresQuery set plans exactly min(maxPages, maxPagesPerQuery), independent of terms/locations', () => {
    const plan = planPages({ keywords: ['CTO', 'CIO', 'Chief'], phrases: ['VP Technology'], locations: ['Houston, TX', 'Dallas, TX'], maxPages: 3, sources: ['gmail', 'greenhouse'] }, cfg, new Set(['gmail']));
    assert.equal(plan.bySource.gmail, Math.min(3, cfg.adapters.gmail.maxPagesPerQuery), 'gmail plans one query total, not terms x locations');
    assert.equal(plan.bySource.greenhouse, 8, 'greenhouse is unaffected: 4 terms x 2 locations x 1 (fetch transport)');
    assert.equal(plan.queries.filter((q) => q.source === 'gmail').length, 1, 'gmail contributes exactly one entry to the randomized query list');
    assert.equal(plan.planned, plan.bySource.gmail + plan.bySource.greenhouse);
  });

  test('R13: without an ignoresQuery set, gmail falls back to the old fetch-transport math (1 page per term x location)', () => {
    const plan = planPages({ keywords: ['CTO', 'CIO'], phrases: [], locations: ['Houston, TX'], maxPages: 3, sources: ['gmail'] }, cfg);
    assert.equal(plan.bySource.gmail, 2, 'fetch transport: 1 page per (term x location), no ignoresQuery set supplied');
  });

  test('R13: a maxPages below maxPagesPerQuery clamps the ignoresQuery plan to maxPages', () => {
    const plan = planPages({ keywords: [], phrases: [], locations: [], maxPages: 1, sources: ['gmail'] }, cfg, new Set(['gmail']));
    assert.equal(plan.bySource.gmail, 1);
  });
});

describe('reserveBudget (real DB)', () => {
  test('reservations are atomic and stop exactly at the cap; details and pages are independent', async () => {
    const caps = { dailyPages: 3, dailyDetails: 2 };
    const r1 = await reserveBudget(client, SRC, { pages: 1 }, caps);
    assert.deepEqual(r1, { ok: true, remainingPages: 2, remainingDetails: 2 });
    // Two concurrent reservations of 2 pages each: only one can fit.
    const [a, b] = await Promise.all([reserveBudget(client, SRC, { pages: 2 }, caps), reserveBudget(client, SRC, { pages: 2 }, caps)]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
    const rem = await remainingBudget(client, SRC, caps);
    assert.equal(rem.pages, 0);
    assert.equal(rem.details, 2);
    const d = await reserveBudget(client, SRC, { details: 2 }, caps);
    assert.equal(d.ok, true);
    assert.equal(d.remainingDetails, 0);
    const d2 = await reserveBudget(client, SRC, { details: 1 }, caps);
    assert.equal(d2.ok, false);
    const row = await client.query('SELECT pages, details FROM ic_scan_budget WHERE source = $1 AND day = $2', [SRC, budgetDay()]);
    assert.deepEqual(row.rows[0], { pages: 3, details: 2 });
  });
  test('a new day starts from zero', async () => {
    const tomorrow = new Date(Date.now() + 86400000);
    const r = await reserveBudget(client, SRC, { pages: 1 }, { dailyPages: 1, dailyDetails: 0 }, tomorrow);
    assert.equal(r.ok, true);
    assert.equal(r.remainingPages, 0);
  });
});

describe('budgetDay with a timezone (unblock-auto-apply Item 5, A7)', () => {
  test('without a timezone it stays the UTC date', () => {
    assert.equal(budgetDay(new Date('2026-10-08T01:00:00Z')), '2026-10-08');
  });
  test('with America/Chicago, 20:00 Central on 10-07 is still the 10-07 local day', () => {
    assert.equal(budgetDay(new Date('2026-10-08T01:00:00Z'), 'America/Chicago'), '2026-10-07');
    assert.equal(budgetDay(new Date('2026-10-08T05:30:00Z'), 'America/Chicago'), '2026-10-08');
  });
});

describe('workday_assisted pool counts by the America/Chicago local day (A7)', () => {
  const WD = 'workday_assisted';
  test('an attempt at 20:00 Central does not reduce the next local day\'s cap; the refund uses the stored day', async () => {
    await client.query('DELETE FROM ic_scan_budget WHERE source = $1', [WD]);
    try {
      const evening = new Date('2026-10-08T01:00:00Z'); // 20:00 CDT on 2026-10-07, already 10-08 in UTC
      const r = await reserveWorkdayAttempt(client, { daily: 1, now: evening });
      assert.equal(r.ok, true);
      assert.equal(/** @type {any} */ (r).day, '2026-10-07', 'the charge records the local day it was made on');
      const nextMorning = new Date('2026-10-08T12:00:00Z'); // 07:00 CDT on 2026-10-08
      const rem = await remainingBudget(client, WD, { dailyPages: 1, dailyDetails: 1 }, nextMorning, 'America/Chicago');
      assert.equal(rem.pages, 1, 'the next local morning still has the whole cap');
      const morning = await reserveWorkdayAttempt(client, { daily: 1, now: nextMorning });
      assert.equal(morning.ok, true);
      // Refund the evening charge against its stored day, even though "now" is already the next day.
      await refundWorkdayAttempt(client, { day: '2026-10-07' });
      const rows = (await client.query('SELECT day::text AS day, pages FROM ic_scan_budget WHERE source = $1 ORDER BY day', [WD])).rows;
      assert.deepEqual(rows.map((x) => [x.day, x.pages]), [['2026-10-07', 0], ['2026-10-08', 1]]);
    } finally {
      await client.query('DELETE FROM ic_scan_budget WHERE source = $1', [WD]);
    }
  });
  test('LinkedIn pools stay on the UTC day', async () => {
    const evening = new Date('2026-10-08T01:00:00Z');
    await reserveBudget(client, SRC, { details: 1 }, { dailyPages: 5, dailyDetails: 5 }, evening);
    const row = await client.query('SELECT day::text AS day FROM ic_scan_budget WHERE source = $1 AND details > 0 ORDER BY day DESC LIMIT 1', [SRC]);
    assert.equal(row.rows[0].day, '2026-10-08');
  });
});
