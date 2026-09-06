// @ts-check
/**
 * GET /api/activity (activity pill spec item 1): shape, operator/background precedence, trigger
 * classification, and running-marker integration. Runs against the real isolated test DB
 * (ic_job_listings/ic_job_applications for the listing_id lookup, ic_scan_runs for the background scan
 * classification), matching test/dashboard-server.test.js's own house pattern: a real
 * createDashboardServer on port 0 with stubbed runners, everything else real. Every assertion about
 * `background`'s scan entries looks up THIS file's own inserted run_id rather than asserting on the
 * array's total length or contents, because ic_scan_runs is a table other test files in this same
 * `npm test` run may also touch (bootstrap-test-db.js only guarantees a fresh DB at the START of a whole
 * `npm test` invocation, not between individual test FILES within it) -- operator classification itself
 * has no such risk, since it depends only on this file's own stubbed runner statuses, never on DB rows.
 */
import { test, describe, before, after } from 'node:test';
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
import { timeInTz } from '../src/core/report.js';
import { runningMarkerPath, writeRunningMarker, deleteRunningMarker } from '../src/core/running-marker.js';

const CO = `ZZ-TEST-ACTIVITY-${process.pid}`;
const TIMEZONE = loadConfig().adapters.run.timezone;

/** @type {pg.Client} */
let verifyClient;
/** @type {string} */
let logDir;
/** @type {number} */
let port;
/** @type {ReturnType<typeof createDashboardServer>} */
let app;
/** @type {{ resume: any, review: any, apply: any, scan: any }} */
let stubs;
/** @type {number[]} */
const listingIds = [];
/** @type {number[]} */
const applicationIds = [];
/** @type {number[]} */
const scanRunIds = [];

function idleStatus() {
  return { running: false, applicationId: null, startedAt: null };
}

async function insertListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Activity Test', $1, $2, $3, 'listing', 'activity test co', 'activity test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-activity-${process.pid}`, `zz-test-activity-${process.pid}:${n}`, `zz-activity-hash-${n}`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

async function insertApplication(listingId) {
  const r = await verifyClient.query(
    `INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'drafting') RETURNING id`,
    [listingId],
  );
  const id = Number(r.rows[0].id);
  applicationIds.push(id);
  return id;
}

/** @param {{ trigger: string, status?: string, startedAt?: Date }} o */
async function insertScanRun(o) {
  const r = await verifyClient.query(
    `INSERT INTO ic_scan_runs (profile, trigger, status, started_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`zz-test-activity-${process.pid}`, o.trigger, o.status ?? 'running', o.startedAt ?? new Date()],
  );
  const id = Number(r.rows[0].id);
  scanRunIds.push(id);
  return id;
}

async function cleanup() {
  if (scanRunIds.length) await verifyClient.query('DELETE FROM ic_scan_runs WHERE id = ANY($1::int[])', [scanRunIds]);
  if (applicationIds.length) await verifyClient.query('DELETE FROM ic_job_applications WHERE id = ANY($1::int[])', [applicationIds]);
  if (listingIds.length) await verifyClient.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  scanRunIds.length = 0;
  applicationIds.length = 0;
  listingIds.length = 0;
}

before(async () => {
  verifyClient = new pg.Client(pgConnectionConfig());
  await verifyClient.connect();
  await ensureAuxSchema(verifyClient);

  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-activity-logdir-'));

  stubs = { resume: idleStatus(), review: idleStatus(), apply: idleStatus(), scan: { running: false, runId: null, pid: null, startedAt: null } };

  const deps = {
    withClient,
    config: loadConfig(),
    env: {
      OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'test-model',
      GOOGLE_TOKEN_FILE: '', REMINDER_TO: '',
      SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: logDir, CHROME_EXECUTABLE: null,
      JOBSEARCH_LOG_DIR: logDir, JOBSEARCH_CONFIG_DIR: logDir, LOG_LEVEL: 'silent', PG_DSN: null,
    },
    calendar: null,
    calendarCache: createCalendarCache(),
    scanRunner: { status: () => stubs.scan, start: async () => { throw new Error('unused'); }, armCancelBackstop: () => ({ forced_kill_available: false }) },
    resumeRunner: { status: () => stubs.resume, run: async () => { throw new Error('unused'); } },
    reviewRunner: { status: () => stubs.review, run: async () => { throw new Error('unused'); } },
    applyRunner: { status: () => stubs.apply, start: async () => { throw new Error('unused'); } },
    outputRoot: logDir,
    version: 'test',
    startedAt: new Date().toISOString(),
    healthBanner: [],
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
  fs.rmSync(logDir, { recursive: true, force: true });
});

/** Reset every stub to idle before each test so tests never leak state into one another. */
function resetStubs() {
  stubs.resume = idleStatus();
  stubs.review = idleStatus();
  stubs.apply = idleStatus();
  stubs.scan = { running: false, runId: null, pid: null, startedAt: null };
}

async function getActivity() {
  const res = await fetch(`http://127.0.0.1:${port}/api/activity`);
  const json = await res.json();
  return { status: res.status, json };
}

describe('GET /api/activity: shape', () => {
  test('idle: operator null, operator_extra 0, background is an array', async () => {
    resetStubs();
    const { status, json } = await getActivity();
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.operator, null);
    assert.equal(json.operator_extra, 0);
    assert.ok(Array.isArray(json.background));
  });
});

