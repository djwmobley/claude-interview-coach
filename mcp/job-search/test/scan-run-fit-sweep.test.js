// @ts-check
/**
 * src/core/scan-run.js's fit-sweep integration (fix/detail-fit-sweep spec S1-S3): a live scan run appends
 * a per-source sweep of EXISTING, already-fit-scored, empty-description rows to its detail-fetch pass,
 * sharing the per-run maxDetailsPerRun cap with the ordinary list-page queue. Covers: counters always
 * present at 0/0 when nothing qualifies, a real candidate getting fetched and written, and the S2 share-cap
 * split with reciprocal leftover reuse in both directions.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, testConfig,
  makeFixtureFetch, DEFAULT_MAP, makeFakeSession, FIXTURE_NOW,
} from './helpers/scan-fixtures.js';

const PROFILE = `zz-test-fitsweep-${process.pid}`;
const CO = 'ZZ-TEST-FITSWEEP';
/** @type {import('pg').Client} */
let client;

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: [CO] });
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE, companies: [CO] });
  } finally {
    await client.end();
  }
});

/** A custom Greenhouse job id (never emitted by the real zztest list fixture) reused across these tests
 * for a pre-existing sweep-candidate row's detail URL, served the same >300-char fixture body the
 * ordinary CTO listing already uses (so a real fetch of it counts as 'fetched'). */
const SWEEP_JOB_ID = '7000000099';
const SWEEP_URL = `https://boards.greenhouse.io/zztest/jobs/${SWEEP_JOB_ID}`;
const SWEEP_MAP = [
  { prefix: `https://boards-api.greenhouse.io/v1/boards/zztest/jobs/${SWEEP_JOB_ID}`, file: 'adapters/greenhouse-zztest-detail.json' },
  ...DEFAULT_MAP,
];

/**
 * Seed one pre-existing fit-sweep candidate row directly (never through the scan pipeline itself -- this
 * is exactly the "already scanned, never revisited" scenario the sweep exists to fix).
 * @param {{ source?: string, url?: string, externalId?: string, fitScore?: number }} [o]
 */
async function seedCandidate(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const source = o.source ?? 'greenhouse';
  const url = o.url ?? SWEEP_URL;
  const externalId = o.externalId ?? `greenhouse:zztest/${SWEEP_JOB_ID}`;
  const r = await client.query(
    `INSERT INTO ic_job_listings
       (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
        last_seen, status, url, url_normalized, prescore, detail_attempts, fit_score, description, search_profile)
     VALUES ('Fit Sweep Candidate', $1, $2, $3, 'listing', $4, 'fit sweep candidate', 'legacy-unknown', $5,
        now(), 'new', $6, $6, 45, 0, $7, NULL, $8)
     RETURNING id`,
    [CO, source, externalId, `${CO}-${n}`, `zz-fitsweep-hash-${n}`, url, o.fitScore ?? 80, PROFILE],
  );
  return Number(r.rows[0].id);
}

