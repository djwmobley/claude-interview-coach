// @ts-check
/**
 * Apply pipeline slice 5 dashboard routes: Retry, "I applied by hand", the answer box (POST /api/
 * applications/:id/answer), the screenshot route (GET /api/applications/:id/screenshot), and the
 * loopback-only internal apply-progress sink (POST /api/internal/apply-progress). Same route-level
 * pattern as test/dashboard-credentials-route.test.js: createDashboardServer against the real isolated
 * test DB, scanRunner/calendar/credentials stubbed, and a fake applyRunner so "does Approve/Retry/answer
 * start the runner" is directly observable.
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
import { createApplication, transition, getApplication, listApplicationEvents } from '../src/core/applications.js';

const CO = `ZZ-TEST-APPROUTE5-${process.pid}`;

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
let applyRunnerStartCalls;

function makeStubScanRunner() {
  return {
    async start() { return { runId: 1, pid: 1234 }; },
    status() { return { running: false, runId: null, pid: null, startedAt: null }; },
    armCancelBackstop() { return { forced_kill_available: false }; },
  };
}

function makeFakeApplyRunner() {
  return {
    async start(applicationId) { applyRunnerStartCalls.push(Number(applicationId)); return { applicationId, pid: 999 }; },
    status() { return { running: false, applicationId: null, pid: null, startedAt: null }; },
    armCancelBackstop() { return { forced_kill_available: false }; },
  };
}

async function seedListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('App Route 5 Test', $1, $2, $3, 'listing', 'app route 5 test co', 'app route 5 test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-approute5-${process.pid}`, `zz-test-approute5-${process.pid}:${n}`, `zz-approute5-hash-${n}`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {'failed'|'needs_human'} state @param {any} [extra] */
async function seedApplicationAt(state, extra = {}) {
  const listingId = await seedListing();
  const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
  await transition(verifyClient, created.id, 'needs_human', { actor: 'apply', pending_question: extra.pending_question ?? { kind: 'unrecognized_page', label: 'x' } });
  if (state === 'failed') {
    await verifyClient.query(`UPDATE ic_job_applications SET state = 'failed', error = 'boom' WHERE id = $1`, [created.id]);
  }
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

  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-approute5-output-'));
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
    // Answer-fallback F6/F7: a temp bank file, never the real data/apply-answers.md.
    answerBankPath: path.join(outputRoot, 'apply-answers.md'),
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
  applyRunnerStartCalls = [];
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

describe('POST /api/applications/:id/approve kicks the apply runner', () => {
  test('a successful Approve starts the apply runner for that application id', async () => {
    const listingId = await seedListing();
    const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
    const relPath = `resumes/approve-kick-${created.id}.docx`;
    fs.writeFileSync(path.join(outputRoot, relPath), 'fake docx');
    await verifyClient.query(
      `INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp')`,
      [listingId, relPath],
    );
    await verifyClient.query(`UPDATE ic_job_applications SET state = 'docs_ready', resume_doc_id = (SELECT id FROM ic_job_documents WHERE listing_id = $1) WHERE id = $2`, [listingId, created.id]);

    const r = await req('POST', `/api/applications/${created.id}/approve`);
    assert.equal(r.status, 200);
    assert.equal(r.json.row.state, 'approved');
    assert.deepEqual(applyRunnerStartCalls, [created.id]);
  });
});

describe('POST /api/applications/:id/retry', () => {
  test('failed -> approved, attempt increments, apply runner is started', async () => {
    const id = await seedApplicationAt('failed');
    const before = await getApplication(verifyClient, id);
    const r = await req('POST', `/api/applications/${id}/retry`);
    assert.equal(r.status, 200);
    assert.equal(r.json.row.state, 'approved');
    assert.equal(r.json.row.attempt, before.attempt + 1);
    assert.deepEqual(applyRunnerStartCalls, [id]);
  });

  test('rejects retry from a non-failed state', async () => {
    const id = await seedApplicationAt('needs_human');
    const r = await req('POST', `/api/applications/${id}/retry`);
    assert.equal(r.status, 400);
    assert.deepEqual(applyRunnerStartCalls, []);
  });
});

describe('POST /api/applications/:id/applied-by-hand', () => {
  test('needs_human -> submitted, no attempt increment, no runner kick', async () => {
    const id = await seedApplicationAt('needs_human');
    const before = await getApplication(verifyClient, id);
    const r = await req('POST', `/api/applications/${id}/applied-by-hand`);
    assert.equal(r.status, 200);
    assert.equal(r.json.row.state, 'submitted');
    assert.equal(r.json.row.attempt, before.attempt);
    assert.deepEqual(applyRunnerStartCalls, []);
  });
});

describe('POST /api/applications/:id/answer', () => {
  test('rejects when the application is not awaiting a question (e.g. a credential pending_question)', async () => {
    const id = await seedApplicationAt('needs_human', { pending_question: { kind: 'credential', target: 'ic-jobsearch/x.test', username: 'a@b.com' } });
    const r = await req('POST', `/api/applications/${id}/answer`, { body: { text: 'yes' } });
    assert.equal(r.status, 400);
  });

  test('with no suggestion key, resumes the application and records the answer as a note (never invents a new bank key)', async () => {
    const id = await seedApplicationAt('needs_human', { pending_question: { kind: 'question', label: 'Why do you want to work here?' } });
    const r = await req('POST', `/api/applications/${id}/answer`, { body: { text: 'Great mission fit.', save: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.row.state, 'approved');
    assert.deepEqual(applyRunnerStartCalls, [id]);
    const events = await listApplicationEvents(verifyClient, id);
    assert.ok(events.some((e) => e.note && e.note.includes('Great mission fit.')));
  });

  test('rejects an empty answer', async () => {
    const id = await seedApplicationAt('needs_human', { pending_question: { kind: 'question', label: 'x' } });
    const r = await req('POST', `/api/applications/${id}/answer`, { body: { text: '   ' } });
    assert.equal(r.status, 400);
  });
});

describe('POST /api/applications/:id/answer, parked choice field (answer-fallback F6/F7)', () => {
  const bankFile = () => path.join(outputRoot, 'apply-answers.md');
  const BANK_TEXT = ['## how_did_you_hear', 'type: enum', 'value: Job Board', 'fallback: 2 | Internet Search', 'learned: How Did You Hear About Us?', ''].join('\n');
  const choicePq = { kind: 'question', label: 'How did you find this role?', options: ['Job Board', 'Referral'], field_kind: 'listbox' };

  test('an answer that is not one of the offered options is refused with 409 and nothing is written', async () => {
    fs.writeFileSync(bankFile(), BANK_TEXT);
    const id = await seedApplicationAt('needs_human', { pending_question: choicePq });
    const r = await req('POST', `/api/applications/${id}/answer`, { body: { text: 'referral' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'not_an_offered_option');
    assert.equal(fs.readFileSync(bankFile(), 'utf8'), BANK_TEXT);
    assert.equal((await getApplication(verifyClient, id)).state, 'needs_human');
    assert.deepEqual(applyRunnerStartCalls, []);
  });

  test('an offered option is applied to the bank (new key, learned label) and the application resumes', async () => {
    fs.writeFileSync(bankFile(), BANK_TEXT);
    const id = await seedApplicationAt('needs_human', { pending_question: choicePq });
    const r = await req('POST', `/api/applications/${id}/answer`, { body: { text: 'Referral' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.row.state, 'approved');
    assert.deepEqual(applyRunnerStartCalls, [id]);
    const { parseAnswerBank } = await import('../src/apply/answers.js');
    const bank = parseAnswerBank(fs.readFileSync(bankFile(), 'utf8'));
    assert.deepEqual(bank.labels.get('how did you find this role'), { key: 'q_how_did_you_find_this_role', tier: 'learned', polarity: 'same' });
    assert.equal(/** @type {any} */ (bank.facts.get('q_how_did_you_find_this_role')).value, 'Referral');
    const events = await listApplicationEvents(verifyClient, id);
    assert.ok(events.some((e) => e.note && e.note.includes('q_how_did_you_find_this_role')));
  });

  test('a bank that does not parse fails the request visibly; the file and the application are untouched', async () => {
    const broken = `${BANK_TEXT}fallback: 2 | Duplicate rank\n`;
    fs.writeFileSync(bankFile(), broken);
    const id = await seedApplicationAt('needs_human', { pending_question: choicePq });
    const r = await req('POST', `/api/applications/${id}/answer`, { body: { text: 'Referral' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'bank_write_failed');
    assert.equal(fs.readFileSync(bankFile(), 'utf8'), broken);
    assert.equal((await getApplication(verifyClient, id)).state, 'needs_human');
  });

  test('the text-question save path (operator path) is parse-validated too: a broken bank fails visibly', async () => {
    const broken = `${BANK_TEXT}garbage under a key\n`;
    fs.writeFileSync(bankFile(), broken);
    const id = await seedApplicationAt('needs_human', { pending_question: { kind: 'question', label: 'Where did you hear about this job', suggestion: { key: 'how_did_you_hear', value: null } } });
    const r = await req('POST', `/api/applications/${id}/answer`, { body: { text: 'Job Board', save: true } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'bank_write_failed');
    assert.equal(fs.readFileSync(bankFile(), 'utf8'), broken);
  });
});

describe('GET /api/applications/:id/screenshot', () => {
  test('404 when there is no screenshot', async () => {
    const id = await seedApplicationAt('needs_human');
    const r = await req('GET', `/api/applications/${id}/screenshot`);
    assert.equal(r.status, 404);
  });

  test('serves the latest PNG bytes when one exists', async () => {
    const id = await seedApplicationAt('needs_human');
    const dir = path.join(outputRoot, 'applications', String(id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-01-01T00-00-00-000Z.png'), Buffer.from([1, 2, 3]));
    const r = await req('GET', `/api/applications/${id}/screenshot`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual([...r.buf], [1, 2, 3]);
  });
});

describe('POST /api/internal/apply-progress', () => {
  test('records a progress event on the application', async () => {
    const id = await seedApplicationAt('needs_human');
    const r = await req('POST', '/api/internal/apply-progress', { body: { applicationId: id, message: 'submitting' } });
    assert.equal(r.status, 200);
    const events = await listApplicationEvents(verifyClient, id);
    assert.ok(events.some((e) => e.kind === 'progress' && e.note === 'submitting'));
  });

  test('rejects a missing/invalid applicationId', async () => {
    const r = await req('POST', '/api/internal/apply-progress', { body: { message: 'x' } });
    assert.equal(r.status, 400);
  });
});