describe('GET /api/activity: operator candidates', () => {
  test('a running resumeRunner resolves listing_id and produces a "Drafting resume for #N" label', async () => {
    resetStubs();
    const listingId = await insertListing();
    const applicationId = await insertApplication(listingId);
    stubs.resume = { running: true, applicationId, startedAt: '2026-09-05T06:00:00.000Z' };
    const { json } = await getActivity();
    assert.ok(json.operator);
    assert.equal(json.operator.kind, 'resume');
    assert.equal(json.operator.phase, 'drafting_resume');
    assert.equal(json.operator.application_id, applicationId);
    assert.equal(json.operator.listing_id, listingId);
    assert.equal(json.operator.label, `Drafting resume for #${listingId}`);
    assert.equal(json.operator_extra, 0);
  });

  test('a running reviewRunner produces a "Reviewing #N" label', async () => {
    resetStubs();
    const listingId = await insertListing();
    const applicationId = await insertApplication(listingId);
    stubs.review = { running: true, applicationId, startedAt: '2026-09-05T06:00:00.000Z' };
    const { json } = await getActivity();
    assert.equal(json.operator.kind, 'review');
    assert.equal(json.operator.phase, 'reviewing');
    assert.equal(json.operator.label, `Reviewing #${listingId}`);
  });

  test('a running applyRunner produces a submitting label', async () => {
    resetStubs();
    const listingId = await insertListing();
    const applicationId = await insertApplication(listingId);
    stubs.apply = { running: true, applicationId, pid: 999, startedAt: '2026-09-05T06:00:00.000Z' };
    const { json } = await getActivity();
    assert.equal(json.operator.kind, 'apply');
    assert.equal(json.operator.phase, 'submitting');
    assert.equal(json.operator.label, `Submitting #${listingId}`);
  });

  test('a dashboard-tracked running scan produces "Scanning (manual)" with null application_id/listing_id', async () => {
    resetStubs();
    stubs.scan = { running: true, runId: 999999, pid: 1234, startedAt: '2026-09-05T06:00:00.000Z' };
    const { json } = await getActivity();
    assert.equal(json.operator.kind, 'scan');
    assert.equal(json.operator.phase, 'scanning');
    assert.equal(json.operator.label, 'Scanning (manual)');
    assert.equal(json.operator.application_id, null);
    assert.equal(json.operator.listing_id, null);
  });

  test('an application whose id resolves to no listing_id row still returns a defined (not crashing) fallback label', async () => {
    resetStubs();
    stubs.resume = { running: true, applicationId: 2 ** 30 - 1, startedAt: '2026-09-05T06:00:00.000Z' };
    const { status, json } = await getActivity();
    assert.equal(status, 200);
    assert.equal(json.operator.listing_id, null);
    assert.equal(json.operator.label, 'Drafting resume');
  });

  test('more than one running operator action: operator is the MOST RECENT, operator_extra counts the rest', async () => {
    resetStubs();
    const listingId1 = await insertListing();
    const applicationId1 = await insertApplication(listingId1);
    const listingId2 = await insertListing();
    const applicationId2 = await insertApplication(listingId2);
    stubs.resume = { running: true, applicationId: applicationId1, startedAt: '2026-09-05T06:00:00.000Z' };
    stubs.review = { running: true, applicationId: applicationId2, startedAt: '2026-09-05T06:05:00.000Z' };
    stubs.scan = { running: true, runId: 999998, pid: 1, startedAt: '2026-09-05T06:02:00.000Z' };
    const { json } = await getActivity();
    // review (06:05) is the most recent of the three (resume 06:00, scan 06:02, review 06:05).
    assert.equal(json.operator.kind, 'review');
    assert.equal(json.operator_extra, 2);
  });
});

