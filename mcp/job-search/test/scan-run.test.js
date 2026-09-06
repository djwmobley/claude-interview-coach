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

  test('opts.preRunWarnings (scan-never-skip fix): a run seeded with only a warning stays status ok, and the warning rides along in the response/DB errors', async () => {
    const warning = { source: null, code: 'CONFIG_LOCK_MISMATCH', severity: 'warning', expected: 'abc', actual: 'def', missing: [], remedy: 'run node bin/config-lock.js --write' };
    const r = await runScanWaiting(
      { profile: PROFILE, sources: ['greenhouse'], dryRun: true, wait: true },
      offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) }),
      { trigger: 'mcp', log: () => {}, preRunWarnings: [warning] },
    );
    assert.equal(r.status, 'ok', 'a run carrying only a severity:\'warning\' entry must stay ok');
    assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'CONFIG_LOCK_MISMATCH' && e.severity === 'warning'));
    const row = await client.query('SELECT status, errors FROM ic_scan_runs WHERE id = $1', [r.run_id]);
    assert.equal(row.rows[0].status, 'ok');
    assert.ok(row.rows[0].errors.some((/** @type {any} */ e) => e.code === 'CONFIG_LOCK_MISMATCH'));
  });

  test('opts.preRunWarnings plus a real (non-warning) run-level error: status is partial, never ok, and the warning is still present alongside it', async () => {
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('dayforce', true) ON CONFLICT (source) DO UPDATE SET manual_disable = true`);
    try {
      const warning = { source: null, code: 'RUBRIC_UNLOCKED', severity: 'warning', remedy: 'run node bin/config-lock.js --write in the main checkout' };
      const r = await runScanWaiting(
        { profile: PROFILE, sources: ['dayforce'], dryRun: true, wait: true },
        offlineDeps(),
        { trigger: 'mcp', log: () => {}, preRunWarnings: [warning] },
      );
      assert.equal(r.status, 'partial', 'SOURCE_DISABLED is a real error, not a warning, so the warning alone cannot keep this ok');
      assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'RUBRIC_UNLOCKED' && e.severity === 'warning'));
      assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'SOURCE_DISABLED'));
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

  // ---------------------------------------------------------------------------------------------
  // scan-detail-pass fix (spec R4 item 1/2): detail pass survives list-page failure, and the total
  // detail_outcome classification (fetched/empty/error/skipped_budget/skipped_gate/skipped_cancelled/
  // not_queued) replacing the old boolean detail_skipped.
  // ---------------------------------------------------------------------------------------------

  /** Wraps a fake indeed session so `goto` throws a plain (non-JobSearchError) error for one jobkey. */
  function withThrowingGoto(baseOpts, throwForJk) {
    const base = makeFakeSession(baseOpts);
    const connectSession = async () => {
      const session = await base.connectSession();
      const realAttach = session.attachPage.bind(session);
      session.attachPage = async () => {
        const page = await realAttach();
        const realGoto = page.goto.bind(page);
        page.goto = async (url) => {
          if (String(url).includes(`jk=${throwForJk}`)) throw new Error('simulated detail fetch network failure');
          return realGoto(url);
        };
        return page;
      };
      return session;
    };
    return { connectSession, state: base.state };
  }

  test('(a) BUDGET_EXHAUSTED from a list generator still drains that source detail queue (detail_fetched > 0)', async () => {
    const cfg = testConfig();
    const capped = { ...cfg, adapters: { ...cfg.adapters, adapters: { ...cfg.adapters.adapters, indeed: { ...cfg.adapters.adapters.indeed, maxPagesPerRun: 1 } } } };
    const CO = 'ZZ-TEST-SCAN-DETAILPASS-A';
    const card = { jobkey: 'a1a1a1a1a1a1a1a1', title: 'Chief Technology Officer', company: CO, location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: '$300,000 - $350,000' };
    const fake = makeFakeSession({ indeedCards: [card] });
    const deps = offlineDeps({ config: capped, connectSession: fake.connectSession });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      // maxPagesPerRun=1 lets term 1's page succeed (queuing the one CTO card) then refuses term 2's
      // page -- the list pass fails mid-source, but the row already queued from term 1 must still get
      // its detail fetch (this is the bug this fix addresses: before it, the whole detail pass was
      // skipped whenever the list pass threw, no matter how much it had already queued).
      assert.equal(r.status, 'partial', JSON.stringify(r.errors));
      assert.ok(r.errors.some((e) => e.source === 'indeed' && e.code === 'BUDGET_EXHAUSTED' && /per-run page cap/.test(e.message)), JSON.stringify(r.errors));
      assert.ok(r.stats.detail_fetched >= 1, JSON.stringify(r.stats));
      const rows = await client.query(`SELECT detail_outcome, description FROM ic_job_listings WHERE company = $1`, [CO]);
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].detail_outcome, 'fetched');
      assert.ok(rows.rows[0].description);
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
      await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CO]);
    }
  });

  test('(b) run abort mid-detail-pass finalizes remaining items skipped_cancelled and skips expiry', async () => {
    const CO_A = 'ZZ-TEST-SCAN-DETAILPASS-B1';
    const CO_B = 'ZZ-TEST-SCAN-DETAILPASS-B2';
    const cardA = { jobkey: 'b1b1b1b1b1b1b1b1', title: 'Chief Technology Officer', company: CO_A, location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: '$300,000 - $350,000' };
    const cardB = { jobkey: 'b2b2b2b2b2b2b2b2', title: 'Chief Information Officer', company: CO_B, location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: null };
    const ac = new AbortController();
    // Abort right after item A's OWN finalizeListing starts embedding (deps.fetch, used only by
    // embedSafe in this browser-source test) -- i.e., strictly AFTER item A's detail fetch and DB write
    // have already gone through capability.js's own checkAbort() gates (which would otherwise throw a
    // plain INTERNAL error, not CANCELLED, for any cap.* call made once the signal is aborted), and
    // strictly BEFORE runDetailPass's loop reaches item B. This exercises exactly what the fix is for:
    // the loop's OWN `if (signal.aborted)` check between queued items, not an abort racing a live network
    // call inside the capability layer (a different, pre-existing failure mode this test is not about).
    let aborted = false;
    const baseFetch = makeFixtureFetch();
    const fetchWithAbort = async (input, init) => {
      if (!aborted) {
        aborted = true;
        ac.abort();
      }
      return baseFetch(input, init);
    };
    const fake = makeFakeSession({ indeedCards: [cardA, cardB] });
    const deps = offlineDeps({ connectSession: fake.connectSession, fetch: fetchWithAbort });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const { runScan } = await import('../src/core/scan-run.js');
      const r = /** @type {any} */ (await runScan({ profile: PROFILE, sources: ['indeed'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {}, signal: ac.signal }));
      assert.equal(r.status, 'failed');
      assert.ok(r.errors.some((e) => e.code === 'CANCELLED'), JSON.stringify(r.errors));
      assert.equal(r.stats.expired, 0, 'expiry never ran for the cancelled source');
      const rows = await client.query(`SELECT id, company, detail_outcome, description FROM ic_job_listings WHERE company = ANY($1::text[])`, [[CO_A, CO_B]]);
      const a = rows.rows.find((x) => x.company === CO_A);
      const b = rows.rows.find((x) => x.company === CO_B);
      assert.ok(a, 'higher-prescore row (fetched before the abort) was persisted');
      assert.equal(a.detail_outcome, 'fetched');
      assert.ok(a.description);
      assert.ok(b, 'lower-prescore row, still only QUEUED when the abort fired, is still persisted rather than silently dropped');
      assert.equal(b.detail_outcome, 'skipped_cancelled');
      assert.equal(b.description, null);
      const items = await client.query(`SELECT listing_id FROM ic_scan_run_items WHERE listing_id = ANY($1::int[])`, [[a.id, b.id].filter(Boolean)]);
      assert.ok(items.rowCount >= 1, 'a run_items row exists even for the cancelled/skipped listing');
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
      await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = ANY($1::text[]))`, [[CO_A, CO_B]]);
      await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = ANY($1::text[]))`, [[CO_A, CO_B]]);
      await client.query(`DELETE FROM ic_job_listings WHERE company = ANY($1::text[])`, [[CO_A, CO_B]]);
    }
  });

  test('(c) error and skipped_gate outcomes persist', async () => {
    const CO_ERR = 'ZZ-TEST-SCAN-DETAILPASS-C1';
    const CO_GATE = 'ZZ-TEST-SCAN-DETAILPASS-C2';
    const errCard = { jobkey: 'c1c1c1c1c1c1c1c1', title: 'Chief Technology Officer', company: CO_ERR, location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: '$300,000 - $350,000' };
    // Location deliberately NOT in the profile's own locations list (Houston, TX only) so the location
    // signal contributes 0 rather than +12, keeping this card's prescore below indeed's 55 gate while
    // still matching the profile's title keywords (so it is still collected as outcome 'new').
    const gateCard = { jobkey: 'c2c2c2c2c2c2c2c2', title: 'Chief Information Officer', company: CO_GATE, location: 'Dallas, TX', remote: false, postedMs: Date.now(), salaryText: null };
    const fake = withThrowingGoto({ indeedCards: [errCard, gateCard] }, errCard.jobkey);
    const deps = offlineDeps({ connectSession: fake.connectSession });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
      const rows = await client.query(`SELECT company, prescore, detail_outcome, description FROM ic_job_listings WHERE company = ANY($1::text[])`, [[CO_ERR, CO_GATE]]);
      const errRow = rows.rows.find((x) => x.company === CO_ERR);
      const gateRow = rows.rows.find((x) => x.company === CO_GATE);
      assert.ok(errRow, 'high-prescore row whose detail fetch threw is still persisted');
      assert.equal(errRow.detail_outcome, 'error');
      assert.equal(errRow.description, null);
      assert.ok(gateRow, 'low-prescore row is still persisted');
      assert.ok(gateRow.prescore < 55, `expected gate card below indeed's 55 gate, got ${gateRow.prescore}`);
      assert.equal(gateRow.detail_outcome, 'skipped_gate');
      assert.equal(gateRow.description, null);
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
      await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = ANY($1::text[]))`, [[CO_ERR, CO_GATE]]);
      await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = ANY($1::text[]))`, [[CO_ERR, CO_GATE]]);
      await client.query(`DELETE FROM ic_job_listings WHERE company = ANY($1::text[])`, [[CO_ERR, CO_GATE]]);
    }
  });

  test('(f) a 299-char cleaned description classifies empty, 300 classifies fetched', async () => {
    for (const [len, expected] of [[299, 'empty'], [300, 'fetched']]) {
      const CO = `ZZ-TEST-SCAN-DETAILPASS-F${len}`;
      const card = { jobkey: `f${len}f${len}f${len}f${len}f0`.slice(0, 16), title: 'Chief Technology Officer', company: CO, location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: '$300,000 - $350,000' };
      const fake = makeFakeSession({ indeedCards: [card], bodyText: 'x'.repeat(len) });
      const deps = offlineDeps({ connectSession: fake.connectSession });
      await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
      try {
        const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {} });
        assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
        const row = await client.query(`SELECT detail_outcome FROM ic_job_listings WHERE company = $1`, [CO]);
        assert.equal(row.rowCount, 1);
        assert.equal(row.rows[0].detail_outcome, expected, `length ${len} must classify ${expected}`);
      } finally {
        await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
        await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
        await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
        await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CO]);
      }
    }
  });

  test('(d) a row fetched on scan 1 keeps outcome fetched after scan 2 re-sees it below the gate', async () => {
    const CO = 'ZZ-TEST-SCAN-DETAILPASS-D';
    const jobs = JSON.parse(JSON.stringify(await import('./helpers/scan-fixtures.js').then((m) => m.readJsonFixture('adapters/greenhouse-zztest-jobs.json'))));
    jobs.jobs = [{
      absolute_url: 'https://boards.greenhouse.io/zztest/jobs/7000000101', internal_job_id: 101, location: { name: 'Houston, TX' },
      id: 7000000101, updated_at: '2026-08-23T10:00:00-04:00', requisition_id: 'ZD', title: 'Chief Technology Officer',
      company_name: CO, first_published: '2026-08-23T10:00:00-04:00',
    }];
    const longContent = 'ZZ-TEST-SCAN-D synthetic detail. Reports to the CEO. Base $300,000 - $350,000. '
      + 'This synthetic posting exists purely to exercise the scan detail-fetch retry-gate logic end to '
      + 'end across two separate scan runs of the same board and the same listing, well past the 300 '
      + 'character detail-fetch minimum length this pipeline enforces before counting a fetch as successful.';
    const map = [
      { prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs/7000000101', body: JSON.stringify({ id: 7000000101, title: 'Chief Technology Officer', content: longContent, location: { name: 'Houston, TX' } }) },
      { prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs', body: JSON.stringify(jobs) },
      ...DEFAULT_MAP.filter((m) => m.prefix.includes('/gitlab/')),
    ];
    try {
      const r1 = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, offlineDeps({ fetch: makeFixtureFetch(map) }), { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
      assert.equal(r1.status, 'ok', JSON.stringify(r1.errors));
      const row1 = await client.query(`SELECT detail_outcome, description FROM ic_job_listings WHERE company = $1`, [CO]);
      assert.equal(row1.rowCount, 1);
      assert.equal(row1.rows[0].detail_outcome, 'fetched');
      assert.ok(row1.rows[0].description);
      // Scan 2: a config clone whose run-level detailFetchMinPrescore is pushed to the schema's max (100)
      // -- unreachable for any real listing -- so this same row is definitely BELOW the gate this time,
      // exercising the 'update' outcome's not_queued path rather than a real re-fetch.
      const cfg = testConfig();
      const belowGate = { ...cfg, adapters: { ...cfg.adapters, run: { ...cfg.adapters.run, detailFetchMinPrescore: 100 } } };
      const r2 = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, offlineDeps({ config: belowGate, fetch: makeFixtureFetch(map) }), { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
      assert.equal(r2.status, 'ok', JSON.stringify(r2.errors));
      assert.equal(r2.stats.updated, 1);
      assert.equal(r2.stats.detail_fetched, 0, 'below the gate this time: no re-fetch attempted');
      const row2 = await client.query(`SELECT detail_outcome, description FROM ic_job_listings WHERE company = $1`, [CO]);
      assert.equal(row2.rows[0].detail_outcome, 'fetched', 'not_queued must never clobber an already-fetched outcome');
      assert.ok(row2.rows[0].description, 'description from scan 1 is untouched');
    } finally {
      await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CO]);
    }
  });

  test('(e) attempts cap: a third consecutive empty result makes the row ineligible for a further retry', async () => {
    const CO = 'ZZ-TEST-SCAN-DETAILPASS-E';
    const jobs = JSON.parse(JSON.stringify(await import('./helpers/scan-fixtures.js').then((m) => m.readJsonFixture('adapters/greenhouse-zztest-jobs.json'))));
    jobs.jobs = [{
      absolute_url: 'https://boards.greenhouse.io/zztest/jobs/7000000102', internal_job_id: 102, location: { name: 'Houston, TX' },
      id: 7000000102, updated_at: '2026-08-23T10:00:00-04:00', requisition_id: 'ZE', title: 'Chief Technology Officer',
      company_name: CO, first_published: '2026-08-23T10:00:00-04:00',
    }];
    // Short (<300 char) content: every scan's detail fetch classifies 'empty', so detail_attempts climbs
    // by one each time this row is re-queued -- config's detailMaxAttempts defaults to 3, so the 4th scan
    // must find it ineligible and skip the network attempt entirely.
    const shortContent = 'ZZ-TEST-SCAN-E synthetic detail. Reports to the CEO. Base $300,000 - $350,000.';
    const map = [
      { prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs/7000000102', body: JSON.stringify({ id: 7000000102, title: 'Chief Technology Officer', content: shortContent, location: { name: 'Houston, TX' } }) },
      { prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs', body: JSON.stringify(jobs) },
      ...DEFAULT_MAP.filter((m) => m.prefix.includes('/gitlab/')),
    ];
    const deps = offlineDeps({ fetch: makeFixtureFetch(map) });
    try {
      for (let scanNum = 1; scanNum <= 3; scanNum++) {
        const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
        assert.equal(r.status, 'ok', JSON.stringify(r.errors));
        assert.equal(r.stats.detail_empty, 1, `scan ${scanNum} must attempt (and get 'empty' from) the short-content detail fetch`);
        const row = await client.query(`SELECT detail_outcome, detail_attempts FROM ic_job_listings WHERE company = $1`, [CO]);
        assert.equal(row.rows[0].detail_outcome, 'empty');
        assert.equal(row.rows[0].detail_attempts, scanNum, `attempts must be ${scanNum} after scan ${scanNum}`);
      }
      const r4 = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
      assert.equal(r4.status, 'ok', JSON.stringify(r4.errors));
      assert.equal(r4.stats.detail_empty, 0, 'scan 4 must NOT re-attempt: attempts is already at the cap (3)');
      const row4 = await client.query(`SELECT detail_outcome, detail_attempts FROM ic_job_listings WHERE company = $1`, [CO]);
      assert.equal(row4.rows[0].detail_attempts, 3, 'attempts stays capped, never incremented past the config max');
      assert.equal(row4.rows[0].detail_outcome, 'empty', 'not_queued (scan 4) never overwrites the prior empty outcome');
    } finally {
      await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CO]);
    }
  });

  test('(g) LinkedIn item-6 follow-up fix: a source-B not_found (ERR_HTTP_RESPONSE_CODE_FAILURE) persists detail_outcome error, not empty', async () => {
    const CO = 'ZZ-TEST-SCAN-DETAILPASS-NOTFOUND';
    const card = { id: '4461489435', title: 'Chief Technology Officer', company: CO, location: 'Houston, TX', datetime: new Date().toISOString() };
    const base = makeFakeSession({ linkedinCards: [card] });
    const connectSession = async () => {
      const session = await base.connectSession();
      const realAttach = session.attachPage.bind(session);
      session.attachPage = async () => {
        const page = await realAttach();
        const realGoto = page.goto.bind(page);
        page.goto = async (url) => {
          // The fake page has no context()/setExtraHTTPHeaders, so cap.fetchAuthedJson's cookie read
          // fails closed to 'missing' and source A is skipped entirely (covered separately by the
          // capability-level tests); this test is purely about source B's own error classification.
          if (String(url).includes('/jobs-guest/')) throw new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ' + url);
          return realGoto(url);
        };
        return page;
      };
      return session;
    };
    const deps = offlineDeps({ connectSession });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('linkedin', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['linkedin'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
      assert.ok(r.stats.detail_error >= 1, JSON.stringify(r.stats));
      assert.equal(r.stats.detail_empty, 0, 'not_found must never land in the empty counter');
      const row = await client.query(`SELECT detail_outcome FROM ic_job_listings WHERE company = $1`, [CO]);
      assert.equal(row.rowCount, 1);
      assert.equal(row.rows[0].detail_outcome, 'error');
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'linkedin'`);
      await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
      await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CO]);
    }
  });
});
