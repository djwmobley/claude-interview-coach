// @ts-check
/**
 * Withdraw from the dashboard (POST /api/applications/:id/withdraw, src/core/applications.js
 * classifyWithdraw()/withdrawApplication()). Covers the total classification (every state in
 * APPLICATION_STATES plus an unknown one maps to exactly one branch), the refusals (submitting, an open
 * Easy Apply lease, an awaiting_submit card, an in-flight apply run), terminal states (confirmed refused,
 * withdrawn idempotent with no second event), and the state event recorded with actor dashboard and the
 * note. Real test DB, fake runners; never a real application row.
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
import {
  createApplication, getApplication, listApplicationEvents, classifyWithdraw, withdrawApplication,
  APPLICATION_STATES, TRANSITIONS, WITHDRAW_REFUSAL_REASONS, markAppliedByHand, APPLY_NUDGE_PREFIX,
} from '../src/core/applications.js';
import { issueLease, closeLease } from '../src/core/easy-apply-state.js';

const CO = `ZZ-TEST-WITHDRAW-${process.pid}`;
/** @type {pg.Client} */
let c;
/** @type {any} */
let app;
/** @type {number} */
let port;
/** @type {number[]} */
const listingIds = [];
/** @type {{ running: boolean, applicationId: number|null }} */
const runner = { running: false, applicationId: null };

