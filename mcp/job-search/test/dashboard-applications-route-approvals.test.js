// @ts-check
/**
 * GET /api/applications (review-approvals-list PR spec A1): the Review page "Applications awaiting
 * approval" list's data source. Same createDashboardServer-against-real-test-DB pattern as
 * test/dashboard-applications-route-slice5.test.js -- this file only exercises the new read route, not
 * the Approve/Retry/etc. mutation routes those files already cover.
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
import { APPLICATION_STATES, recordSubmitRequestSent } from '../src/core/applications.js';

const CO = `ZZ-TEST-APPROVALSROUTE-${process.pid}`;
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

function makeStubScanRunner() {
  return {
    async start() { return { runId: 1, pid: 1234 }; },
    status() { return { running: false, runId: null, pid: null, startedAt: null }; },
    armCancelBackstop() { return { forced_kill_available: false }; },
  };
}
/** Every applicationId the fake apply runner was asked to start (the confirm-submitted test asserts none). */
const applyRunnerStarts = [];
function makeFakeApplyRunner() {
  return {
    async start(applicationId) { applyRunnerStarts.push(applicationId); return { applicationId, pid: 999 }; },
    status() { return { running: false, applicationId: null, pid: null, startedAt: null }; },
    armCancelBackstop() { return { forced_kill_available: false }; },
  };
}

/** Unique-per-call company_norm/title_norm, matching the collision-avoidance pattern this file's sibling
 * route tests already use (test/dashboard-apply-now-route.test.js's seedUniqueListing) -- the exclusion
 * classifier's company+title match branches search the real test DB globally, not scoped to this file's
 * own listingIds, so a shared literal company_norm risks an incidental match against another test's own
 * leftover application rows.
 * @param {Partial<{ company: string, companyNorm: string, status: string|null, duplicateOf: number|null }>} o */
async function seedListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, apply_ats, dedup_hash, last_seen, status, duplicate_of)
     VALUES ('Approvals Route Test', $1, $2, $3, 'listing', $4, $5, 'houston-tx', 'greenhouse', $6, now(), $7, $8) RETURNING id`,
    [
      o.company ?? CO, `zz-test-approvalsroute-${process.pid}`, `zz-test-approvalsroute-${process.pid}:${n}`,
      o.companyNorm ?? `zzapprovalsrouteco${n}`, `zzapprovalsrouterole${n}`, `zz-approvalsroute-hash-${n}`,
      o.status ?? null, o.duplicateOf ?? null,
    ],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {number} listingId @param {'resume'|'coverletter'} kind @param {string} relPath */
async function insertDocument(listingId, kind, relPath) {
  const r = await verifyClient.query(
    `INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, $2, $3, 'mcp') RETURNING id`,
    [listingId, kind, relPath],
  );
  return Number(r.rows[0].id);
}

/** @param {number} listingId @param {{ state?: string, resumeDocId?: number|null, reviewVerdict?: string|null, reviewFindings?: unknown, pendingQuestion?: unknown }} [o] */
async function seedApplication(listingId, o = {}) {
  const cols = ['listing_id', 'state'];
  const vals = [listingId, o.state ?? 'docs_ready'];
  const placeholders = ['$1', '$2'];
  let i = 2;
  if (o.resumeDocId !== undefined) { i += 1; cols.push('resume_doc_id'); vals.push(o.resumeDocId); placeholders.push(`$${i}`); }
  if (o.reviewVerdict !== undefined) { i += 1; cols.push('review_verdict'); vals.push(o.reviewVerdict); placeholders.push(`$${i}`); }
  if (o.reviewFindings !== undefined) { i += 1; cols.push('review_findings'); vals.push(JSON.stringify(o.reviewFindings)); placeholders.push(`$${i}::jsonb`); }
  if (o.pendingQuestion !== undefined) { i += 1; cols.push('pending_question'); vals.push(JSON.stringify(o.pendingQuestion)); placeholders.push(`$${i}::jsonb`); }
  const r = await verifyClient.query(
    `INSERT INTO ic_job_applications (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    vals,
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  if (listingIds.length === 0) return;
  // "Confirm submitted" goes through markSubmitted, which creates the 5-day nudge follow-up for the listing.
  await verifyClient.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  verifyClient = new pg.Client(pgConnectionConfig());
  await verifyClient.connect();
  await ensureAuxSchema(verifyClient);
  await cleanup();

  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-approvalsroute-output-'));
  for (const dir of ['resumes', 'coverletters']) fs.mkdirSync(path.join(outputRoot, dir), { recursive: true });

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

/** @param {string} p */
async function get(p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  const json = await res.json();
  return { status: res.status, json };
}

describe('GET /api/applications: state validation (spec A1)', () => {
  test('default state (no query param) is docs_ready only', async () => {
    const listingId = await seedListing();
    const appId = await seedApplication(listingId, { state: 'docs_ready' });
    const other = await seedListing();
    await seedApplication(other, { state: 'needs_human', pendingQuestion: { kind: 'question', label: 'x' } });
    const r = await get('/api/applications');
    assert.equal(r.status, 200);
    assert.ok(r.json.rows.some((row) => row.application_id === appId));
    assert.ok(r.json.rows.every((row) => row.state === 'docs_ready'));
  });

  test('multi-state (comma-separated) returns rows in every listed state', async () => {
    const l1 = await seedListing();
    const a1 = await seedApplication(l1, { state: 'docs_ready' });
    const l2 = await seedListing();
    const a2 = await seedApplication(l2, { state: 'needs_human', pendingQuestion: { kind: 'question', label: 'x' } });
    const r = await get('/api/applications?state=docs_ready,needs_human');
    assert.equal(r.status, 200);
    const ids = r.json.rows.map((row) => row.application_id);
    assert.ok(ids.includes(a1));
    assert.ok(ids.includes(a2));
  });

  test('an unknown state is a 400 VALIDATION naming the offending value', async () => {
    const r = await get('/api/applications?state=bogus_state');
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'VALIDATION');
    assert.match(r.json.message, /bogus_state/);
  });

  test('one bad value inside an otherwise-valid multi-state list is still a 400 naming it', async () => {
    const r = await get('/api/applications?state=docs_ready,not_a_real_state');
    assert.equal(r.status, 400);
    assert.match(r.json.message, /not_a_real_state/);
  });

  test('a malformed list (trailing comma / empty entry) is a 400', async () => {
    const r = await get('/api/applications?state=docs_ready,');
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'VALIDATION');
  });

  test('every real APPLICATION_STATES member is individually accepted (no 400)', async () => {
    for (const s of APPLICATION_STATES) {
      const r = await get(`/api/applications?state=${s}`);
      assert.equal(r.status, 200, `state=${s} should be accepted`);
    }
  });
});

