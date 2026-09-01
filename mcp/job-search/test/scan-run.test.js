// @ts-check
/**
 * Persisted run path against the real DB with the synthetic ZZ-TEST-SCAN
 * Greenhouse board: inserts, run items, prescore, detail fetch through the
 * prescore gate, second run = update, expiry after absent runs, lock
 * contention, wait=false, cancel via the run row, and source disable.
 * Everything created is deleted in after().
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { LOCK_KEY, resolveSources, fetchDetailForRow } from '../src/core/scan-run.js';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, testConfig, makeFixtureFetch, DEFAULT_MAP, makeFakeSession, memoryReserve, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { untrustedRows } from '../src/core/compact.js';

const [ROWS_OPEN, , ROWS_CLOSE] = untrustedRows(['x']);

const PROFILE = `zz-test-scan-${process.pid}`;
/** @type {import('pg').Client} */
let client;

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  await client.query(`DELETE FROM ic_source_state WHERE source LIKE 'zz-test-%'`);
  // Keywords chosen so only the synthetic ZZ-TEST-SCAN board matches; the GitLab fixture (served so the board answers 200) yields nothing.
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['Chief Technology Officer', 'Chief Information Officer', 'Vice President, Technology'], phrases: [], locations: ['Houston, TX'] });
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  } finally {
    await client.end();
  }
});

/** Map that serves only the synthetic board (gitlab and lever 404) so no real-company rows are written. */
const ZZ_MAP = DEFAULT_MAP.filter((m) => m.prefix.includes('zztest') || m.prefix.includes('/gitlab/'));