describe('scan-run.js fit sweep (fix/detail-fit-sweep spec S1-S3)', () => {
  test('counters are always present at 0/0 when no fit-sweep candidate exists', async () => {
    // A keyword that matches nothing on the zztest list page (isolates this from the ordinary queue path).
    await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['NoSuchKeywordXYZ'], phrases: [], locations: ['Houston, TX'] });
    const deps = offlineDeps({ config: testConfig(), fetch: makeFixtureFetch(SWEEP_MAP) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.equal(r.stats.detail_fit_sweep_queued, 0, JSON.stringify(r.stats));
    assert.equal(r.stats.detail_fit_sweep_fetched, 0, JSON.stringify(r.stats));
    const bySource = r.stats.details_by_source.greenhouse;
    assert.ok(bySource, 'greenhouse must always get a details_by_source bucket (spec S3), even with zero activity');
    assert.equal(bySource.fit_sweep_queued, 0);
    assert.equal(bySource.fit_sweep_fetched, 0);
  });

  test('a real fit-sweep candidate is queued, fetched, and its description gets written to the DB', async () => {
    await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['NoSuchKeywordXYZ'], phrases: [], locations: ['Houston, TX'] });
    const id = await seedCandidate();
    const deps = offlineDeps({ config: testConfig(), fetch: makeFixtureFetch(SWEEP_MAP) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.equal(r.stats.detail_fit_sweep_queued, 1, JSON.stringify(r.stats));
    assert.equal(r.stats.detail_fit_sweep_fetched, 1, JSON.stringify(r.stats));
    const bySource = r.stats.details_by_source.greenhouse;
    assert.equal(bySource.fit_sweep_queued, 1);
    assert.equal(bySource.fit_sweep_fetched, 1);
    // Never counted under the ordinary list-page-derived counters (deliberate separation, see scan-run.js's
    // RunStats doc comment): this row was never seen on a list page this run.
    assert.equal(r.stats.detail_fetched, 0, JSON.stringify(r.stats));
    const row = (await client.query('SELECT description, detail_outcome, detail_attempts, status, fit_score FROM ic_job_listings WHERE id = $1', [id])).rows[0];
    assert.ok(row.description && row.description.length > 0, 'description must be written');
    assert.equal(row.detail_outcome, 'fetched');
    assert.equal(row.detail_attempts, 0, 'a successful fetch resets attempts to 0');
    assert.equal(row.status, 'new', 'fit-sweep write bypasses applyDecision(): status must never change');
    assert.equal(row.fit_score, 80, 'fit-sweep write bypasses applyDecision(): fit_score must never change');
    // No ic_scan_run_items row: this listing was never seen on this run's own list pages (see
    // writeSweepOutcome's own comment -- writing one here would corrupt expiryPass's absence accounting).
    const items = await client.query('SELECT run_id FROM ic_scan_run_items WHERE run_id = $1 AND listing_id = $2', [r.run_id, id]);
    assert.equal(items.rowCount, 0, 'a fit-sweep row must never get an ic_scan_run_items row');
  });

  test('a candidate below the fit floor, or with a non-empty description, is left untouched', async () => {
    await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['NoSuchKeywordXYZ'], phrases: [], locations: ['Houston, TX'] });
    // A distinct job id/url from SWEEP_URL above (that row already exists from the previous test and
    // url_normalized carries a unique partial index) -- this row is never expected to be fetched at all,
    // so it needs no matching fixture entry.
    const belowFloor = await seedCandidate({ fitScore: 69, url: 'https://boards.greenhouse.io/zztest/jobs/7000000098', externalId: 'greenhouse:zztest/7000000098' });
    const deps = offlineDeps({ config: testConfig(), fetch: makeFixtureFetch(SWEEP_MAP) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.stats.detail_fit_sweep_queued, 0, JSON.stringify(r.stats));
    const row = (await client.query('SELECT description, detail_outcome FROM ic_job_listings WHERE id = $1', [belowFloor])).rows[0];
    assert.equal(row.description, null);
    assert.equal(row.detail_outcome, null);
  });
});

