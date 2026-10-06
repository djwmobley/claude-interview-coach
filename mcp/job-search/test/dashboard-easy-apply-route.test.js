// @ts-check
/**
 * Dashboard routes for assisted LinkedIn Easy Apply (spec B6): Focus tab (activates the stored target id;
 * a missing tab demotes to abandoned_tab), "I submitted" (checks LinkedIn's Applied badge in that tab:
 * present -> submitted; absent/unknown -> stays needs_human with a message and confirm-anyway available;
 * confirm_anyway -> submitted), Abandon (withdrawn, tab closed), the generic "I applied by hand" refusing
 * an awaiting_submit card, the breaker/status route, and Retry/Approve kicking the apply runner with the
 * longer Easy Apply hard timeout. Real test DB; fake CDP and fake driver (never a real browser).
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
import { createApplication, getApplication } from '../src/core/applications.js';
import { tripBreaker, clearBreakerForTests } from '../src/core/easy-apply-state.js';

const CO = `ZZ-TEST-EASYROUTE-${process.pid}`;
/** @type {pg.Client} */
let c;
/** @type {any} */
let app;
/** @type {number} */
let port;
/** @type {string} */
let outputRoot;
/** @type {number[]} */
const listingIds = [];
const tab = { live: true, badge: 'applied', calls: /** @type {any[]} */ ([]), profiles: /** @type {any[]} */ ([]) };
/** @type {any[]} */
const starts = [];

function fakeConnect() {
  return async () => ({
    async send(/** @type {string} */ m, /** @type {any} */ p) { tab.calls.push([m, p]); return {}; },
    async listPageTargets() { return tab.live ? [{ targetId: 'TAB-1', type: 'page', url: '', title: '' }] : []; },
    async attach() { return 'S'; },
    async detach() {},
    close() {},
  });
}

async function seed(/** @type {string} */ state, /** @type {any} */ pq, ats = 'linkedin_easy') {
  const n = Math.floor(Math.random() * 1e9);
  const r = await c.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Easy Route', $1, 'linkedin', $2, 'listing', $3, 'easy route', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-easyroute-${process.pid}:${n}`, `easy route co ${n}`, `zz-easyroute-hash-${n}`],
  );
  listingIds.push(Number(r.rows[0].id));
  const a = await createApplication(c, { listingId: Number(r.rows[0].id), atsType: ats, applyUrl: ats === 'workday' ? `https://acme.wd5.myworkdayjobs.com/careers/job/${n}` : `https://www.linkedin.com/jobs/view/${n}/`, actor: 'mcp' });
  await c.query('UPDATE ic_job_applications SET state = $2, pending_question = $3::jsonb WHERE id = $1', [a.id, state, pq ? JSON.stringify(pq) : null]);
  return a.id;
}
const awaiting = () => seed('needs_human', { kind: 'awaiting_submit', target_id: 'TAB-1', label: 'x', ledger: [{ question: 'First name', bank_key: 'first_name', value: 'Damian' }], awaiting_since: new Date().toISOString() });