describe('runScan persisted', () => {
  test('first run inserts new rows with run items, prescore, detail through the gate, and embedding attempts', async () => {
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.equal(r.stats.fetched, 2, 'CTO + VP match; engineer filtered; old CIO dropped by the window');
    assert.equal(r.stats.new, 2);
    assert.equal(r.stats.stale_dropped, 1);
    assert.equal(r.stats.unembedded, 2, 'fixture transport has no Ollama: rows stored without vectors');
    assert.equal(r.stats.detail_fetched, 1, 'only the CTO (prescore >= 40) got a detail fetch');
    const rows = await client.query(`SELECT id, title, prescore, status, fit_score, description, search_profile, profile_rev, last_page_index, times_seen, source, external_id, embedding IS NULL AS noemb FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN' ORDER BY id`);
    assert.equal(rows.rowCount, 2);
    for (const row of rows.rows) {
      assert.equal(row.status, null, 'branch-5 inserts leave status NULL');
      assert.equal(row.fit_score, null);
      assert.equal(row.search_profile, PROFILE);
      assert.ok(row.profile_rev);
      assert.equal(row.last_page_index, 1);
      assert.equal(row.times_seen, 1);
      assert.equal(row.source, 'greenhouse');
      assert.ok(row.external_id.startsWith('greenhouse:zztest/'));
      assert.equal(row.noemb, true);
      assert.ok(row.prescore >= 0);
    }
    const cto = rows.rows.find((x) => x.title === 'Chief Technology Officer');
    // Stage 1's normalizeListing stores the pipeline text (lowercased) as description; compare case-insensitively.
    assert.ok(cto && cto.prescore >= 40 && cto.description && /reports to the ceo/i.test(cto.description), JSON.stringify(cto));
    const items = await client.query('SELECT listing_id, outcome, page_index FROM ic_scan_run_items WHERE run_id = $1 ORDER BY listing_id', [r.run_id]);
    assert.equal(items.rowCount, 2);
    assert.ok(items.rows.every((i) => i.outcome === 'new' && i.page_index === 1));
    assert.equal(r.rows[0], ROWS_OPEN, 'rows wrapped in the untrusted delimiter');
    assert.equal(r.rows[r.rows.length - 1], ROWS_CLOSE, 'rows wrapped in the untrusted delimiter');
    assert.ok(r.rows.slice(1, -1).every((/** @type {string} */ line) => /^#\d+ \| /.test(line)), 'real ids in rows');
    assert.match(r.hint, /query_jobs\(\{runId:\d+/);
    const state = await client.query(`SELECT consecutive_walls FROM ic_source_state WHERE source = 'greenhouse'`);
    assert.equal(state.rows[0].consecutive_walls, 0, 'clean run recorded');
  });

  test('second run is all updates: times_seen bumps once, no new rows, no queue rows', async () => {
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.equal(r.stats.updated, 2);
    assert.equal(r.stats.new, 0);
    assert.equal(r.stats.detail_fetched, 0, 'updates never fetch detail');
    const rows = await client.query(`SELECT times_seen, absent_runs, expired_at FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN'`);
    assert.ok(rows.rows.every((x) => x.times_seen === 2 && x.absent_runs === 0 && x.expired_at === null));
    const q = await client.query(`SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN')`);
    assert.equal(q.rows[0].n, 0);
  });

  test('expiry: a listing absent from three completed runs of the same profile expires; unchanged profile keeps counting', async () => {
    // Serve a board where the VP posting is gone.
    const jobs = JSON.parse(JSON.stringify(await import('./helpers/scan-fixtures.js').then((m) => m.readJsonFixture('adapters/greenhouse-zztest-jobs.json'))));
    jobs.jobs = jobs.jobs.filter((/** @type {any} */ j) => j.id !== 7000000002);
    const map = [{ prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs/7000000001', file: 'adapters/greenhouse-zztest-detail.json' }, { prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs', body: JSON.stringify(jobs) }, ...DEFAULT_MAP.filter((m) => m.prefix.includes('/gitlab/'))];
    for (let i = 1; i <= 3; i++) {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, offlineDeps({ fetch: makeFixtureFetch(map) }), { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
      assert.equal(r.status, 'ok', JSON.stringify(r.errors));
      const vp = await client.query(`SELECT absent_runs, expired_at, stale FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN' AND external_id = 'greenhouse:zztest/7000000002'`);
      assert.equal(vp.rows[0].absent_runs, i);
      if (i < 3) {
        assert.equal(vp.rows[0].expired_at, null);
        assert.equal(r.stats.expired, 0);
      } else {
        assert.ok(vp.rows[0].expired_at, 'expired after 3 absent runs');
        assert.equal(r.stats.expired, 1);
      }
      const cto = await client.query(`SELECT absent_runs FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN' AND external_id = 'greenhouse:zztest/7000000001'`);
      assert.equal(cto.rows[0].absent_runs, 0, 'seen rows are untouched');
    }
    // Repost of the expired listing on the next run with the same id reopens it (1a-repost-same-id).
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) }), { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.stats.repost, 1, JSON.stringify(r.stats));
    const vp = await client.query(`SELECT absent_runs, expired_at FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN' AND external_id = 'greenhouse:zztest/7000000002'`);
    assert.equal(vp.rows[0].expired_at, null);
    assert.equal(vp.rows[0].absent_runs, 0);
  });

  test('a profile change resets absent_runs for that profile', async () => {
    await client.query(`UPDATE ic_job_listings SET absent_runs = 2 WHERE company = 'ZZ-TEST-SCAN'`);
    await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['Chief Technology Officer', 'Chief Information Officer', 'Vice President, Technology', 'Chief Digital Officer'], phrases: [], locations: ['Houston, TX'] });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) }), { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.status, 'ok');
    const rows = await client.query(`SELECT absent_runs, profile_rev FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN'`);
    assert.ok(rows.rows.every((x) => x.absent_runs === 0));
  });

  test('lock contention returns status locked in under a second and does not create a run row', async () => {
    const holder = await newClient();
    try {
      const got = await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
      if (!got.rows[0].ok) {
        // another test file holds it right now; wait for it, then take it ourselves
        for (let i = 0; i < 400; i++) {
          await new Promise((res) => setTimeout(res, 250));
          const again = await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
          if (again.rows[0].ok) break;
        }
      }
      const before = await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE]);
      const t0 = Date.now();
      const { runScan } = await import('../src/core/scan-run.js');
      const r = /** @type {any} */ (await runScan({ profile: PROFILE, dryRun: true, wait: true }, offlineDeps(), { trigger: 'mcp', log: () => {} }));
      assert.equal(r.ok, false);
      assert.equal(r.status, 'locked');
      assert.ok(Date.now() - t0 < 1000);
      const afterCount = await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE]);
      assert.equal(afterCount.rows[0].n, before.rows[0].n);
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
    } finally {
      await holder.end();
    }
  });

  test('wait=false returns the run id immediately and the run finishes in the background', async () => {
    const { runScan } = await import('../src/core/scan-run.js');
    let r;
    for (let i = 0; i < 400; i++) {
      r = /** @type {any} */ (await runScan({ profile: PROFILE, sources: ['greenhouse'], dryRun: true, wait: false }, offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) }), { trigger: 'mcp', log: () => {} }));
      if (r.status !== 'locked') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal(r.ok, true);
    assert.equal(r.status, 'running');
    assert.ok(r.run_id > 0);
    let row;
    for (let i = 0; i < 100; i++) {
      row = (await client.query('SELECT status, finished_at FROM ic_scan_runs WHERE id = $1', [r.run_id])).rows[0];
      if (row.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(row.status, 'ok');
    assert.ok(row.finished_at);
  });

  test('cancel through the run row aborts the run (heartbeat check) and marks it failed with CANCELLED', async () => {
    // A slow fetch so the heartbeat has time to observe the cancel.
    const { runScan } = await import('../src/core/scan-run.js');
    const slowFetch = makeFixtureFetch(ZZ_MAP);
    let runId = 0;
    const deps = offlineDeps({
      fetch: async (input, init) => {
        if (runId) await client.query(`UPDATE ic_scan_runs SET status = 'failed', finished_at = now(), errors = errors || '[{"code":"CANCELLED"}]'::jsonb WHERE id = $1 AND status = 'running'`, [runId]);
        await new Promise((res) => setTimeout(res, 300));
        return slowFetch(input, init);
      },
    });
    const { HEARTBEAT_MS } = await import('../src/core/scan-run.js');
    assert.ok(HEARTBEAT_MS >= 1000);
    // The heartbeat fires every 20 s; instead of waiting, cancel via the external signal path too.
    const ac = new AbortController();
    const p = (async () => {
      for (let i = 0; i < 400; i++) {
        const r = /** @type {any} */ (await runScan({ profile: PROFILE, sources: ['greenhouse'], dryRun: true, wait: true }, deps, { trigger: 'cli', log: (f) => { if (f.evt === 'run_started') { runId = Number(f.run_id); setTimeout(() => ac.abort(), 50); } }, signal: ac.signal }));
        if (r.status !== 'locked') return r;
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error('never got the lock');
    })();
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'CANCELLED'));
    const row = await client.query('SELECT status, errors FROM ic_scan_runs WHERE id = $1', [runId]);
    assert.equal(row.rows[0].status, 'failed');
  });

  test('disabled source is skipped and reported; BROWSER_UNAVAILABLE degrades to partial', async () => {
    // dayforce, not greenhouse: scan-cli.test.js spawns a real CLI run against greenhouse in
    // parallel, and disabling the shared ic_source_state row here made that test flaky.
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('dayforce', true) ON CONFLICT (source) DO UPDATE SET manual_disable = true`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['dayforce', 'indeed'], dryRun: true, wait: true }, offlineDeps({ connectSession: async () => { throw Object.assign(new Error('no cdp'), { code: 'BROWSER_UNAVAILABLE' }); } }), { trigger: 'mcp', log: () => {} });
      assert.equal(r.status, 'partial');
      assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'SOURCE_DISABLED' && e.source === 'dayforce'));
      assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'BROWSER_UNAVAILABLE'));
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'dayforce'`);
    }
  });

  test('resolveSources refuses unknown names; fetchDetailForRow refuses browser sources and serves fetch sources', async () => {
    const config = testConfig();
    assert.throws(() => resolveSources(['greenhouse', 'bogus'], config), (/** @type {any} */ e) => e.code === 'VALIDATION');
    assert.throws(() => resolveSources([], config), (/** @type {any} */ e) => e.code === 'VALIDATION');
    assert.deepEqual(resolveSources(['Greenhouse', 'lever', 'greenhouse'], config).map((s) => s.name), ['greenhouse', 'lever']);
    const deps = { ...offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) }), withClient: async (/** @type {any} */ fn) => fn(client) };
    await assert.rejects(fetchDetailForRow({ id: 1, source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1', url_normalized: null, external_id: null }, deps), (/** @type {any} */ e) => e.code === 'VALIDATION');
    const d = await fetchDetailForRow({ id: 1, source: 'greenhouse', url: 'https://boards.greenhouse.io/zztest/jobs/7000000001', url_normalized: 'https://boards.greenhouse.io/zztest/jobs/7000000001', external_id: 'greenhouse:zztest/7000000001' }, deps);
    assert.ok(d.description && d.description.includes('ZZ-TEST-SCAN synthetic detail'));
  });

  test('browser source (indeed) honors its configured delayMs between consecutive page.goto calls', async () => {
    // PROFILE (see before()) has three keyword terms and one location, so indeed's
    // adapter loop does one cap.goto per term (the fixture card count is below
    // PAGE_SIZE, so pagination breaks after page 1 of each term) -- at least two
    // goto calls, which is what this test needs to observe an inter-navigation gap.
    // A rate limiter shared with fetchText, keyed by source rather than host, is
    // exactly what browser/capability.js's onPage hook is for (spec section 4);
    // before this fix capFor() never passed onPage at all, so browser sources
    // ignored delayMs entirely -- see mcp/job-search/config/adapters.json's indeed
    // entry (delayMs [4000,9000], spec R5.1: the per-request delay must RISE to
    // reduce 429s, never fall) that this test pins against.
    /** @type {Array<{ t: 'goto'|'sleep', url?: string, ms?: number }>} */
    const events = [];
    const sleep = async (/** @type {number} */ ms) => {
      events.push({ t: 'sleep', ms });
    };
    const fake = makeFakeSession({
      recorder: /** @type {any} */ ({ push: (/** @type {any} */ e) => events.push({ t: 'goto', url: e.url }) }),
      indeedCards: [
        { jobkey: 'a1b2c3d4e5f60718', title: 'Chief Technology Officer', company: 'ZZ-TEST-SCAN', location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: null },
      ],
    });
    // random: 0.5 (not offlineDeps' default 0) pins jitter mid-range (~6500ms) so the
    // real wall-clock time spent on the DB round trips inside classify()/prescore()
    // between navigations (a few ms, even in a dry run) can never push the observed
    // sleep below the configured 4000ms floor -- that is a real-clock artifact of
    // ratelimit.js's `due - now()` math, not something this delayMs test should be
    // sensitive to.
    const deps = offlineDeps({ sleep, connectSession: fake.connectSession, random: () => 0.5 });
    // indeed's ic_source_state row is real, shared, cross-file state (SOURCE_DISABLED
    // gates the source before capFor is ever called); force it enabled around this
    // test so it never depends on -- or leaks into -- whatever another test or a real
    // scan left behind (mirrors the dayforce reset a few tests up).
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: true, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));

      const gotos = events.map((e, i) => ({ ...e, i })).filter((e) => e.t === 'goto');
      assert.ok(gotos.length >= 2, `expected >=2 indeed page.goto calls to observe a gap, got ${gotos.length}: ${JSON.stringify(events)}`);
      // No wait before the very first navigation.
      assert.equal(events[0].t, 'goto', `first recorded event must be the first goto, got ${JSON.stringify(events[0])}`);
      // Exactly one wait between the 1st and 2nd goto, sized within the configured [4000,9000] range.
      const between = events.slice(gotos[0].i + 1, gotos[1].i).filter((e) => e.t === 'sleep');
      assert.equal(between.length, 1, `expected exactly one sleep between the 1st and 2nd goto, got ${JSON.stringify(between)} in ${JSON.stringify(events)}`);
      assert.ok(between[0].ms >= 4000 && between[0].ms <= 9000, `delay ${between[0].ms}ms outside indeed's configured delayMs [4000,9000]`);
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
    }
  });

  test('R4: detail fetches spend a scarce budget on the higher-prescore row, not array/page order', async () => {
    // Two cards on the SAME page: the lower-prescore one appears FIRST (array/arrival order), the
    // higher-prescore one SECOND. With exactly one detail fetch left in the daily budget, the OLD
    // inline-as-encountered behavior would have spent it on the first (lower) card; the sorted pass
    // (spec R4.1) must spend it on the second (higher) card instead. Company is distinct from the
    // ZZ-TEST-SCAN rows other tests in this file persist (a real CTO@ZZ-TEST-SCAN@Houston-TX row already
    // exists by this point in the suite, which would make an indeed CTO card here a cross_source_dup --
    // decision-20 ineligible for the detail queue -- rather than the 'new' row this test needs).
    const CO4 = 'ZZ-TEST-SCAN-R4';
    const lowCard = { jobkey: 'aaaa11112222bbbb', title: 'Chief Information Officer', company: CO4, location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: null };
    const highCard = { jobkey: 'cccc33334444dddd', title: 'Chief Technology Officer', company: CO4, location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: '$300,000 - $350,000' };
    const fake = makeFakeSession({ indeedCards: [lowCard, highCard] });
    const deps = offlineDeps({ connectSession: fake.connectSession, reserveBudget: memoryReserve({ details: 99 }) });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
      assert.equal(r.stats.detail_fetched, 1, 'only one detail fetch: the daily budget had exactly one left');
      const rows = await client.query(`SELECT title, description, prescore, detail_skipped FROM ic_job_listings WHERE company = $1`, [CO4]);
      const cio = rows.rows.find((x) => x.title === 'Chief Information Officer');
      const cto = rows.rows.find((x) => x.title === 'Chief Technology Officer');
      assert.ok(cio && cto, 'both rows persisted');
      assert.ok(cto.prescore > cio.prescore, `CTO (${cto.prescore}) must outrank CIO (${cio.prescore}) for this test to prove anything`);
      assert.ok(cto.description, 'the HIGHER-prescore row (arrived second) got the one available detail fetch');
      assert.equal(cio.description, null, 'the LOWER-prescore row (arrived first) did NOT get the detail fetch, even though it was encountered first');
      assert.equal(cio.detail_skipped, true, 'the skipped row is marked detail_skipped (decision 22)');
      assert.ok(r.stats.detail_skipped_budget >= 1);
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
      await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO4]);
      await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO4]);
      await client.query(`UPDATE ic_job_listings SET duplicate_of = NULL, repost_of = NULL WHERE company = $1`, [CO4]);
      await client.query(`DELETE FROM ic_followups WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO4]);
      await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CO4]);
    }
  });

  test('R5: indeed stops at its per-run page cap even with budget and pages remaining (maxPagesPerRun)', async () => {
    // The synthetic ZZ-TEST-SCAN indeed fixture always returns exactly one card below PAGE_SIZE, so a
    // normal run's own pagination already stops after one page per query; this test instead proves the
    // per-run cap is ENFORCED as a distinct mechanism by setting it to 0 (via a fresh config clone) so
    // reservePage() must refuse the very first page, mirroring a real BUDGET_EXHAUSTED degrade.
    const cfg = testConfig();
    const capped = { ...cfg, adapters: { ...cfg.adapters, adapters: { ...cfg.adapters.adapters, indeed: { ...cfg.adapters.adapters.indeed, maxPagesPerRun: 0 } } } };
    const fake = makeFakeSession({ indeedCards: [{ jobkey: 'eeee55556666ffff', title: 'Chief Technology Officer', company: 'ZZ-TEST-SCAN', location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: null }] });
    const deps = offlineDeps({ config: capped, connectSession: fake.connectSession });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: true, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.equal(r.status, 'partial', 'the per-run page cap degrades the source, like the daily cap does');
      assert.ok(r.errors.some((e) => e.source === 'indeed' && e.code === 'BUDGET_EXHAUSTED' && /per-run page cap/.test(e.message)), JSON.stringify(r.errors));
      assert.equal(r.stats.fetched, 0, 'zero pages ever navigated');
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
    }
  });
});
