// @ts-check
/**
 * src/core/scan-run.js: a detail fetch that comes back as a block page (detail-block fix, S1/S4/S5).
 * Unattended path only (no popping); the interactive pop logic is covered with fakes in detail-block.test.js.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, testConfig, makeFixtureFetch, DEFAULT_MAP, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { blockedDetailLine } from '../src/core/report.js';

const PROFILE = `zz-test-detailblock-${process.pid}`;
const CO = 'ZZ-TEST-SCAN';
const DETAIL_PREFIX = 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs/7000000001';
const JUNK = 'Additional Verification Required Your Ray ID for this request is a401b81afaf76bd8 Return home -> Troubleshooting Cloudflare Errors';
/** @type {import('pg').Client} */
let client;

async function reset() {
  await cleanupScan(client, { profile: PROFILE, companies: [CO] });
  await client.query(`DELETE FROM ic_source_state WHERE source IN ('greenhouse', 'greenhouse:detail')`);
}
const KEYWORDS = ['Chief Technology Officer', 'Chief Information Officer', 'Vice President, Technology'];
async function resetWithProfile() {
  await reset();
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: KEYWORDS, phrases: [], locations: ['Houston, TX'] });
}

before(async () => {
  client = await newClient();
  await reset();
});
after(async () => {
  try {
    await reset();
  } finally {
    await client.end();
  }
});

/** @param {{ status: number, body: string }} detail */
function mapWith(detail) {
  return [{ prefix: DETAIL_PREFIX, status: detail.status, body: detail.body }, ...DEFAULT_MAP];
}

async function ctoRow() {
  return (await client.query(`SELECT id, description, detail_outcome, detail_attempts FROM ic_job_listings WHERE company = $1 AND title ILIKE '%Chief Technology%' ORDER BY id DESC LIMIT 1`, [CO])).rows[0];
}
async function stateRow(/** @type {string} */ key) {
  return (await client.query('SELECT consecutive_walls, disabled_until FROM ic_source_state WHERE source = $1', [key])).rows[0] ?? null;
}

describe('scan-run.js detail blocks', () => {
  test('HTTP 403 on the detail fetch: description NULL, blocked outcome, wall recorded under <source>:detail only, list scan completes', async () => {
    await resetWithProfile();
    const deps = offlineDeps({ config: testConfig(), fetch: makeFixtureFetch(mapWith({ status: 403, body: 'forbidden' })) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.ok(r.stats.fetched >= 1, 'the list scan still ran');
    assert.equal(r.stats.detail_blocked, 1, JSON.stringify(r.stats));
    assert.deepEqual(r.stats.detail_blocked_by_source, { greenhouse: { http_403: 1 } });
    const row = await ctoRow();
    assert.equal(row.description, null);
    assert.equal(row.detail_outcome, 'blocked:http_403');
    assert.equal(row.detail_attempts, 0, 'a block never uses up attempts');
    const detailState = await stateRow('greenhouse:detail');
    assert.equal(Number(detailState.consecutive_walls), 1);
    assert.ok(detailState.disabled_until, 'the detail key has its own backoff');
    const listState = await stateRow('greenhouse');
    assert.ok(!listState || Number(listState.consecutive_walls) === 0, 'the source\'s own wall state is untouched');
    assert.equal(r.errors.some((e) => e.code === 'LOGIN_WALL' || e.code === 'SOURCE_DISABLED'), false);
    assert.equal(blockedDetailLine(r.stats), 'Blocked detail pages: 1 (greenhouse: http_403)');
    const ev = await client.query(`SELECT note FROM ic_job_events WHERE listing_id = $1 AND kind = 'note'`, [row.id]);
    assert.equal(ev.rowCount, 0, 'a 403 carries no body text, so there is nothing to audit');
  });

  test('the next run does not fetch details while the detail backoff is active, and still scans lists', async () => {
    /** @type {any[]} */
    const recorder = [];
    const deps = offlineDeps({ config: testConfig(), fetch: makeFixtureFetch(mapWith({ status: 403, body: 'forbidden' }), recorder) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.ok(r.stats.fetched >= 1);
    assert.equal(recorder.filter((x) => x.url.startsWith(DETAIL_PREFIX)).length, 0, 'no detail request while backed off');
    assert.ok(r.stats.detail_skipped_blocked >= 1, JSON.stringify(r.stats));
    assert.equal(r.stats.detail_blocked, 0);
  });

  test('a Cloudflare page served with HTTP 200 inside the posting content is blocked, not stored', async () => {
    await resetWithProfile();
    const deps = offlineDeps({ config: testConfig(), fetch: makeFixtureFetch(mapWith({ status: 200, body: JSON.stringify({ content: JUNK }) })) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.stats.detail_blocked, 1, JSON.stringify(r.stats));
    assert.equal(r.stats.detail_fetched, 0);
    const row = await ctoRow();
    assert.equal(row.description, null);
    assert.match(row.detail_outcome, /^blocked:/);
    assert.equal(Number((await stateRow('greenhouse:detail')).consecutive_walls), 1);
    const ev = await client.query(`SELECT note FROM ic_job_events WHERE listing_id = $1 AND kind = 'note'`, [row.id]);
    assert.equal(ev.rowCount, 1);
    assert.match(ev.rows[0].note, /^description rejected \(blocked:[a-z_]+\): .*a401b81afaf76bd8/);
  });

  test('a clean detail fetch afterwards resets the detail key and stores the description', async () => {
    await client.query(`UPDATE ic_source_state SET disabled_until = NULL WHERE source = 'greenhouse:detail'`);
    const deps = offlineDeps({ config: testConfig(), fetch: makeFixtureFetch(DEFAULT_MAP) });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.stats.detail_fetched, 1, JSON.stringify(r.stats));
    const row = await ctoRow();
    assert.ok(row.description && row.description.length >= 300);
    assert.equal(row.detail_outcome, 'fetched');
    assert.equal(Number((await stateRow('greenhouse:detail')).consecutive_walls), 0);
  });
});
