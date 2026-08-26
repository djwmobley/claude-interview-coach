// @ts-check
/**
 * Spec section 11 scenarios that need no LinkedIn or Indeed:
 *   1. the same cross-source pair scanned three times yields exactly 2 rows
 *      (one root, one duplicate_of), no queue rows;
 *   2. a Python-inserted row (store_scan_results.py columns) duplicating a
 *      scanned URL is adopted at the next scan: the run completes and exactly
 *      one review-queue entry exists for it;
 *   3. a concurrent scan (CLI lock holder + MCP search_jobs) returns
 *      {status:'locked'} in under a second and creates no run row;
 *   4. CDP down (SCAN_CDP_URL at a closed loopback port, the REAL
 *      browser/session.js) yields partial + BROWSER_UNAVAILABLE.
 *
 * Runs against the real ic_context database with marker rows
 * (profile zz-test-scen-<pid>, company ZZ-TEST-SCEN) deleted in after().
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getEnv } from '../src/core/config.js';
import { LOCK_KEY } from '../src/core/scan-run.js';
import { tool as searchJobs } from '../src/tools/search_jobs.js';
import { wrapHandler } from '../src/tools/_shared.js';
import { newClient, upsertTestProfile, cleanupScan, makeFixtureFetch, fakeLookup, memoryReserve, runScanWaiting } from './helpers/scan-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCEN_CONFIG = path.join(HERE, 'fixtures', 'scenarios', 'config');
const PROFILE = `zz-test-scen-${process.pid}`;
const COMPANY = 'ZZ-TEST-SCEN';
const GH_URL = 'https://boards.greenhouse.io/zzscen/jobs/7100000001';
const LEVER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

/** @type {import('pg').Client} */
let client;

function yesterday() {
  return new Date(Date.now() - 86400000);
}

/** Greenhouse board body: one CTO in Houston posted yesterday. */
function greenhouseBody() {
  const d = yesterday().toISOString();
  return JSON.stringify({
    jobs: [{ absolute_url: GH_URL, internal_job_id: 1, location: { name: 'Houston, TX' }, id: 7100000001, updated_at: d, requisition_id: 'S1', title: 'Chief Technology Officer', company_name: COMPANY, first_published: d }],
    meta: { total: 1 },
  });
}

/** Lever postings body: the same role at the same company, same city, same day. */
function leverBody() {
  return JSON.stringify([
    { id: LEVER_ID, text: 'Chief Technology Officer', categories: { commitment: 'Full-time', location: 'Houston, TX', team: 'Executive', allLocations: ['Houston, TX'] }, createdAt: yesterday().getTime(), country: 'US', workplaceType: 'onsite', hostedUrl: `https://jobs.lever.co/zzscen/${LEVER_ID}`, applyUrl: `https://jobs.lever.co/zzscen/${LEVER_ID}/apply` },
  ]);
}

const MAP = [
  { prefix: 'https://boards-api.greenhouse.io/v1/boards/zzscen/jobs', body: greenhouseBody() },
  { prefix: 'https://api.lever.co/v0/postings/zzscen', body: leverBody() },
];

function scenDeps(/** @type {Partial<import('../src/core/scan-run.js').RunDeps>} */ extra = {}) {
  return {
    config: loadConfig({ dir: SCEN_CONFIG, fresh: true }),
    fetch: makeFixtureFetch(MAP),
    lookup: fakeLookup,
    sleep: async () => {},
    random: () => 0,
    reserveBudget: memoryReserve(),
    ...extra,
  };
}

async function scenRows() {
  return (await client.query(`SELECT id, source, external_id, url_normalized, duplicate_of, repost_of, status, dedup_hash, times_seen FROM ic_job_listings WHERE company = $1 ORDER BY id`, [COMPANY])).rows;
}

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: [COMPANY] });
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse', 'lever'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'], max_pages: 2 });
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE, companies: [COMPANY] });
  } finally {
    await client.end();
  }
});

describe('scenario 1: cross-source pair scanned three times', () => {
  test('first run: one new root and one cross_source_dup; runs two and three are updates; exactly 2 rows remain', async () => {
    const r1 = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse', 'lever'], dryRun: false, wait: true }, scenDeps(), { trigger: 'cli', log: () => {} });
    assert.equal(r1.status, 'ok', JSON.stringify(r1.errors));
    assert.equal(r1.stats.fetched, 2);
    assert.equal(r1.stats.new, 1, JSON.stringify(r1.stats));
    assert.equal(r1.stats.cross_source_dup, 1, JSON.stringify(r1.stats));
    assert.equal(r1.stats.ambiguous, 0);

    for (let i = 2; i <= 3; i++) {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse', 'lever'], dryRun: false, wait: true }, scenDeps(), { trigger: i === 2 ? 'mcp' : 'cli', log: () => {} });
      assert.equal(r.status, 'ok', JSON.stringify(r.errors));
      assert.equal(r.stats.updated, 2, `run ${i}: ${JSON.stringify(r.stats)}`);
      assert.equal(r.stats.new, 0);
      assert.equal(r.stats.cross_source_dup, 0);
      assert.equal(r.stats.ambiguous, 0);
    }

    const rows = await scenRows();
    assert.equal(rows.length, 2, JSON.stringify(rows));
    const root = rows.find((x) => x.duplicate_of === null);
    const dup = rows.find((x) => x.duplicate_of !== null);
    assert.ok(root && dup, 'one root and one duplicate');
    assert.equal(dup.duplicate_of, root.id);
    assert.equal(root.source, 'greenhouse');
    assert.equal(dup.source, 'lever');
    assert.equal(root.dedup_hash, dup.dedup_hash, 'same company/title/location hash');
    assert.ok(rows.every((x) => x.times_seen === 3), JSON.stringify(rows));
    const q = await client.query(`SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[]) AND resolved_at IS NULL`, [rows.map((x) => x.id)]);
    assert.equal(q.rows[0].n, 0, 'a corroborated cross-source pair never queues');
  });
});

