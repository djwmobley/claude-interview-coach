// @ts-check
/**
 * HAR test (spec section 9): a full fixture run through search_jobs with
 * every outbound request recorded (fetch adapters through the fixture
 * transport, browser adapters through the fake session's goto). Asserts
 * zero non-GET requests outside the path-scoped POST exceptions and zero
 * URLs outside the registry patterns. Dry run: the real DB holds only the
 * run row and today's budget counters.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, buildRegistry, POST_ALLOWED } from '../src/core/urlguard.js';
import { tool as searchJobs } from '../src/tools/search_jobs.js';
import { wrapHandler } from '../src/tools/_shared.js';
import { deps as gmailAuthDeps } from '../src/adapters/gmail.js';
import { newClient, upsertTestProfile, cleanupScan, makeFixtureFetch, makeFakeSession, fakeLookup, testConfig, readJsonFixture, runScanWaiting, memoryReserve, fakeGmailAuthDeps } from './helpers/scan-fixtures.js';
import { untrustedRows } from '../src/core/compact.js';

const [ROWS_OPEN, , ROWS_CLOSE] = untrustedRows(['x']);

const PROFILE = `zz-test-har-${process.pid}`;
/** @type {import('pg').Client} */
let client;

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE });
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse', 'lever', 'workday', 'dayforce', 'indeed', 'linkedin', 'exec', 'gmail'], keywords: ['Chief Technology Officer', 'CTO', 'Chief', 'Vice President'], phrases: ['VP Payments Strategy', 'SVP Digital Transformation'], locations: ['Houston, TX'], max_pages: 2 });
  // gmail's auth never touches the real workspace-mcp token file in tests: stub the injectable seam.
  Object.assign(gmailAuthDeps, fakeGmailAuthDeps);
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE });
  } finally {
    await client.end();
  }
});