describe('GET /api/applications: row shape, blocked/sibling_active flags, cap and total (spec A1)', () => {
  test('a plain eligible docs_ready row: blocked and sibling_active both false, fields all present', async () => {
    const listingId = await seedListing();
    const resumeDocId = await insertDocument(listingId, 'resume', 'resumes/zz-approvalsroute-plain.docx');
    const appId = await seedApplication(listingId, { state: 'docs_ready', resumeDocId, reviewVerdict: 'PASS', reviewFindings: [] });
    const r = await get('/api/applications?state=docs_ready');
    assert.equal(r.status, 200);
    const row = r.json.rows.find((x) => x.application_id === appId);
    assert.ok(row, 'row must be present');
    assert.equal(row.listing_id, listingId);
    assert.equal(row.apply_ats, 'greenhouse');
    assert.equal(row.location_norm, 'houston-tx');
    assert.equal(row.resume_doc_id, resumeDocId);
    assert.equal(row.review_verdict, 'PASS');
    assert.deepEqual(row.review_findings, []);
    assert.equal(row.blocked, false);
    assert.equal(row.blocked_reason, null);
    assert.equal(row.sibling_active, false);
    assert.ok(row.created_at);
    assert.ok(row.updated_at);
  });

  test('a blocked-company listing: blocked is true with a reason', async () => {
    const listingId = await seedListing({ company: 'Immunotec Research Ltd', companyNorm: 'immunotec research' });
    const appId = await seedApplication(listingId, { state: 'docs_ready' });
    const r = await get('/api/applications?state=docs_ready');
    const row = r.json.rows.find((x) => x.application_id === appId);
    assert.equal(row.blocked, true);
    assert.match(row.blocked_reason, /blocked employer/);
  });

  test('a closed-status listing: blocked is true, reason mentions the status', async () => {
    const listingId = await seedListing({ status: 'lost' });
    const appId = await seedApplication(listingId, { state: 'docs_ready' });
    const r = await get('/api/applications?state=docs_ready');
    const row = r.json.rows.find((x) => x.application_id === appId);
    assert.equal(row.blocked, true);
    assert.match(row.blocked_reason, /"lost"/);
  });

  test('closed status on a dedup-tree ROOT (not the row\'s own listing): blocked true, reason names the root listing id', async () => {
    const rootId = await seedListing({ status: 'dead' });
    const dupId = await seedListing({ duplicateOf: rootId });
    const appId = await seedApplication(dupId, { state: 'docs_ready' });
    const r = await get('/api/applications?state=docs_ready');
    const row = r.json.rows.find((x) => x.application_id === appId);
    assert.equal(row.listing_id, dupId, 'sanity: the row itself is the duplicate, not the root');
    assert.equal(row.blocked, true);
    assert.match(row.blocked_reason, new RegExp(`listing ${rootId} status is "dead"`));
  });

  test('sibling_active: a duplicate listing whose own application already reached approved', async () => {
    const rootId = await seedListing();
    const dupId = await seedListing({ duplicateOf: rootId });
    await seedApplication(rootId, { state: 'approved' });
    const appId = await seedApplication(dupId, { state: 'docs_ready' });
    const r = await get('/api/applications?state=docs_ready');
    const row = r.json.rows.find((x) => x.application_id === appId);
    assert.equal(row.sibling_active, true);
  });

  test('parked_reason surfaces pending_question.label for needs_human rows', async () => {
    const listingId = await seedListing();
    const appId = await seedApplication(listingId, { state: 'needs_human', pendingQuestion: { kind: 'question', label: 'What is your notice period?' } });
    const r = await get('/api/applications?state=needs_human');
    const row = r.json.rows.find((x) => x.application_id === appId);
    assert.equal(row.parked_reason, 'What is your notice period?');
  });

  test('parked_reason surfaces pending_question.label for kind resume_failed too (spec section 3, amendment A3: no kind allow-list)', async () => {
    const listingId = await seedListing();
    const appId = await seedApplication(listingId, {
      state: 'needs_human', pendingQuestion: { kind: 'resume_failed', label: 'Resume drafting failed: no_docs_ready' },
    });
    const r = await get('/api/applications?state=needs_human');
    const row = r.json.rows.find((x) => x.application_id === appId);
    assert.equal(row.parked_reason, 'Resume drafting failed: no_docs_ready');
  });

  test('pending_kind surfaces pending_question.kind (null when there is none) so the Review page can gate Withdraw', async () => {
    const listingId = await seedListing();
    const appId = await seedApplication(listingId, { state: 'needs_human', pendingQuestion: { kind: 'awaiting_submit', label: 'x' } });
    const otherListing = await seedListing();
    const failedId = await seedApplication(otherListing, { state: 'failed' });
    const r = await get('/api/applications?state=needs_human,failed');
    assert.equal(r.json.rows.find((x) => x.application_id === appId).pending_kind, 'awaiting_submit');
    assert.equal(r.json.rows.find((x) => x.application_id === failedId).pending_kind, null);
  });

  test('total reflects the full matching count, independent of the 200-row cap', async () => {
    const listingId = await seedListing();
    await seedApplication(listingId, { state: 'docs_ready' });
    const r = await get('/api/applications?state=docs_ready');
    assert.equal(r.status, 200);
    assert.ok(r.json.total >= 1);
    assert.ok(r.json.rows.length <= 200);
    assert.ok(r.json.total >= r.json.rows.length);
  });
});

