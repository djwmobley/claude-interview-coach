// @ts-check
/**
 * bin/backfill-detail.js: selection predicate (each guard), --ids override semantics, dry-run (no
 * fetch/no writes), the per-fetch scan-concurrency guard, budget exhaustion, a fetched write, an empty
 * write, and proof the dedup/repost path (src/core/dedup.js's classify()) is never invoked.
 *
 * Modeled on test/apply-bin.test.js (real isolated test DB, direct row seeding, calling the exported
 * function directly rather than spawning a child process) and test/triage-backfill.test.js (this repo's
 * own convention for backfill-script coverage). Fetch-backed only (greenhouse): the browser-backed
 * (linkedin) capFor/session/chrome-launch path is not exercised here -- see the PR's blind-spots section.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { testConfig, makeFixtureFetch, fakeLookup, memoryReserve, readFixture, makeFakeSession } from './helpers/scan-fixtures.js';
import { runBackfill, parseArgs } from '../bin/backfill-detail.js';

const TAG = `zz-test-backfill-${process.pid}`;
const GH_DETAIL_FIXTURE = readFixture('adapters/greenhouse-zztest-detail.json');
// Prefix (no trailing job id) so makeFixtureFetch's startsWith match serves every row's own unique job id
// under the same fixture body -- url_normalized carries a unique partial index (sql/unique_indexes.sql),
// so every seeded row needs its own distinct URL.
const GH_API_PREFIX = 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs/';
function ghUrl(n) {
  return `https://boards.greenhouse.io/zztest/jobs/${7100000000 + (n % 900000000)}`;
}

describe('bin/backfill-detail.js: parseArgs', () => {
  test('parses --ids=, --source=, --limit, --dry-run', () => {
    const out = parseArgs(['--dry-run', '--ids=7064,7065', '--source=linkedin', '--limit', '5']);
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.ids, [7064, 7065]);
    assert.equal(out.source, 'linkedin');
    assert.equal(out.limit, 5);
  });

  test('missing flags default sensibly', () => {
    const out = parseArgs([]);
    assert.equal(out.dryRun, false);
    assert.equal(out.ids, null);
    assert.equal(out.source, null);
    assert.equal(out.limit, Infinity);
  });
});

describe('bin/backfill-detail.js: DB-backed', () => {
  /** @type {pg.Client} */
  let client;
  /** @type {number[]} */
  const listingIds = [];
  let config;

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    config = testConfig();
  });

  after(async () => {
    if (listingIds.length) {
      await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [listingIds]);
      await client.query('DELETE FROM ic_scan_run_items WHERE listing_id = ANY($1::int[])', [listingIds]);
      await client.query('UPDATE ic_job_listings SET duplicate_of = NULL WHERE id = ANY($1::int[])', [listingIds]);
      await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
    }
    await client.query('DELETE FROM ic_scan_runs WHERE profile = $1', [`${TAG}-concurrency`]);
    await client.end();
  });

  /**
   * @param {Partial<{ company: string, source: string, external_id: string, url: string, status: string,
   *   prescore: number, detail_outcome: string|null, detail_attempts: number, search_profile: string|null,
   *   expired_at: string|null, duplicate_of: number|null, fit_score: number|null }>} o
   */
  async function seedRow(o = {}) {
    const n = Math.floor(Math.random() * 1e9);
    const company = o.company ?? `${TAG}-${n}`;
    const source = o.source ?? 'greenhouse';
    const externalId = o.external_id ?? `zz-backfill-ext-${n}`;
    const url = o.url ?? ghUrl(n);
    const r = await client.query(
      `INSERT INTO ic_job_listings
         (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
          last_seen, status, url, url_normalized, prescore, detail_outcome, detail_attempts, search_profile,
          remote_mode, remote_declared, expired_at, duplicate_of, fit_score)
       VALUES ('Backfill Test Role', $1, $2, $3, 'listing', $4, 'backfill test role', 'legacy-unknown', $5,
          now(), $6, $7, $7, $8, $9, $10, $11, 'onsite', false, $12, $13, $14)
       RETURNING id`,
      [
        company, source, externalId, `zz-backfill-cn-${n}`, `zz-backfill-hash-${n}`,
        o.status ?? 'maybe', url, o.prescore ?? 45, o.detail_outcome ?? null, o.detail_attempts ?? 0,
        o.search_profile ?? null, o.expired_at ?? null, o.duplicate_of ?? null, o.fit_score ?? null,
      ],
    );
    const id = Number(r.rows[0].id);
    listingIds.push(id);
    return id;
  }

  /** @param {number} id */
  async function getRow(id) {
    const r = await client.query(
      `SELECT id, source, status, prescore, detail_outcome, detail_attempts, description, description_hash,
              fit_score, duplicate_of, expired_at FROM ic_job_listings WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  function baseDeps(extra = {}) {
    return {
      config,
      env: { GOOGLE_TOKEN_FILE: null, SCAN_CDP_URL: 'http://127.0.0.1:1', JOBSEARCH_LOG_DIR: '/tmp' },
      fetch: makeFixtureFetch([{ prefix: GH_API_PREFIX, body: GH_DETAIL_FIXTURE }]),
      lookup: fakeLookup,
      sleep: async () => {},
      random: () => 0,
      reserveBudget: memoryReserve(),
      log: () => {},
      ...extra,
    };
  }

  describe('selection predicate (each guard)', () => {
    test('excludes expired_at rows', async () => {
      const excluded = await seedRow({ expired_at: new Date().toISOString() });
      const included = await seedRow();
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      const ids = r.rows.map((row) => row.id);
      assert.ok(!ids.includes(excluded));
      assert.ok(ids.includes(included));
    });

    test('excludes duplicate_of rows', async () => {
      const root = await seedRow();
      const excluded = await seedRow({ duplicate_of: root });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      assert.ok(!r.rows.map((row) => row.id).includes(excluded));
    });

    test('excludes detail_outcome=fetched rows', async () => {
      const excluded = await seedRow({ detail_outcome: 'fetched' });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      assert.ok(!r.rows.map((row) => row.id).includes(excluded));
    });

    test('excludes rows at/over the source detailMaxAttempts (default 3)', async () => {
      const excluded = await seedRow({ detail_outcome: 'error', detail_attempts: 3 });
      const included = await seedRow({ detail_outcome: 'error', detail_attempts: 2 });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      const ids = r.rows.map((row) => row.id);
      assert.ok(!ids.includes(excluded));
      assert.ok(ids.includes(included));
    });

    test('excludes sources whose adapter has no fetchDetail (lever)', async () => {
      const excluded = await seedRow({ source: 'lever', external_id: `zz-lever-${Math.random()}`, url: 'https://jobs.lever.co/example/abc' });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      assert.ok(!r.rows.map((row) => row.id).includes(excluded));
    });

    test('excludes status outside maybe/review/apply', async () => {
      const excluded = await seedRow({ status: 'skip' });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      assert.ok(!r.rows.map((row) => row.id).includes(excluded));
    });
  });

  describe('fit-sweep union (fix/detail-fit-sweep spec S4)', () => {
    const FLOOR = 70; // testConfig()'s config/auto-apply.json fitFloor, mirrored here (see src/core/config.js's default).

    test('a status=new row at/over the fit floor with an empty description is now selected (previously invisible to this script)', async () => {
      const included = await seedRow({ status: 'new', fit_score: FLOOR });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      assert.ok(r.rows.map((row) => row.id).includes(included));
    });

    test('a status=new row BELOW the fit floor is still excluded (the union does not relax the floor)', async () => {
      const excluded = await seedRow({ status: 'new', fit_score: FLOOR - 1 });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      assert.ok(!r.rows.map((row) => row.id).includes(excluded));
    });

    test('a terminal status (applied) is never reopened by the union even at/over the fit floor', async () => {
      const excluded = await seedRow({ status: 'applied', fit_score: FLOOR + 10 });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      assert.ok(!r.rows.map((row) => row.id).includes(excluded), 'a terminal status must never be reopened by the fit-sweep half of the union');
    });

    test('the union half never bypasses the common exclusions (expired_at, duplicate_of, detail_outcome=fetched, no fetchDetail adapter)', async () => {
      const expired = await seedRow({ status: 'new', fit_score: FLOOR, expired_at: new Date().toISOString() });
      const root = await seedRow({ status: 'new', fit_score: FLOOR });
      const duplicate = await seedRow({ status: 'new', fit_score: FLOOR, duplicate_of: root });
      const alreadyFetched = await seedRow({ status: 'new', fit_score: FLOOR, detail_outcome: 'fetched' });
      const noAdapter = await seedRow({ status: 'new', fit_score: FLOOR, source: 'lever', external_id: `zz-lever-fit-${Math.random()}`, url: 'https://jobs.lever.co/example/fit-sweep' });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      const ids = r.rows.map((row) => row.id);
      assert.ok(!ids.includes(expired));
      assert.ok(!ids.includes(duplicate));
      assert.ok(!ids.includes(alreadyFetched));
      assert.ok(!ids.includes(noAdapter));
    });

    test('a fit-sweep-matched row at/over detailMaxAttempts is still excluded (JS-side filter applies uniformly regardless of match reason)', async () => {
      const excluded = await seedRow({ status: 'new', fit_score: FLOOR, detail_outcome: 'error', detail_attempts: 3 });
      const included = await seedRow({ status: 'new', fit_score: FLOOR, detail_outcome: 'error', detail_attempts: 2 });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: null }, baseDeps(), client);
      const ids = r.rows.map((row) => row.id);
      assert.ok(!ids.includes(excluded));
      assert.ok(ids.includes(included));
    });

    test('--ids bypasses the union exactly like it always bypassed the status filter (unchanged)', async () => {
      const belowFloor = await seedRow({ status: 'applied', fit_score: FLOOR - 1 });
      const r = await runBackfill({ dryRun: true, limit: Infinity, ids: [belowFloor], source: null }, baseDeps(), client);
      assert.deepEqual(r.rows.map((row) => row.id), [belowFloor], '--ids still bypasses BOTH halves of the union, unchanged');
    });
  });

  test('--ids overrides the status filter but never the fetched/attempts guards', async () => {
    const skippedStatus = await seedRow({ status: 'skip' });
    const alreadyFetched = await seedRow({ detail_outcome: 'fetched' });
    const attemptsExhausted = await seedRow({ detail_outcome: 'error', detail_attempts: 3 });
    const r = await runBackfill({ dryRun: true, limit: Infinity, ids: [skippedStatus, alreadyFetched, attemptsExhausted], source: null }, baseDeps(), client);
    const ids = r.rows.map((row) => row.id);
    assert.deepEqual(ids, [skippedStatus]);
  });

  test('dry-run performs no fetch and no writes', async () => {
    const id = await seedRow();
    let fetchCalled = false;
    const deps = baseDeps({ fetch: async (...a) => { fetchCalled = true; return makeFixtureFetch([{ prefix: GH_API_PREFIX, body: GH_DETAIL_FIXTURE }])(...a); } });
    const r = await runBackfill({ dryRun: true, limit: Infinity, ids: [id], source: null }, deps, client);
    assert.equal(r.mode, 'dry-run');
    assert.equal(fetchCalled, false);
    const row = await getRow(id);
    assert.equal(row.detail_outcome, null);
    assert.equal(row.detail_attempts, 0);
  });

  test('a fetched result writes description/outcome, resets attempts to 0, and leaves status/fit_score untouched', async () => {
    const id = await seedRow({ detail_outcome: 'error', detail_attempts: 2, status: 'review', fit_score: 77 });
    const r = await runBackfill({ dryRun: false, limit: Infinity, ids: [id], source: null }, baseDeps(), client);
    assert.equal(r.by_outcome.fetched, 1, JSON.stringify(r));
    const row = await getRow(id);
    assert.equal(row.detail_outcome, 'fetched');
    assert.equal(row.detail_attempts, 0);
    assert.ok(row.description && row.description.length > 0);
    assert.equal(row.status, 'review', 'status must never change');
    assert.equal(row.fit_score, 77, 'fit_score must never change');
  });

  test('an empty result increments detail_attempts and never sets detail_outcome=fetched', async () => {
    const id = await seedRow({ url: 'https://boards.greenhouse.io/zztest/jobs/9999999999', detail_attempts: 0 });
    const deps = baseDeps({ fetch: makeFixtureFetch([{ prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs/9999999999', body: JSON.stringify({ id: 9999999999, content: '' }) }]) });
    const r = await runBackfill({ dryRun: false, limit: Infinity, ids: [id], source: null }, deps, client);
    assert.equal(r.by_outcome.empty, 1, JSON.stringify(r));
    const row = await getRow(id);
    assert.equal(row.detail_outcome, 'empty');
    assert.equal(row.detail_attempts, 1);
  });

  test('budget exhaustion stops cleanly (exit 0) and marks remaining candidates for that source skipped_budget', async () => {
    const idA = await seedRow();
    const idB = await seedRow();
    const deps = baseDeps({ reserveBudget: memoryReserve({ details: config.adapters.adapters.greenhouse.dailyDetails }) });
    const r = await runBackfill({ dryRun: false, limit: Infinity, ids: [idA, idB], source: null }, deps, client);
    assert.equal(r.code, 0);
    assert.equal(r.by_outcome.skipped_budget, 2, JSON.stringify(r));
    const rowA = await getRow(idA);
    assert.equal(rowA.detail_outcome, 'skipped_budget');
  });

  test('the scan-concurrency guard stops a live run with code 2; rows already processed stay committed', async () => {
    const idA = await seedRow();
    const idB = await seedRow();
    // First call: no scan running, processes idA cleanly.
    const r1 = await runBackfill({ dryRun: false, limit: Infinity, ids: [idA], source: null }, baseDeps(), client);
    assert.equal(r1.code, 0);
    const rowA = await getRow(idA);
    assert.equal(rowA.detail_outcome, 'fetched');

    // Now a scan run is "in progress"; the very next row's guard check must trip before any fetch.
    await client.query(
      `INSERT INTO ic_scan_runs (profile, trigger, status, heartbeat_at) VALUES ($1, 'cli', 'running', now())`,
      [`${TAG}-concurrency`],
    );
    let fetchCalled = false;
    const deps2 = baseDeps({ fetch: async (...a) => { fetchCalled = true; return makeFixtureFetch([{ prefix: GH_API_PREFIX, body: GH_DETAIL_FIXTURE }])(...a); } });
    const r2 = await runBackfill({ dryRun: false, limit: Infinity, ids: [idB], source: null }, deps2, client);
    assert.equal(r2.code, 2);
    assert.equal(r2.stopped_for_scan_running, true);
    assert.equal(r2.processed, 0);
    assert.equal(fetchCalled, false, 'the guard must trip before any network fetch is attempted');
    await client.query('DELETE FROM ic_scan_runs WHERE profile = $1', [`${TAG}-concurrency`]);
  });

  test('the dedup/repost merge path (classify()) is never invoked: two rows that would collide on description+company are both written independently, with no review-queue row and no duplicate_of', async () => {
    const company = `${TAG}-dup-${Math.floor(Math.random() * 1e9)}`;
    const idA = await seedRow({ company, status: 'maybe' });
    const idB = await seedRow({ company, status: 'maybe' });
    const deps = baseDeps();
    const r = await runBackfill({ dryRun: false, limit: Infinity, ids: [idA, idB], source: null }, deps, client);
    assert.equal(r.by_outcome.fetched, 2, JSON.stringify(r));
    const rowA = await getRow(idA);
    const rowB = await getRow(idB);
    // Same fixture body fetched for both rows: description_hash now matches -- exactly the shape
    // classify()'s description_hash-keyed repost/cross-source-dup matching would act on if it were ever
    // invoked. It is not: both rows keep their own identity.
    assert.equal(rowA.description_hash, rowB.description_hash);
    assert.equal(rowA.duplicate_of, null);
    assert.equal(rowB.duplicate_of, null);
    assert.equal(rowA.status, 'maybe');
    assert.equal(rowB.status, 'maybe');
    const queueRows = await client.query('SELECT id FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [[idA, idB]]);
    assert.equal(queueRows.rowCount, 0, 'no review-queue row: the dedup/queue path was never reached');
  });

  describe('browser-backed (linkedin) detail pacing (detail-pacing fix, spec item 2): this script only ever fetches details, so capFor must always use the limiter detail-scoped wait', () => {
    test('linkedin detail fetches pace on detailDelayMs, never on delayMs, when both are configured', async () => {
      const idA = await seedRow({ source: 'linkedin', external_id: 'linkedin:9991', url: 'https://www.linkedin.com/jobs/view/9991', prescore: 60 });
      const idB = await seedRow({ source: 'linkedin', external_id: 'linkedin:9992', url: 'https://www.linkedin.com/jobs/view/9992', prescore: 60 });
      const base = makeFakeSession({});
      /** @type {Array<{ t: 'goto'|'sleep', url?: string, ms?: number }>} */
      const events = [];
      const connectSession = async () => {
        const session = await base.connectSession();
        const realAttach = session.attachPage.bind(session);
        session.attachPage = async () => {
          const page = await realAttach();
          const realGoto = page.goto.bind(page);
          page.goto = async (/** @type {string} */ url) => {
            events.push({ t: 'goto', url });
            return realGoto(url);
          };
          return page;
        };
        return session;
      };
      const sleep = async (/** @type {number} */ ms) => {
        events.push({ t: 'sleep', ms });
      };
      // A fresh config copy (never the shared `config` from before(), which other tests in this file also
      // read): delayMs and detailDelayMs are pinned to non-overlapping ranges so an observed gap can only
      // fall in [3000,6000] if this script's onPage really used waitDetail(), never wait() (which would
      // land in [6000,12000] instead).
      const freshCfg = testConfig();
      freshCfg.adapters.adapters.linkedin = { ...freshCfg.adapters.adapters.linkedin, delayMs: [6000, 12000], detailDelayMs: [3000, 6000] };
      const r = await runBackfill(
        { dryRun: false, limit: Infinity, ids: [idA, idB], source: 'linkedin' },
        baseDeps({ config: freshCfg, connectSession, sleep, random: () => 0.5, launchChrome: async () => {} }),
        client,
      );
      assert.equal(r.code, 0, JSON.stringify(r));
      assert.equal(r.processed, 2, JSON.stringify(r));
      const gotos = events.filter((e) => e.t === 'goto');
      assert.equal(gotos.length, 2, `expected exactly 2 detail navigations (source B for each row, source A skipped for missing cookie), got ${JSON.stringify(events)}`);
      const idxFirst = events.indexOf(gotos[0]);
      const idxSecond = events.indexOf(gotos[1]);
      const gap = events.slice(idxFirst + 1, idxSecond).filter((e) => e.t === 'sleep');
      assert.equal(gap.length, 1, `expected exactly one sleep between the two detail navigations, got ${JSON.stringify(events)}`);
      assert.ok(gap[0].ms >= 3000 && gap[0].ms <= 6000, `gap ${gap[0].ms}ms outside detailDelayMs [3000,6000] -- backfill-detail must pace every fetch on the detail wait, never on delayMs [6000,12000]`);
    });
  });
});
