// @ts-check
/**
 * Apply pipeline slice 4: POST /api/credentials (resume path: needs_human -> approved, attempt+1) and
 * the dashboard's 10 s-tick credential auto-resume check (stream.js's pollCredentialResume, exposed as
 * `streamHub.checkCredentialResumes()` for deterministic testing). Same route-level pattern as
 * test/dashboard-server.test.js: createDashboardServer against the real isolated test DB, with
 * scanRunner/calendar stubbed and deps.credentials backed by an in-memory fake -- never a real
 * PowerShell process.
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
import { createApplication, transition, getApplication } from '../src/core/applications.js';

const CO = `ZZ-TEST-CREDROUTE-${process.pid}`;

/** @type {pg.Client} */
let verifyClient;
/** @type {string} */
let outputRoot;
/** @type {number} */
let port;
/** @type {ReturnType<typeof createDashboardServer>} */
let app;
/** @type {Map<string, {username:string,password:string}>} */
let credStore;
/** @type {number[]} */
const listingIds = [];

function makeStubScanRunner() {
  return {
    async start() { return { runId: 1, pid: 1234 }; },
    status() { return { running: false, runId: null, pid: null, startedAt: null }; },
    armCancelBackstop() { return { forced_kill_available: false }; },
  };
}

/** In-memory fake matching the `deps.credentials` shape (src/core/credentials.js's createCredentials() return shape). */
function makeFakeCredentials(store) {
  return {
    async read(target) { return store.has(target) ? store.get(target) : null; },
    async write(target, username, password) { store.set(target, { username, password }); },
    async delete(target) { const had = store.has(target); store.delete(target); return had; },
    async list() { return [...store.keys()]; },
  };
}

/** @param {string} state @param {any} [extra] */
async function seedListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Cred Route Test', $1, $2, $3, 'listing', 'cred route test co', 'cred route test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-credroute-${process.pid}`, `zz-test-credroute-${process.pid}:${n}`, `zz-credroute-hash-${n}`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {string} target */
async function seedNeedsHumanCredentialApplication(target) {
  const listingId = await seedListing();
  const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
  await transition(verifyClient, created.id, 'needs_human', {
    actor: 'apply',
    pending_question: { kind: 'credential', target, username: 'djwmobley@gmail.com' },
  });
  return created.id;
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

  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-credroute-output-'));
  for (const dir of ['resumes', 'coverletters', 'cheatsheets', 'markdown', 'research', 'reports']) {
    fs.mkdirSync(path.join(outputRoot, dir), { recursive: true });
  }

  credStore = new Map();
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
    credentials: makeFakeCredentials(credStore),
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
  credStore.clear();
});

/** @param {string} method @param {string} p @param {{ body?: unknown }} [opts] */
async function req(method, p, opts = {}) {
  const isMutating = method.toUpperCase() !== 'GET';
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: isMutating ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

describe('POST /api/credentials: writes the credential and resumes needs_human -> approved', () => {
  test('happy path: attempt increments, pending_question clears, credential is stored, password never echoed', async () => {
    const target = 'ic-jobsearch/boards.greenhouse.io';
    const applicationId = await seedNeedsHumanCredentialApplication(target);
    const before = await getApplication(verifyClient, applicationId);
    assert.equal(before.attempt, 0);

    const r = await req('POST', '/api/credentials', {
      body: { applicationId, target, username: 'djwmobley@gmail.com', password: 'S3cret!Pass' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.row.state, 'approved');
    assert.equal(r.json.row.attempt, 1);
    assert.equal(r.json.row.pending_question, null);
    assert.ok(!r.text.includes('S3cret!Pass'), 'the response body must never echo the password back');

    assert.deepEqual(credStore.get(target), { username: 'djwmobley@gmail.com', password: 'S3cret!Pass' });

    const after = await getApplication(verifyClient, applicationId);
    assert.equal(after.state, 'approved');
    assert.equal(after.attempt, 1);
  });

  test('rejects a malformed target, missing username, or missing password before writing anything', async () => {
    const applicationId = await seedNeedsHumanCredentialApplication('ic-jobsearch/jobs.lever.co');
    const badTarget = await req('POST', '/api/credentials', { body: { applicationId, target: 'not-a-target', username: 'a@b.com', password: 'pw' } });
    assert.equal(badTarget.status, 400);
    const noUser = await req('POST', '/api/credentials', { body: { applicationId, target: 'ic-jobsearch/jobs.lever.co', password: 'pw' } });
    assert.equal(noUser.status, 400);
    const noPassword = await req('POST', '/api/credentials', { body: { applicationId, target: 'ic-jobsearch/jobs.lever.co', username: 'a@b.com' } });
    assert.equal(noPassword.status, 400);
    assert.equal(credStore.size, 0, 'no credential must be written when validation fails');
    const row = await getApplication(verifyClient, applicationId);
    assert.equal(row.state, 'needs_human', 'a failed validation must never resume the application');
  });

  test('resuming an application not currently in needs_human is rejected (resume() own guard, not swallowed)', async () => {
    const listingId = await seedListing();
    const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
    const r = await req('POST', '/api/credentials', {
      body: { applicationId: created.id, target: 'ic-jobsearch/boards.greenhouse.io', username: 'a@b.com', password: 'pw' },
    });
    assert.equal(r.status, 400);
  });
});

describe('stream.js: credential auto-resume tick (needs_human, kind credential)', () => {
  test('a credential saved directly (simulating bin/cred.js while the dashboard tab is not open) resumes on the next tick', async () => {
    const target = 'ic-jobsearch/jobs.smartrecruiters.com';
    const applicationId = await seedNeedsHumanCredentialApplication(target);
    // Simulate `node bin/cred.js set` having written the credential directly, with nobody ever hitting
    // POST /api/credentials or having a browser tab open.
    credStore.set(target, { username: 'djwmobley@gmail.com', password: 'cli-set-pw' });

    await app.streamHub.checkCredentialResumes();

    const row = await getApplication(verifyClient, applicationId);
    assert.equal(row.state, 'approved');
    assert.equal(row.attempt, 1);
  });

  test('an application whose credential is still missing is left untouched', async () => {
    const target = 'ic-jobsearch/careers.example-not-set.com';
    const applicationId = await seedNeedsHumanCredentialApplication(target);
    await app.streamHub.checkCredentialResumes();
    const row = await getApplication(verifyClient, applicationId);
    assert.equal(row.state, 'needs_human');
  });

  test('a needs_human application with a non-credential pending_question kind is never touched by this check', async () => {
    const listingId = await seedListing();
    const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
    await transition(verifyClient, created.id, 'needs_human', { actor: 'apply', pending_question: { kind: 'question', label: 'salary?' } });
    await app.streamHub.checkCredentialResumes();
    const row = await getApplication(verifyClient, created.id);
    assert.equal(row.state, 'needs_human');
  });
});