describe('unattended submit on the dashboard (spec item 7, v2 C8)', () => {
  test('GET /api/applications carries submit_sent: true only for a row with a submit marker', async () => {
    const a = await seedListing();
    const sentId = await seedApplication(a, { state: 'needs_human', pendingQuestion: { kind: 'submit_unconfirmed', label: 'x' } });
    await recordSubmitRequestSent(verifyClient, sentId);
    const b = await seedListing();
    const plainId = await seedApplication(b, { state: 'needs_human', pendingQuestion: { kind: 'captcha', label: 'x' } });
    const r = await get('/api/applications?state=needs_human');
    assert.equal(r.json.rows.find((x) => x.application_id === sentId).submit_sent, true);
    assert.equal(r.json.rows.find((x) => x.application_id === plainId).submit_sent, false);
  });

  test('"I applied by hand" is refused for a row the worker already submitted (already submitted, unconfirmed)', async () => {
    const a = await seedListing();
    const id = await seedApplication(a, { state: 'needs_human', pendingQuestion: { kind: 'submit_unconfirmed', label: 'x' } });
    await recordSubmitRequestSent(verifyClient, id);
    const res = await fetch(`http://127.0.0.1:${port}/api/applications/${id}/applied-by-hand`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status >= 400, true);
    const body = await res.json();
    assert.match(String(body.message), /Already submitted \(unconfirmed\)/);
    const row = (await verifyClient.query('SELECT state FROM ic_job_applications WHERE id = $1', [id])).rows[0];
    assert.equal(row.state, 'needs_human');
  });

  /** @param {number} id */
  async function confirmSubmitted(id) {
    const res = await fetch(`http://127.0.0.1:${port}/api/applications/${id}/confirm-submitted`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return { status: res.status, json: await res.json() };
  }
  const markersToday = async () => Number((await verifyClient.query(`SELECT count(*)::int AS n FROM ic_job_submit_markers WHERE day = (now() AT TIME ZONE 'UTC')::date`)).rows[0].n);

  test('"Confirm submitted" moves an unconfirmed submit to submitted (actor dashboard), with no cap change, no new marker, no worker; a second call is a no-op', async () => {
    for (const kind of ['submit_unconfirmed', 'post_submit_uncertain']) {
      const a = await seedListing();
      const id = await seedApplication(a, { state: 'needs_human', pendingQuestion: { kind, label: 'x' } });
      await recordSubmitRequestSent(verifyClient, id);
      const capBefore = await markersToday();
      const startsBefore = applyRunnerStarts.length;
      const first = await confirmSubmitted(id);
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(first.json.outcome, 'submitted');
      const row = (await verifyClient.query('SELECT state FROM ic_job_applications WHERE id = $1', [id])).rows[0];
      assert.equal(row.state, 'submitted');
      const ev = (await verifyClient.query(`SELECT actor, note, to_state FROM ic_job_application_events WHERE application_id = $1 AND kind = 'state' ORDER BY id DESC LIMIT 1`, [id])).rows[0];
      assert.deepEqual(ev, { actor: 'dashboard', note: 'confirmed by Damian', to_state: 'submitted' });
      assert.equal(await markersToday(), capBefore, 'no cap slot reserved');
      const markers = (await verifyClient.query('SELECT count(*)::int AS n FROM ic_job_application_events WHERE application_id = $1 AND note = $2', [id, 'submit_request_sent'])).rows[0].n;
      assert.equal(Number(markers), 1, 'no new marker written');
      const second = await confirmSubmitted(id);
      assert.equal(second.status, 200);
      assert.equal(second.json.outcome, 'noop');
      const stateEvents = (await verifyClient.query(`SELECT count(*)::int AS n FROM ic_job_application_events WHERE application_id = $1 AND kind = 'state'`, [id])).rows[0].n;
      assert.equal(Number(stateEvents), 1, 'the second call wrote nothing');
      assert.equal(applyRunnerStarts.length, startsBefore, 'no worker started');
    }
  });

  test('"Confirm submitted" is refused on a row with no submit marker, and on a marked row of another kind; nothing moves', async () => {
    const a = await seedListing();
    const noMarker = await seedApplication(a, { state: 'needs_human', pendingQuestion: { kind: 'submit_unconfirmed', label: 'x' } });
    const r1 = await confirmSubmitted(noMarker);
    assert.equal(r1.status >= 400, true);
    assert.match(String(r1.json.message), /no submit marker/);
    const b = await seedListing();
    const otherKind = await seedApplication(b, { state: 'needs_human', pendingQuestion: { kind: 'captcha', label: 'x' } });
    await recordSubmitRequestSent(verifyClient, otherKind);
    const r2 = await confirmSubmitted(otherKind);
    assert.equal(r2.status >= 400, true);
    assert.match(String(r2.json.message), /not an unconfirmed submit/);
    const states = (await verifyClient.query('SELECT state FROM ic_job_applications WHERE id = ANY($1::int[])', [[noMarker, otherKind]])).rows.map((x) => x.state);
    assert.deepEqual(states, ['needs_human', 'needs_human']);
  });

  test('GET /api/submissions reads submissions from the DB (last 24h) and lists unconfirmed submits separately', async () => {
    const a = await seedListing();
    const submittedId = await seedApplication(a, { state: 'submitted' });
    await verifyClient.query(`UPDATE ic_job_applications SET submitted_at = now() - interval '2 hours' WHERE id = $1`, [submittedId]);
    const b = await seedListing();
    const oldId = await seedApplication(b, { state: 'submitted' });
    await verifyClient.query(`UPDATE ic_job_applications SET submitted_at = now() - interval '3 days' WHERE id = $1`, [oldId]);
    const c = await seedListing();
    const unconfirmedId = await seedApplication(c, { state: 'needs_human', pendingQuestion: { kind: 'submit_unconfirmed', label: 'Submitted, unconfirmed.' } });
    const r = await get('/api/submissions');
    assert.equal(r.status, 200);
    assert.ok(r.json.submitted.some((x) => x.applicationId === submittedId));
    assert.equal(r.json.submitted.some((x) => x.applicationId === oldId), false);
    assert.ok(r.json.unconfirmed.some((x) => x.applicationId === unconfirmedId));
  });
});
