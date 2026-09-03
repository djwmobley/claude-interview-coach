// @ts-check
/**
 * POST /api/listings/:id/apply-now (one-click apply PR A spec item 7): create-or-reuse the drafting
 * application, 202 immediately, then the async runApplyNowChain (resume -> review -> approve -> apply).
 * Same createDashboardServer-against-real-test-DB pattern as test/dashboard-applications-route-slice5.test.js,
 * with fake resumeRunner/reviewRunner/applyRunner so the chain's own branching is directly observable
 * without a real headless claude process.
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
import { createApplication, getApplication, transition, listApplicationEvents } from '../src/core/applications.js';

const CO = `ZZ-TEST-APPLYNOW-${process.pid}`;
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
/** @type {{ run: any[] }} */
let resumeRunnerCalls;
/** @type {{ run: any[] }} */
let reviewRunnerCalls;
/** @type {number[]} */
let applyRunnerStartCalls;
/** @type {(applicationId: number, listingId: number) => Promise<{ok:boolean,reason?:string,markdownPath?:string}>} */
let resumeRunnerImpl;
/** @type {(applicationId: number, markdownPath: string, listingId: number) => Promise<{ok:boolean,verdict?:string,reason?:string}>} */
let reviewRunnerImpl;

function makeStubScanRunner() {
  return { async start() { return { runId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } };
}
function makeFakeApplyRunner() {
  return {
    async start(applicationId) { applyRunnerStartCalls.push(Number(applicationId)); return { applicationId, pid: 1 }; },
    status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; },
  };
}
function makeFakeResumeRunner() {
  return { async run(applicationId, listingId) { resumeRunnerCalls.push([applicationId, listingId]); return resumeRunnerImpl(applicationId, listingId); }, status() { return { running: false }; } };
}
function makeFakeReviewRunner() {
  return { async run(applicationId, markdownPath, listingId) { reviewRunnerCalls.push([applicationId, markdownPath, listingId]); return reviewRunnerImpl(applicationId, markdownPath, listingId); }, status() { return { running: false }; } };
}