async function cleanup() {
  await clearBreakerForTests(c);
  if (listingIds.length === 0) return;
  await c.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  c = new pg.Client(pgConnectionConfig());
  await c.connect();
  await ensureAuxSchema(c);
  await cleanup();
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyroute-out-'));
  app = createDashboardServer(/** @type {any} */ ({
    withClient, config: loadConfig(),
    env: { OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', GOOGLE_TOKEN_FILE: '', REMINDER_TO: '', SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null, JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null },
    calendar: async () => null, calendarCache: createCalendarCache(),
    scanRunner: { async start() { return { runId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    applyRunner: { async start(/** @type {number} */ id, /** @type {any} */ opts) { starts.push([id, opts]); return { applicationId: id, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    credentials: { read: async () => null, write: async () => {}, delete: async () => false, list: async () => [] },
    outputRoot, version: 'test', startedAt: new Date().toISOString(), healthBanner: [],
    easyApplyTab: {
      connect: fakeConnect(),
      createDriver: (/** @type {any} */ _cdp, /** @type {string} */ _t, /** @type {any} */ profile) => {
        tab.profiles.push(profile ? profile.ats : null);
        return { async attach() {}, async detach() {}, async appliedBadge() { return { state: tab.badge, evidence: tab.badge === 'applied' ? 'Applied 1 minute ago' : null }; } };
      },
    },
  }));
  await app.listen(0, '127.0.0.1');
  port = app.server.address().port;
});
after(async () => {
  await cleanup();
  await c.end();
  await app.close();
  await closePool();
});
beforeEach(async () => {
  await cleanup();
  tab.live = true;
  tab.badge = 'applied';
  tab.calls = [];
  tab.profiles = [];
  starts.length = 0;
});

/** @param {string} method @param {string} p @param {unknown} [body] */
async function req(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

describe('assisted Easy Apply dashboard routes', () => {
  test('status reports the breaker and the in-flight application', async () => {
    await tripBreaker(c, { reason: 'challenge', applicationId: null, hours: 24 });
    const id = await awaiting();
    const r = await req('GET', '/api/easy-apply/status');
    assert.equal(r.body.breaker.tripped, true);
    assert.equal(r.body.breaker.reason, 'challenge');
    assert.deepEqual(r.body.awaiting.map((/** @type {any} */ x) => x.application_id), [id]);
  });
  test('Focus tab activates the stored target id; a non-awaiting application is refused', async () => {
    const id = await awaiting();
    const r = await req('POST', `/api/applications/${id}/focus-tab`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(tab.calls.find((x) => x[0] === 'Target.activateTarget'), ['Target.activateTarget', { targetId: 'TAB-1' }]);
    await c.query(`UPDATE ic_job_applications SET pending_question = '{"kind":"question","label":"q"}' WHERE id = $1`, [id]);
    assert.equal((await req('POST', `/api/applications/${id}/focus-tab`)).status, 409);
  });
  test('Focus tab on a vanished tab demotes the card to abandoned_tab', async () => {
    const id = await awaiting();
    tab.live = false;
    const r = await req('POST', `/api/applications/${id}/focus-tab`);
    assert.equal(r.status, 409);
    assert.equal((await getApplication(c, id)).pending_question.kind, 'abandoned_tab');
  });
  test('"I submitted" with the Applied badge present marks it submitted', async () => {
    const id = await awaiting();
    const r = await req('POST', `/api/applications/${id}/easy-apply/submitted`, {});
    assert.equal(r.body.outcome, 'submitted', JSON.stringify(r.body));
    assert.equal((await getApplication(c, id)).state, 'submitted');
    assert.ok(!tab.calls.some((x) => x[0] === 'Target.closeTarget'));
  });
  test('"I submitted" without the badge stays needs_human and offers confirm-anyway; confirm_anyway submits', async () => {
    const id = await awaiting();
    tab.badge = 'not_applied';
    const r = await req('POST', `/api/applications/${id}/easy-apply/submitted`, {});
    assert.equal(r.body.outcome, 'badge_not_found');
    assert.equal(r.body.confirm_anyway_available, true);
    const row = await getApplication(c, id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'awaiting_submit');
    assert.match(row.pending_question.last_check.message, /Applied/);
    const r2 = await req('POST', `/api/applications/${id}/easy-apply/submitted`, { confirm_anyway: true });
    assert.equal(r2.body.outcome, 'submitted');
    assert.equal((await getApplication(c, id)).state, 'submitted');
  });
  test('Abandon withdraws the application and closes its tab', async () => {
    const id = await awaiting();
    const r = await req('POST', `/api/applications/${id}/easy-apply/abandon`, {});
    assert.equal(r.status, 200);
    assert.equal((await getApplication(c, id)).state, 'withdrawn');
    assert.deepEqual(tab.calls.find((x) => x[0] === 'Target.closeTarget'), ['Target.closeTarget', { targetId: 'TAB-1' }]);
  });
  test('the generic "I applied by hand" refuses an awaiting_submit card', async () => {
    const id = await awaiting();
    const r = await req('POST', `/api/applications/${id}/applied-by-hand`, {});
    assert.equal(r.status, 409);
    assert.equal((await getApplication(c, id)).state, 'needs_human');
  });
  test('Retry on a linkedin_easy application kicks the runner with the longer Easy Apply hard timeout', async () => {
    const id = await seed('failed', null);
    const r = await req('POST', `/api/applications/${id}/retry`, {});
    assert.equal(r.status, 200);
    await new Promise((res) => { setTimeout(res, 100); });
    assert.equal(starts.length, 1);
    assert.ok(starts[0][1] && starts[0][1].hardTimeoutMs >= 15 * 60000, JSON.stringify(starts));
  });
});

describe('assisted Workday on the same dashboard routes (spec v1 clause 10)', () => {
  const wdAwaiting = () => seed('needs_human', { kind: 'awaiting_submit', target_id: 'TAB-1', label: 'x', ats_label: 'Workday', ledger: [], prefilled_unledgered: ['Phone Extension'], awaiting_since: new Date().toISOString() }, 'workday');
  test('"I submitted" reads the WORKDAY profile\'s applied evidence (not LinkedIn\'s badge)', async () => {
    const id = await wdAwaiting();
    const r = await req('POST', `/api/applications/${id}/assisted-apply/submitted`, {});
    assert.equal(r.body.outcome, 'submitted', JSON.stringify(r.body));
    assert.deepEqual(tab.profiles, ['workday']);
  });
  test('without evidence it stays needs_human with a Workday message', async () => {
    const id = await wdAwaiting();
    tab.badge = 'not_applied';
    const r = await req('POST', `/api/applications/${id}/assisted-apply/submitted`, {});
    assert.equal(r.body.outcome, 'badge_not_found');
    assert.match(r.body.message, /Workday/);
    assert.doesNotMatch(r.body.message, /LinkedIn/);
  });
  test('status lists the Workday awaiting card and both breakers', async () => {
    await tripBreaker(c, { reason: 'unexpected_submit', applicationId: null, hours: 24, ats: 'workday' });
    const id = await wdAwaiting();
    const r = await req('GET', '/api/assisted-apply/status');
    assert.ok(r.body.awaiting.some((/** @type {any} */ x) => x.application_id === id && x.ats === 'workday'));
    assert.equal(r.body.breakers.workday.tripped, true);
    assert.equal(r.body.breakers.linkedin_easy.tripped, false);
  });
  test('Retry on a workday application kicks the runner with the longer assisted hard timeout', async () => {
    const id = await seed('failed', null, 'workday');
    const r = await req('POST', `/api/applications/${id}/retry`, {});
    assert.equal(r.status, 200);
    await new Promise((res) => { setTimeout(res, 100); });
    assert.equal(starts.length, 1);
    assert.ok(starts[0][1] && starts[0][1].hardTimeoutMs >= 15 * 60000, JSON.stringify(starts));
  });
});