/** @param {string} state @param {any} [pq] @param {string} [ats] */
async function seed(state, pq = null, ats = 'greenhouse') {
  const n = Math.floor(Math.random() * 1e9);
  const r = await c.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Withdraw Test', $1, 'linkedin', $2, 'listing', $3, 'withdraw test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-withdraw-${process.pid}:${n}`, `withdraw co ${n}`, `zz-withdraw-hash-${n}`],
  );
  listingIds.push(Number(r.rows[0].id));
  const a = await createApplication(c, { listingId: Number(r.rows[0].id), atsType: ats, applyUrl: `https://example.test/${n}`, actor: 'mcp' });
  await c.query('UPDATE ic_job_applications SET state = $2, pending_question = $3::jsonb WHERE id = $1', [a.id, state, pq ? JSON.stringify(pq) : null]);
  return Number(a.id);
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await c.query('DELETE FROM ic_easy_apply_leases WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
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
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'withdraw-out-'));
  app = createDashboardServer(/** @type {any} */ ({
    withClient, config: loadConfig(),
    env: { OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', GOOGLE_TOKEN_FILE: '', REMINDER_TO: '', SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null, JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null },
    calendar: async () => null, calendarCache: createCalendarCache(),
    scanRunner: { async start() { return { runId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    applyRunner: {
      async start(/** @type {number} */ id) { return { applicationId: id, pid: 1 }; },
      status() { return { running: runner.running, applicationId: runner.applicationId, pid: null, startedAt: null }; },
      armCancelBackstop() { return { forced_kill_available: false }; },
    },
    credentials: { read: async () => null, write: async () => {}, delete: async () => false, list: async () => [] },
    outputRoot, version: 'test', startedAt: new Date().toISOString(), healthBanner: [],
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
  runner.running = false;
  runner.applicationId = null;
});

/** @param {number} id @param {unknown} [body] */
async function postWithdraw(id, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/applications/${id}/withdraw`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? '{}' : JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

describe('classifyWithdraw(): total classification', () => {
  test('every application state plus an unknown one maps to exactly one branch', () => {
    /** @type {Record<string, string>} */
    const expected = {
      drafting: 'withdraw', docs_ready: 'withdraw', approved: 'withdraw', submitting: 'refuse', submitted: 'withdraw',
      confirmed: 'refuse', failed: 'withdraw', needs_human: 'withdraw', withdrawn: 'noop',
    };
    assert.deepEqual(Object.keys(expected).sort(), [...APPLICATION_STATES].sort());
    for (const s of APPLICATION_STATES) {
      const out = classifyWithdraw({ state: s, pending_question: s === 'needs_human' ? { kind: 'question', label: 'q' } : null });
      assert.equal(out.action, expected[s], s);
      if (out.action === 'withdraw') assert.ok(TRANSITIONS[s].includes('withdrawn'), `TRANSITIONS must allow ${s} -> withdrawn`);
      if (out.action === 'refuse') assert.ok(WITHDRAW_REFUSAL_REASONS.includes(/** @type {any} */ (out).reason), s);
    }
    const unknown = /** @type {any} */ (classifyWithdraw({ state: 'archived', pending_question: null }));
    assert.equal(unknown.action, 'refuse');
    assert.equal(unknown.reason, 'unknown_state');
    const missing = /** @type {any} */ (classifyWithdraw(/** @type {any} */ ({})));
    assert.equal(missing.reason, 'unknown_state');
  });
  test('specific refusal reasons', () => {
    assert.equal(/** @type {any} */ (classifyWithdraw({ state: 'submitting', pending_question: null })).reason, 'submission_in_flight');
    assert.equal(/** @type {any} */ (classifyWithdraw({ state: 'confirmed', pending_question: null })).reason, 'terminal');
    assert.equal(/** @type {any} */ (classifyWithdraw({ state: 'needs_human', pending_question: { kind: 'awaiting_submit' } })).reason, 'awaiting_submit');
    assert.equal(/** @type {any} */ (classifyWithdraw({ state: 'failed', pending_question: null }, { leaseHeld: true })).reason, 'lease_held');
    assert.equal(/** @type {any} */ (classifyWithdraw({ state: 'failed', pending_question: null }, { applyRunning: true })).reason, 'apply_running');
    assert.equal(/** @type {any} */ (classifyWithdraw({ state: 'drafting', pending_question: null }, { chainRunning: true })).reason, 'chain_running');
    // An already-withdrawn row stays an idempotent noop even when a lease is reported.
    assert.equal(classifyWithdraw({ state: 'withdrawn', pending_question: null }, { leaseHeld: true }).action, 'noop');
  });
});

describe('POST /api/applications/:id/withdraw', () => {
  for (const [state, pq] of /** @type {[string, any][]} */ ([
    ['drafting', null], ['docs_ready', null], ['approved', null], ['submitted', null], ['failed', null],
    ['needs_human', { kind: 'question', label: 'Years of experience?' }],
    ['needs_human', { kind: 'unrecognized_page', label: 'Posting is gone' }],
  ])) {
    test(`withdraws from ${state}${pq ? ` (${pq.kind})` : ''} and records a state event with the note`, async () => {
      const id = await seed(state, pq);
      const r = await postWithdraw(id, { note: 'posting gone, tenant 404' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.outcome, 'withdrawn');
      const row = await getApplication(c, id);
      assert.equal(row.state, 'withdrawn');
      assert.equal(row.pending_question, null);
      const ev = (await listApplicationEvents(c, id)).filter((e) => e.kind === 'state' && e.to_state === 'withdrawn');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].from_state, state);
      assert.equal(ev[0].actor, 'dashboard');
      assert.match(ev[0].note, /posting gone, tenant 404/);
    });
  }

  test('withdrawing a submitted application cancels its open 5-day nudge; other follow-ups are untouched', async () => {
    const id = await seed('needs_human', { kind: 'question', label: 'q' });
    await markAppliedByHand(c, id, { actor: 'dashboard' });
    const nudge = await c.query('SELECT id, status, listing_id FROM ic_followups WHERE created_from = $1', [`${APPLY_NUDGE_PREFIX}${id}`]);
    assert.equal(nudge.rowCount, 1);
    assert.equal(nudge.rows[0].status, 'open');
    const other = await c.query(
      `INSERT INTO ic_followups (contact, listing_id, due_at, channel, action, status) VALUES ('x', $1, now() + interval '3 days', 'other', 'unrelated', 'open') RETURNING id`,
      [nudge.rows[0].listing_id],
    );
    const r = await postWithdraw(id, { note: 'withdrew with the employer' });
    assert.equal(r.status, 200);
    assert.equal((await c.query('SELECT status FROM ic_followups WHERE id = $1', [nudge.rows[0].id])).rows[0].status, 'cancelled');
    assert.equal((await c.query('SELECT status FROM ic_followups WHERE id = $1', [other.rows[0].id])).rows[0].status, 'open');
  });

  test('a snoozed nudge is cancelled; a done nudge stays done', async () => {
    const id = await seed('needs_human', { kind: 'question', label: 'q' });
    await markAppliedByHand(c, id, { actor: 'dashboard' });
    await c.query(`UPDATE ic_followups SET status = 'snoozed', snoozed_until = now() + interval '1 day' WHERE created_from = $1`, [`${APPLY_NUDGE_PREFIX}${id}`]);
    assert.equal((await postWithdraw(id)).status, 200);
    assert.equal((await c.query('SELECT status FROM ic_followups WHERE created_from = $1', [`${APPLY_NUDGE_PREFIX}${id}`])).rows[0].status, 'cancelled');

    const id2 = await seed('needs_human', { kind: 'question', label: 'q' });
    await markAppliedByHand(c, id2, { actor: 'dashboard' });
    await c.query(`UPDATE ic_followups SET status = 'done' WHERE created_from = $1`, [`${APPLY_NUDGE_PREFIX}${id2}`]);
    assert.equal((await postWithdraw(id2)).status, 200);
    assert.equal((await c.query('SELECT status FROM ic_followups WHERE created_from = $1', [`${APPLY_NUDGE_PREFIX}${id2}`])).rows[0].status, 'done');
  });

  test('no note falls back to a default note', async () => {
    const id = await seed('failed');
    const r = await postWithdraw(id, {});
    assert.equal(r.status, 200);
    const ev = (await listApplicationEvents(c, id)).find((e) => e.to_state === 'withdrawn');
    assert.equal(ev.note, 'withdrawn from the dashboard');
  });

  test('refuses while submitting with a 409 and leaves the row alone', async () => {
    const id = await seed('submitting');
    const r = await postWithdraw(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'WITHDRAW_REFUSED');
    assert.equal(r.body.reason, 'submission_in_flight');
    assert.equal((await getApplication(c, id)).state, 'submitting');
  });

  test('refuses while an open Easy Apply lease exists, even if the row reads failed', async () => {
    const id = await seed('failed', null, 'linkedin_easy');
    const lease = await issueLease(c, { applicationId: id, trigger: 'dashboard', targetId: 'TAB-1', ttlMs: 10 * 60000, now: new Date() });
    const r = await postWithdraw(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'lease_held');
    assert.equal((await getApplication(c, id)).state, 'failed');
    await closeLease(c, lease.leaseId, { stopReason: 'test' });
    assert.equal((await postWithdraw(id)).status, 200);
  });

  test('an expired, unclosed lease does not block', async () => {
    const id = await seed('failed', null, 'linkedin_easy');
    await issueLease(c, { applicationId: id, trigger: 'dashboard', targetId: 'TAB-1', ttlMs: 1000, now: new Date(Date.now() - 60 * 60000) });
    assert.equal((await postWithdraw(id)).status, 200);
  });

  test('refuses while the apply runner is running this application', async () => {
    const id = await seed('approved');
    runner.running = true;
    runner.applicationId = id;
    const r = await postWithdraw(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'apply_running');
    runner.applicationId = id + 100000;
    assert.equal((await postWithdraw(id)).status, 200);
  });

  test('refuses an awaiting_submit Easy Apply card and points at Abandon', async () => {
    const id = await seed('needs_human', { kind: 'awaiting_submit', target_id: 'TAB-1', label: 'x' }, 'linkedin_easy');
    const r = await postWithdraw(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'awaiting_submit');
    assert.match(r.body.message, /Abandon/);
  });

  test('confirmed is terminal and refused', async () => {
    const id = await seed('confirmed');
    const r = await postWithdraw(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'terminal');
    assert.equal((await getApplication(c, id)).state, 'confirmed');
  });

  test('already withdrawn is idempotent: 200, no second state event', async () => {
    const id = await seed('failed');
    assert.equal((await postWithdraw(id)).status, 200);
    const before = (await listApplicationEvents(c, id)).length;
    const r = await postWithdraw(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, 'already_withdrawn');
    assert.equal((await listApplicationEvents(c, id)).length, before);
  });

  test('an unknown state stored in the row is refused (core function, CHECK constraint bypassed by stub)', async () => {
    const fake = /** @type {any} */ ({
      async query(/** @type {string} */ sql) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(sql)) return { rowCount: 0, rows: [] };
        if (/FROM ic_easy_apply_leases/.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ id: 1, state: 'archived', pending_question: null }] };
      },
    });
    const out = await withdrawApplication(fake, 1, { actor: 'dashboard' });
    assert.equal(out.outcome, 'refused');
    assert.equal(/** @type {any} */ (out).reason, 'unknown_state');
  });

  test('a missing application is 404; a bad note is 400', async () => {
    assert.equal((await postWithdraw(2147480000)).status, 404);
    const id = await seed('failed');
    assert.equal((await postWithdraw(id, { note: 42 })).status, 400);
    assert.equal((await getApplication(c, id)).state, 'failed');
  });
});