describe('GET /api/activity: background scan classification', () => {
  test('trigger "cli" gets the "Scheduled scan running since HH:MM" label in the configured timezone', async () => {
    resetStubs();
    const startedAt = new Date('2026-09-05T11:31:00.000Z');
    const runId = await insertScanRun({ trigger: 'cli', startedAt });
    const { json } = await getActivity();
    const entry = json.background.find((b) => b.run_id === runId);
    assert.ok(entry, 'expected the inserted cli-trigger run to appear in background');
    assert.equal(entry.kind, 'scan');
    assert.equal(entry.label, `Scheduled scan running since ${timeInTz(startedAt, TIMEZONE)}`);
  });

  test('trigger "mcp" gets a distinct generic label', async () => {
    resetStubs();
    const runId = await insertScanRun({ trigger: 'mcp' });
    const { json } = await getActivity();
    const entry = json.background.find((b) => b.run_id === runId);
    assert.ok(entry);
    assert.equal(entry.label, 'Scan running (started from the MCP tool)');
  });

  test('an orphaned trigger "dashboard" row (scanRunner not tracking it) still lands in background, never dropped', async () => {
    resetStubs();
    const runId = await insertScanRun({ trigger: 'dashboard' });
    const { json } = await getActivity();
    const entry = json.background.find((b) => b.run_id === runId);
    assert.ok(entry, 'total classification: an orphaned dashboard-trigger row must not vanish from both buckets');
    assert.equal(entry.label, 'Scan running (background)');
  });

  test('a scan row THIS scanRunner is tracking is excluded from background (it is the operator entry instead)', async () => {
    resetStubs();
    const runId = await insertScanRun({ trigger: 'dashboard' });
    stubs.scan = { running: true, runId, pid: 1, startedAt: '2026-09-05T06:00:00.000Z' };
    const { json } = await getActivity();
    assert.equal(json.background.find((b) => b.run_id === runId), undefined);
    assert.equal(json.operator.kind, 'scan');
  });

  test('a finished (non-running) scan row never appears in background', async () => {
    resetStubs();
    const runId = await insertScanRun({ trigger: 'cli', status: 'ok' });
    const { json } = await getActivity();
    assert.equal(json.background.find((b) => b.run_id === runId), undefined);
  });
});

describe('GET /api/activity: running markers', () => {
  test('a fresh auto-apply marker appears in background as "Auto-apply running"', async () => {
    resetStubs();
    const file = runningMarkerPath(logDir, 'auto-apply');
    writeRunningMarker(file, { pid: process.pid, startedAt: new Date(), runId: null });
    try {
      const { json } = await getActivity();
      const entry = json.background.find((b) => b.kind === 'auto-apply');
      assert.ok(entry);
      assert.equal(entry.label, 'Auto-apply running');
      assert.equal(entry.run_id, null);
    } finally {
      deleteRunningMarker(file);
    }
  });

  test('a fresh confirm marker appears in background', async () => {
    resetStubs();
    const file = runningMarkerPath(logDir, 'confirm');
    writeRunningMarker(file, { pid: process.pid, startedAt: new Date(), runId: null });
    try {
      const { json } = await getActivity();
      const entry = json.background.find((b) => b.kind === 'confirm');
      assert.ok(entry);
    } finally {
      deleteRunningMarker(file);
    }
  });

  test('a stale (dead-pid) auto-apply marker is ignored and removed from disk', async () => {
    resetStubs();
    const file = runningMarkerPath(logDir, 'auto-apply');
    writeRunningMarker(file, { pid: 2 ** 30 - 1, startedAt: new Date(), runId: null });
    const { json } = await getActivity();
    assert.equal(json.background.find((b) => b.kind === 'auto-apply'), undefined);
    assert.ok(!fs.existsSync(file));
  });

  test('no marker file at all is simply absent from background, never an error', async () => {
    resetStubs();
    const { status, json } = await getActivity();
    assert.equal(status, 200);
    assert.equal(json.background.find((b) => b.kind === 'auto-apply' || b.kind === 'confirm'), undefined);
  });
});