describe('scan-run.js fit sweep share cap (fix/detail-fit-sweep spec S2)', () => {
  const CAP_PROFILE = `${PROFILE}-cap`;
  const CAP_CO = 'ZZ-TEST-FITSWEEP-CAP';

  after(async () => {
    await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CAP_CO]);
    await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CAP_CO]);
    await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CAP_CO]);
    await client.query(`DELETE FROM ic_scan_runs WHERE profile = $1`, [CAP_PROFILE]);
    await client.query(`DELETE FROM ic_search_profiles WHERE name = $1`, [CAP_PROFILE]);
  });

  test('reciprocal leftover reuse: an under-subscribed sweep (1 real candidate against a share of 2) gives its unused slot to the run-page queue, which then attempts all 3 of its own cards instead of being capped at 2', async () => {
    await upsertTestProfile(client, CAP_PROFILE, { sources: ['linkedin'], keywords: ['Chief Technology Officer', 'Chief Information Officer', 'Vice President, Technology'], phrases: [], locations: ['Houston, TX'] });
    const cards = [
      { id: '5559990001', title: 'Chief Technology Officer', company: CAP_CO, location: 'Houston, TX', datetime: new Date().toISOString() },
      { id: '5559990002', title: 'Chief Information Officer', company: CAP_CO, location: 'Houston, TX', datetime: new Date().toISOString() },
      { id: '5559990003', title: 'Vice President, Technology', company: CAP_CO, location: 'Houston, TX', datetime: new Date().toISOString() },
    ];
    const base = makeFakeSession({ linkedinCards: cards });
    let guestNavCount = 0;
    const connectSession = async () => {
      const session = await base.connectSession();
      const realAttach = session.attachPage.bind(session);
      session.attachPage = async () => {
        const page = await realAttach();
        const realGoto = page.goto.bind(page);
        page.goto = async (/** @type {string} */ url) => {
          if (String(url).includes('/jobs-guest/')) guestNavCount++;
          return realGoto(url);
        };
        return page;
      };
      return session;
    };
    // One real fit-sweep candidate for linkedin, well under its base share of floor(4/2)=2.
    const n = Math.floor(Math.random() * 1e9);
    const seeded = await client.query(
      `INSERT INTO ic_job_listings
         (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
          last_seen, status, url, url_normalized, prescore, detail_attempts, fit_score, description, search_profile)
       VALUES ('Fit Sweep Candidate', $1, 'linkedin', $2, 'listing', $3, 'fit sweep candidate', 'legacy-unknown', $4,
          now(), 'new', $5, $5, 45, 0, 80, NULL, $6)
       RETURNING id`,
      [CAP_CO, `linkedin:zz-fitsweep-${n}`, `${CAP_CO}-${n}`, `zz-fitsweep-linkedin-hash-${n}`, `https://www.linkedin.com/jobs/view/9990000001`, CAP_PROFILE],
    );
    const seededId = Number(seeded.rows[0].id);
    const cfg = testConfig();
    cfg.adapters.adapters.linkedin = { ...cfg.adapters.adapters.linkedin, maxDetailsPerRun: 4 };
    const deps = offlineDeps({ config: cfg, connectSession });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('linkedin', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: CAP_PROFILE, sources: ['linkedin'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
      assert.equal(r.stats.new, 3, JSON.stringify(r.stats));
      // Base split at cap=4 is 2/2. The sweep only has 1 real candidate, so its unused slot must flow to
      // the run-page queue (S2's "leftover reuse"), letting all 3 cards through instead of being capped at
      // 2 -- plus the sweep's own 1 navigation for its single candidate, so 3 + 1 = 4 total.
      assert.equal(guestNavCount, 4, 'the queue must receive the sweep\'s unused share (3 cards) plus the sweep\'s own 1 navigation');
      assert.equal(r.stats.detail_skipped_run_cap, 0, JSON.stringify(r.stats));
      assert.equal(r.stats.detail_fit_sweep_queued, 1, JSON.stringify(r.stats));
      assert.equal(r.stats.detail_fit_sweep_fetched, 0, 'this seeded row has no matching linkedin detail fixture, so it fetches empty/error, never "fetched"');
      const row = (await client.query('SELECT detail_attempts FROM ic_job_listings WHERE id = $1', [seededId])).rows[0];
      assert.ok(row, 'the seeded sweep candidate must have been attempted and still exist');
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'linkedin'`);
    }
  });

  test('cap === 1: the sweep gets 0 base share (judgment call) and the single slot goes to the run-page queue', async () => {
    await upsertTestProfile(client, CAP_PROFILE, { sources: ['linkedin'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
    const cards = [{ id: '5559990010', title: 'Chief Technology Officer', company: CAP_CO, location: 'Houston, TX', datetime: new Date().toISOString() }];
    const connectSession = makeFakeSession({ linkedinCards: cards }).connectSession;
    const n = Math.floor(Math.random() * 1e9);
    await client.query(
      `INSERT INTO ic_job_listings
         (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
          last_seen, status, url, url_normalized, prescore, detail_attempts, fit_score, description, search_profile)
       VALUES ('Fit Sweep Candidate', $1, 'linkedin', $2, 'listing', $3, 'fit sweep candidate', 'legacy-unknown', $4,
          now(), 'new', $5, $5, 45, 0, 80, NULL, $6)`,
      [CAP_CO, `linkedin:zz-fitsweep-cap1-${n}`, `${CAP_CO}-cap1-${n}`, `zz-fitsweep-linkedin-cap1-hash-${n}`, `https://www.linkedin.com/jobs/view/9990000002`, CAP_PROFILE],
    );
    const cfg = testConfig();
    cfg.adapters.adapters.linkedin = { ...cfg.adapters.adapters.linkedin, maxDetailsPerRun: 1 };
    const deps = offlineDeps({ config: cfg, connectSession });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('linkedin', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: CAP_PROFILE, sources: ['linkedin'], dryRun: false, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
      assert.equal(r.stats.detail_fetched + r.stats.detail_empty + r.stats.detail_error, 1, 'the single cap=1 slot must go to the run-page queue, not the sweep');
      assert.equal(r.stats.detail_fit_sweep_queued, 0, 'the sweep must get zero slots at cap=1 (judgment call, no leftover exists since the queue fully used its one slot)');
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'linkedin'`);
    }
  });
});