describe('HAR: full fixture run', () => {
  test('every recorded request is GET except the Workday search POST, and every URL matches its adapter patterns', async () => {
    /** @type {import('./helpers/scan-fixtures.js').RecordedRequest[]} */
    const recorded = [];
    const config = testConfig();
    const fake = makeFakeSession({ recorder: recorded, indeedCards: readJsonFixture('adapters/indeed-mosaic-cards.json'), linkedinCards: readJsonFixture('adapters/linkedin-cards.json'), listItems: [{ href: '/en/opportunities/cto-1', title: 'Chief Technology Officer', location: 'Dallas, TX' }] });
    const deps = { config, env: { GOOGLE_TOKEN_FILE: 'zz-test-token.json' }, fetch: makeFixtureFetch(undefined, recorded), lookup: fakeLookup, sleep: async () => {}, random: () => 0, reserveBudget: memoryReserve(), connectSession: fake.connectSession };
    const r = await runScanWaiting({ profile: PROFILE, dryRun: true, wait: true }, deps, { trigger: 'mcp', log: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    // scan-run.test.js briefly disables greenhouse in a parallel process; that is the only error tolerated here.
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.ok(r.errors.every((/** @type {any} */ e) => e.code === 'SOURCE_DISABLED'), JSON.stringify(r.errors));
    assert.ok(r.stats.fetched >= 10, `fetched ${r.stats.fetched}`);
    assert.ok(recorded.length >= 26, `recorded ${recorded.length} requests (was >=15 before gmail added its own list + 10 get calls)`);
    assert.equal(fake.state.attached >= 3, true, 'indeed, linkedin, and the browser exec board each attached a page');
    assert.equal(fake.state.disconnected, true, 'session closed in finally');
    assert.equal(fake.state.reconciled, 1);

    const registry = buildRegistry(config);
    const ollama = recorded.filter((q) => /:11434\//.test(q.url));
    assert.equal(ollama.length, 0, 'dry run never embeds');
    const nonGet = recorded.filter((q) => q.method !== 'GET');
    for (const q of nonGet) {
      const u = new URL(q.url);
      assert.equal(q.method, 'POST');
      assert.ok(POST_ALLOWED.some((p) => p.source === 'workday' && p.pattern.test(u.pathname)), `POST outside exceptions: ${q.url}`);
      assert.doesNotThrow(() => JSON.parse(String(q.body)), 'POST body is JSON');
    }
    assert.ok(nonGet.length >= 1, 'the Workday search POST was recorded');
    for (const q of recorded) {
      const clean = q.url.replace(/#ic-job-search$/, '');
      const v = classifyUrl(clean, registry, { method: q.method });
      assert.equal(v.allowed, true, `${q.method} ${clean}: ${v.reason}`);
      assert.ok(!/[?&](utm_|trk=|refId=)/.test(clean), 'no tracking params are ever sent');
    }
    const hosts = new Set(recorded.map((q) => new URL(q.url).hostname));
    assert.ok(hosts.has('boards-api.greenhouse.io') && hosts.has('api.lever.co') && hosts.has('example.wd5.myworkdayjobs.com') && hosts.has('www.indeed.com') && hosts.has('www.linkedin.com') && hosts.has('www.example-exec.test') && hosts.has('gmail.googleapis.com'));
    assert.equal(r.rows[0], ROWS_OPEN, 'rows wrapped in the untrusted delimiter');
    assert.equal(r.rows[r.rows.length - 1], ROWS_CLOSE, 'rows wrapped in the untrusted delimiter');
    assert.ok(r.rows.slice(1, -1).every((/** @type {string} */ line) => line.startsWith('#dry:')), 'dry-run ids');
    assert.ok(r.warnings.some((/** @type {string} */ w) => /dry run/.test(w)));
    const runRow = await client.query('SELECT status, dry_run, stats FROM ic_scan_runs WHERE id = $1', [r.run_id]);
    assert.equal(runRow.rows[0].dry_run, true);
    assert.equal(runRow.rows[0].status, 'ok');
    const items = await client.query('SELECT count(*)::int AS n FROM ic_scan_run_items WHERE run_id = $1', [r.run_id]);
    assert.equal(items.rows[0].n, 0, 'dry run records no run items');
    // Scoped to this file's profile: scan-run.test.js runs in parallel and legitimately owns ZZ-TEST-SCAN rows.
    const listings = await client.query(`SELECT count(*)::int AS n FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN' AND search_profile = $1`, [PROFILE]);
    assert.equal(listings.rows[0].n, 0, 'dry run inserts nothing');
  });

  test('search_jobs tool wrapper serializes the run response as one compact text block', async () => {
    const recorded = [];
    const fake = makeFakeSession({ recorder: recorded });
    const deps = /** @type {any} */ ({
      withClient: async (/** @type {any} */ fn) => fn(client),
      config: testConfig(),
      env: {},
      calendar: null,
      fetchDetail: null,
      searchJobs: null,
      fetch: makeFixtureFetch(undefined, recorded),
      lookup: fakeLookup,
      sleep: async () => {},
      random: () => 0,
      reserveBudget: memoryReserve(),
      connectSession: fake.connectSession,
    });
    const handler = wrapHandler(searchJobs, deps);
    let out;
    for (let i = 0; i < 200; i++) {
      out = await handler({ profile: PROFILE, sources: ['greenhouse'], dryRun: true, limit: 5, wait: true }, { _meta: { progressToken: 'p1' }, sendNotification: async () => {} });
      const parsed = JSON.parse(out.content[0].text);
      if (parsed.status !== 'locked') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.ok(out);
    assert.equal(out.content.length, 1);
    const parsed = JSON.parse(out.content[0].text);
    assert.equal(parsed.ok, true, out.content[0].text);
    const dataLen = parsed.rows.length && parsed.rows[0] === ROWS_OPEN ? parsed.rows.length - 2 : parsed.rows.length;
    assert.ok(dataLen <= 5);
    assert.ok(out.content[0].text.length <= 6000, 'response, including the untrusted-rows wrap, still fits the budget');
    assert.ok(Array.isArray(parsed.blind_spots) && parsed.blind_spots.length >= 1);
  });
});