describe('scenario 2: Python-inserted row duplicating a scanned URL', () => {
  test('the next scan adopts it, completes, and leaves exactly one open queue entry', async () => {
    // Mirror tools/ic_memory.py store_job_listings_batch: (title, company, fit_score, status, ad_date, url, notes, embedding).
    const ins = await client.query(
      `INSERT INTO ic_job_listings (title, company, fit_score, status, ad_date, url, notes, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) RETURNING id`,
      ['Chief Technology Officer', COMPANY, 55, 'maybe', yesterday().toISOString().slice(0, 10), GH_URL, 'inserted by hand, mirrors store_scan_results.py'],
    );
    const pyId = Number(ins.rows[0].id);
    const before = (await client.query(`SELECT dedup_hash, url_normalized FROM ic_job_listings WHERE id = $1`, [pyId])).rows[0];
    assert.equal(before.dedup_hash, null, 'python rows carry no dedup columns');

    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse', 'lever'], dryRun: false, wait: true }, scenDeps(), { trigger: 'mcp', log: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.equal(r.stats.updated, 2, 'the scanned pair is still updated normally');
    // Adoption is table-wide, so in a parallel test run another file's scan may have adopted the row first;
    // the queue state below is the invariant, not which run reported the warning.

    const q = await client.query(`SELECT id, reason, resolved_at FROM ic_job_review_queue WHERE candidate_id = $1`, [pyId]);
    assert.equal(q.rowCount, 1, JSON.stringify(q.rows));
    assert.equal(q.rows[0].resolved_at, null);
    assert.equal(q.rows[0].reason, 'adopt_url_conflict', 'the URL collides with the scanned root on the unique index');

    // The scanned root is untouched and the invariant holds: still exactly 3 rows for the company, only the python row is queued.
    const rows = await scenRows();
    assert.equal(rows.length, 3);
    assert.ok(rows.filter((x) => x.duplicate_of !== null).length === 1);

    // A second scan must not add a second queue row for the same candidate.
    const r2 = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse', 'lever'], dryRun: false, wait: true }, scenDeps(), { trigger: 'cli', log: () => {} });
    assert.equal(r2.ok, true, JSON.stringify(r2.errors));
    const q2 = await client.query(`SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL`, [pyId]);
    assert.equal(q2.rows[0].n, 1);
  });
});

describe('scenario 3: concurrent CLI + MCP', () => {
  test('search_jobs returns locked in under a second while another session holds the advisory lock; no run row is created', async () => {
    const holder = await newClient();
    try {
      let got = (await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY])).rows[0].ok;
      for (let i = 0; !got && i < 400; i++) {
        await new Promise((res) => setTimeout(res, 250));
        got = (await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY])).rows[0].ok;
      }
      assert.equal(got, true, 'could not take the lock to simulate the CLI');
      const before = (await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE])).rows[0].n;
      const handler = wrapHandler(searchJobs, /** @type {any} */ ({ ...scenDeps(), withClient: async (/** @type {any} */ fn) => fn(client), env: getEnv(), calendar: null, fetchDetail: null, searchJobs: null }));
      const t0 = Date.now();
      const res = await handler({ profile: PROFILE, sources: ['greenhouse'], dryRun: true, wait: true }, {});
      const ms = Date.now() - t0;
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.ok, false);
      assert.equal(body.status, 'locked');
      assert.match(String(body.hint), /scans\(/);
      assert.ok(ms < 1000, `locked answer took ${ms} ms`);
      const afterN = (await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE])).rows[0].n;
      assert.equal(afterN, before);
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
    } finally {
      await holder.end();
    }
  });
});

describe('scenario 4: CDP down', () => {
  test('a browser source with SCAN_CDP_URL at a closed loopback port degrades to partial + BROWSER_UNAVAILABLE through the real session module', async () => {
    const env = { ...getEnv(), SCAN_CDP_URL: 'http://127.0.0.1:9' };
    // connectSession deliberately NOT overridden: this exercises browser/session.js connectOverCDP against a closed port.
    const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: true, wait: true }, scenDeps({ env }), { trigger: 'mcp', log: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.status, 'partial', JSON.stringify(r.errors));
    assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'BROWSER_UNAVAILABLE'), JSON.stringify(r.errors));
    assert.equal(r.stats.fetched, 0);
    const row = (await client.query('SELECT status, errors FROM ic_scan_runs WHERE id = $1', [r.run_id])).rows[0];
    assert.equal(row.status, 'partial');
    assert.ok(JSON.stringify(row.errors).includes('BROWSER_UNAVAILABLE'));
  });
});
