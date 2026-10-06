// @ts-check
/**
 * Dashboard create routes and the LinkedIn page-state check (spec v1 F1.4 "Extra defect"): POST
 * /api/listings/:id/application and POST /api/listings/:id/apply-now used to label every
 * linkedin.com/jobs/view/ URL linkedin_easy 'exact' from the host alone. They now run the live page-state
 * check (deps.linkedInApplyCheck) for a LinkedIn listing and refuse with the branch unless the page shows
 * exactly one Easy Apply control. Interactive path: refuse, never park. Same createDashboardServer-against-
 * real-test-DB pattern as test/dashboard-apply-now-route.test.js; the check itself is a fake (no browser).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createCalendarCache } from '../src/dashboard/calendar-cache.js';

const CO = `ZZ-TEST-LICHECK-${process.pid}`;
/** @type {any} */
let deps;
/** @type {pg.Client} */
let verifyClient;
/** @type {string} */
let outputRoot;
/** @type {number} */
let port;
/** @type {ReturnType<typeof createDashboardServer>} */
let app;
/** @type {number[]} */
const listingIds = [];
/** @type {number[]} */
let checkCalls;
/** @type {string} */
let checkBranch;

/** @param {string} url */
async function seedListing(url) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url, url_normalized)
     VALUES ('LinkedIn Check Test', $1, 'linkedin', $2, 'listing', $3, 'linkedin check test', 'legacy-unknown', $4, now(), $5, $5) RETURNING id`,
    [CO, `zz-test-licheck-${process.pid}:${n}`, `licheck co ${n}`, `zz-licheck-hash-${n}`, url.replace('{n}', String(n))],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await verifyClient.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  verifyClient = new pg.Client(pgConnectionConfig());
  await verifyClient.connect();
  await ensureAuxSchema(verifyClient);
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-licheck-output-'));
  deps = {
    withClient,
    config: loadConfig(),
    env: {
      OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'test-model', GOOGLE_TOKEN_FILE: '', REMINDER_TO: '',
      SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null,
      JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null,
    },
    calendar: async () => null,
    calendarCache: createCalendarCache(),
    scanRunner: { async start() { return { runId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    applyRunner: { async start(id) { return { applicationId: id, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    resumeRunner: { async run() { return { ok: false, reason: 'test' }; }, status() { return { running: false }; } },
    reviewRunner: { async run() { return { ok: false }; }, status() { return { running: false }; } },
    credentials: { read: async () => null, write: async () => {}, delete: async () => false, list: async () => [] },
    outputRoot, version: 'test', startedAt: new Date().toISOString(), healthBanner: [],
    applyExclusionGate: async () => false,
    linkedInApplyCheck: async (/** @type {number} */ listingId) => { checkCalls.push(listingId); return { branch: checkBranch, reason: 'test' }; },
  };
  app = createDashboardServer(/** @type {any} */ (deps));
  await app.listen(0, '127.0.0.1');
  port = /** @type {any} */ (app.server.address()).port;
});

after(async () => {
  await cleanup();
  await verifyClient.end();
  await app.close();
  await closePool();
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

beforeEach(() => {
  checkCalls = [];
  checkBranch = 'easy_apply';
});

/** @param {string} p */
async function post(p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** @param {number} listingId */
async function appCount(listingId) {
  const r = await verifyClient.query('SELECT count(*)::int AS n FROM ic_job_applications WHERE listing_id = $1', [listingId]);
  return r.rows[0].n;
}

describe('POST /api/listings/:id/application: LinkedIn listings require the page-state check', () => {
  test('an external-apply LinkedIn page is refused with its branch; no application is created', async () => {
    checkBranch = 'external';
    const id = await seedListing('https://www.linkedin.com/jobs/view/4{n}/');
    const r = await post(`/api/listings/${id}/application`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'LINKEDIN_NOT_EASY_APPLY');
    assert.equal(r.json.details.branch, 'external');
    assert.deepEqual(checkCalls, [id]);
    assert.equal(await appCount(id), 0);
  });

  test('an auth wall during the check is refused with branch auth_wall', async () => {
    checkBranch = 'auth_wall';
    const id = await seedListing('https://www.linkedin.com/jobs/view/4{n}/');
    const r = await post(`/api/listings/${id}/application`);
    assert.equal(r.status, 409);
    assert.equal(r.json.details.branch, 'auth_wall');
    assert.equal(await appCount(id), 0);
  });

  test('a verified Easy Apply page creates a linkedin_easy application, never confidence exact', async () => {
    checkBranch = 'easy_apply';
    const id = await seedListing('https://www.linkedin.com/jobs/view/4{n}/');
    const r = await post(`/api/listings/${id}/application`);
    assert.equal(r.status, 201);
    assert.equal(r.json.row.ats_type, 'linkedin_easy');
    assert.notEqual(r.json.ats.confidence, 'exact');
  });

  test('a non-LinkedIn listing never runs the check', async () => {
    const id = await seedListing('https://boards.greenhouse.io/zzlicheck/jobs/{n}');
    const r = await post(`/api/listings/${id}/application`);
    assert.equal(r.status, 201);
    assert.deepEqual(checkCalls, []);
  });

  test('no check wired at all: a LinkedIn listing is refused (check_unavailable), never labeled from the host', async () => {
    const saved = deps.linkedInApplyCheck;
    delete deps.linkedInApplyCheck;
    try {
      const id = await seedListing('https://www.linkedin.com/jobs/view/4{n}/');
      const r = await post(`/api/listings/${id}/application`);
      assert.equal(r.status, 409);
      assert.equal(r.json.details.branch, 'check_unavailable');
    } finally {
      deps.linkedInApplyCheck = saved;
    }
  });
});

describe('POST /api/listings/:id/apply-now: LinkedIn listings require the page-state check', () => {
  test('a closed LinkedIn page is refused with its branch before any application is created', async () => {
    checkBranch = 'closed';
    const id = await seedListing('https://www.linkedin.com/jobs/view/4{n}/');
    const r = await post(`/api/listings/${id}/apply-now`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'LINKEDIN_NOT_EASY_APPLY');
    assert.equal(r.json.details.branch, 'closed');
    assert.equal(await appCount(id), 0);
  });
});