async function seedListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Apply Now Test', $1, $2, $3, 'listing', 'apply now test co', 'apply now test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-applynow-${process.pid}`, `zz-test-applynow-${process.pid}:${n}`, `zz-applynow-hash-${n}`],
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
  await cleanup();

  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-applynow-output-'));
  for (const dir of ['resumes', 'coverletters', 'cheatsheets', 'markdown', 'research', 'reports', 'applications']) {
    fs.mkdirSync(path.join(outputRoot, dir), { recursive: true });
  }

  const deps = {
    withClient,
    config: loadConfig(),
    env: {
      OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'test-model',
      GOOGLE_TOKEN_FILE: '', REMINDER_TO: '',
      SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null,
      JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null,
    },
    calendar: async () => null,
    calendarCache: createCalendarCache(),
    scanRunner: makeStubScanRunner(),
    applyRunner: makeFakeApplyRunner(),
    resumeRunner: makeFakeResumeRunner(),
    reviewRunner: makeFakeReviewRunner(),
    credentials: { read: async () => null, write: async () => {}, delete: async () => false, list: async () => [] },
    outputRoot,
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
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resumeRunnerCalls = [];
  reviewRunnerCalls = [];
  applyRunnerStartCalls = [];
  // The fake resumeRunner's default behavior performs the SAME database side effect the real
  // src/dashboard/resume-runner.js produces on success (docs_ready + a linked, on-disk resume document) --
  // approve() (called by the chain on VERDICT: PASS) requires exactly that state, and this route test's
  // job is the CHAIN's own branching, not re-proving resume-runner.js's own internals (covered by
  // test/resume-runner.test.js instead).
  resumeRunnerImpl = async (applicationId, listingId) => {
    const relPath = `resumes/apply-now-${applicationId}.docx`;
    fs.writeFileSync(path.join(outputRoot, relPath), 'fake docx bytes');
    const docRes = await verifyClient.query(
      `INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`,
      [listingId, relPath],
    );
    await verifyClient.query('UPDATE ic_job_applications SET state = $2, resume_doc_id = $3, updated_at = now() WHERE id = $1', [applicationId, 'docs_ready', docRes.rows[0].id]);
    return { ok: true, markdownPath: 'output/markdown/x.md' };
  };
  reviewRunnerImpl = async () => ({ ok: true, verdict: 'PASS' });
});

/** @param {string} method @param {string} p @param {{ body?: unknown }} [opts] */
async function req(method, p, opts = {}) {
  const isMutating = method.toUpperCase() !== 'GET';
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: isMutating ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, json, buf };
}

/** Poll until the application reaches one of `states`, or timeout. Used to observe the async chain
 * without the route itself blocking on it. */
async function waitForState(applicationId, states, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getApplication(verifyClient, applicationId);
    if (states.includes(row.state)) return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('POST /api/listings/:id/apply-now: happy path', () => {
  test('creates a drafting application, returns 202 immediately, then chains resume -> review -> approve -> apply', async () => {
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 202);
    assert.ok(r.json.application_id);
    const appId = r.json.application_id;

    const finalRow = await waitForState(appId, ['approved']);
    assert.equal(finalRow.state, 'approved');
    assert.deepEqual(resumeRunnerCalls, [[appId, listingId]]);
    assert.deepEqual(reviewRunnerCalls, [[appId, 'output/markdown/x.md', listingId]]);
    assert.deepEqual(applyRunnerStartCalls, [appId]);

    const events = await listApplicationEvents(verifyClient, appId);
    const progressNotes = events.filter((e) => e.kind === 'progress').map((e) => e.note);
    assert.ok(progressNotes.some((n) => /drafting resume/.test(n ?? '')));
    assert.ok(progressNotes.some((n) => /reviewing/.test(n ?? '')));
    assert.ok(progressNotes.some((n) => /approving/.test(n ?? '')));
  });
});

describe('POST /api/listings/:id/apply-now: resume failure leaves the application in drafting', () => {
  test('resume runner failure stops the chain before review/approve', async () => {
    resumeRunnerImpl = async () => ({ ok: false, reason: 'no_description' });
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(reviewRunnerCalls, []);
    assert.deepEqual(applyRunnerStartCalls, []);
    const row = await getApplication(verifyClient, appId);
    assert.equal(row.state, 'drafting');
  });
});

describe('POST /api/listings/:id/apply-now: review FAIL leaves docs_ready with findings, never approved', () => {
  test('review runner FAIL stops the chain before approve', async () => {
    reviewRunnerImpl = async () => ({ ok: false, verdict: 'FAIL', reason: 'review_failed' });
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(applyRunnerStartCalls, []);
    const row = await getApplication(verifyClient, appId);
    // The default fake resumeRunner still performs its own DB side effect (docs_ready + linked resume),
    // matching the real resume-runner.js's success shape -- this test asserts the CHAIN's own branching
    // (review FAIL stops it before approve, leaving the application at docs_ready), not resume-runner.js's
    // internals, which are covered by test/resume-runner.test.js instead.
    assert.equal(row.state, 'docs_ready');
    assert.notEqual(row.state, 'approved');
  });
});

describe('POST /api/listings/:id/apply-now: 409 duplicate', () => {
  test('an active (non-drafting) application already existing for the listing is a 409, never a second run', async () => {
    const listingId = await seedListing();
    const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
    await transition(verifyClient, created.id, 'needs_human', { actor: 'apply', pending_question: { kind: 'question', label: 'x' } });
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'DUPLICATE_APPLICATION');
    assert.deepEqual(resumeRunnerCalls, []);
  });

  test('an existing drafting application is REUSED, not rejected', async () => {
    const listingId = await seedListing();
    const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 202);
    assert.equal(r.json.application_id, created.id);
  });
});
