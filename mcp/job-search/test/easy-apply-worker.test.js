// @ts-check
/**
 * src/apply/worker.js assisted LinkedIn Easy Apply branch (spec B4, G2, G5, G9-G12): start gates (breaker,
 * morning window, spacing, in-flight slot, daily cap) leave the application 'approved'; the happy path
 * ends at needs_human kind awaiting_submit with the tab's target id and the tab NOT closed; only the
 * lease's verified finish result moves state (a nonzero model exit with a verified finish still parks
 * awaiting_submit; a clean exit with no finish does not); a parked question becomes a 'question' card;
 * an Applied badge on retry stops before any lease; a challenge trips the breaker. Real test DB; fake CDP,
 * fake driver, fake runner (the runner fake writes the lease result exactly as the easy_apply tool would).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, transition, getApplication, listApplicationEvents } from '../src/core/applications.js';
import { closeLease, updateLeaseState, tripBreaker, breakerStatus, clearBreakerForTests, parseLeaseToken } from '../src/core/easy-apply-state.js';
import { runApplyWorker } from '../src/apply/worker.js';

const CO = `ZZ-TEST-EASYWORKER-${process.pid}`;
/** @type {pg.Client} */
let c;
/** @type {number[]} */
const listingIds = [];

async function freshClient() {
  const x = new pg.Client(pgConnectionConfig());
  await x.connect();
  return x;
}

async function seedApproved() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await c.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url)
     VALUES ('Easy Worker Test', $1, 'linkedin', $2, 'listing', $3, 'easy worker test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-easyworker-${process.pid}:${n}`, `easy worker co ${n}`, `zz-easyworker-hash-${n}`, `https://www.linkedin.com/jobs/view/${n}/`],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const app = await createApplication(c, { listingId, atsType: 'linkedin_easy', applyUrl: `https://www.linkedin.com/jobs/view/${n}/`, actor: 'mcp' });
  await c.query(`UPDATE ic_job_applications SET state = 'approved' WHERE id = $1`, [app.id]);
  return app.id;
}

async function cleanup() {
  await c.query(`DELETE FROM ic_scan_budget WHERE source IN ('linkedin_easy_apply', 'zz-easyworker-linkedin')`);
  await clearBreakerForTests(c);
  await c.query('DELETE FROM ic_easy_apply_leases');
  if (listingIds.length === 0) return;
  await c.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  c = await freshClient();
  await ensureAuxSchema(c);
  await cleanup();
});
after(async () => {
  await cleanup();
  await c.end();
});
beforeEach(cleanup);

async function alwaysEligible(/** @type {any} */ client, /** @type {any} */ app) {
  await transition(client, app.id, 'submitting', { actor: 'apply', note: 'worker started' });
  return { branch: 'eligible', reason: 'test bypass', evidence: {} };
}

/**
 * @param {{ badge?: string, jobStep?: string, opened?: boolean, onRun?: (input: { applicationId: number, leaseToken: string }) => Promise<any> }} o
 */
function harness(o = {}) {
  const calls = /** @type {any[]} */ ([]);
  const cdp = {
    async send(/** @type {string} */ m, /** @type {any} */ p) { calls.push([m, p]); if (m === 'Target.createTarget') return { targetId: 'TAB-1' }; return {}; },
    async listPageTargets() { return [{ targetId: 'TAB-1', type: 'page', url: '', title: '' }]; },
    async attach() { return 'S1'; },
    async detach() {},
    close() { calls.push(['close']); },
  };
  const driver = {
    async attach() {}, async detach() { calls.push(['detach']); },
    async navigate(/** @type {string} */ u) { calls.push(['navigate', u]); return { readyState: 'complete', url: u }; },
    async snapshot() { return { step: { kind: o.jobStep ?? 'no_dialog' }, dialogPresent: false, fields: [], buttons: [], alerts: [], resumeCards: [], progressValues: [], stepKey: 'job' }; },
    async appliedBadge() { return { state: o.badge ?? 'not_applied', evidence: null }; },
    async openDialog() { calls.push(['openDialog']); return { clicked: o.opened !== false, reason: o.opened === false ? 'no_easy_apply_button' : null }; },
    async screenshot() { return Buffer.from('png'); },
  };
  let ran = 0;
  const runner = {
    async run(/** @type {any} */ input) {
      ran++;
      calls.push(['run', input.applicationId]);
      return o.onRun ? o.onRun(input) : { timedOut: false, exitCode: 0, spawnError: false, costUsd: 0.1, turns: 5, isError: false };
    },
  };
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyworker-out-'));
  return {
    calls, ran: () => ran,
    deps: (/** @type {any} */ extra = {}) => ({
      config: loadConfig(), lookup: async () => [{ address: '93.184.216.34', family: 4 }], connectDedicated: freshClient,
      connectSession: async () => { throw new Error('the assisted path must never open a Playwright session'); },
      log: () => {}, progress: () => {}, preSubmitExclusionRecheck: alwaysEligible, outputRoot,
      easyApply: {
        trigger: 'dashboard', now: () => new Date(), connectCdp: async () => cdp, createDriver: () => driver, runner,
        linkedinCaps: { source: 'zz-easyworker-linkedin', dailyPages: 1000, dailyDetails: 1000 }, sleep: async () => {},
        ...(extra.easyApply ?? {}),
      },
      ...extra.top,
    }),
  };
}

/** Simulate the easy_apply tool's verified finish. @param {any} result */
function finishWith(result, extraState = {}) {
  return async (/** @type {any} */ input) => {
    const db = await freshClient();
    try {
      const l = await db.query('SELECT id FROM ic_easy_apply_leases WHERE application_id = $1 ORDER BY id DESC LIMIT 1', [input.applicationId]);
      await updateLeaseState(db, Number(l.rows[0].id), { state: extraState, ledger: [{ question: 'First name', bank_key: 'first_name', value: 'Damian', verified: true }] });
      await closeLease(db, Number(l.rows[0].id), result);
    } finally {
      await db.end();
    }
    return { timedOut: false, exitCode: result.exitCode ?? 0, spawnError: false, costUsd: 0.1, turns: 5, isError: false };
  };
}

describe('assisted Easy Apply: start gates leave the application approved', () => {
  test('tripped breaker', async () => {
    const id = await seedApproved();
    await tripBreaker(c, { reason: 'challenge', applicationId: null, hours: 24 });
    const h = harness();
    const r = await runApplyWorker(id, h.deps());
    assert.deepEqual([r.status, r.reason], ['deferred', 'breaker']);
    assert.equal((await getApplication(c, id)).state, 'approved');
    assert.equal(h.calls.length, 0);
  });
  test('morning trigger outside 09:00-19:00 America/Chicago', async () => {
    const id = await seedApproved();
    const h = harness();
    const r = await runApplyWorker(id, h.deps({ easyApply: { trigger: 'morning', now: () => new Date('2026-10-05T07:00:00-05:00') } }));
    assert.deepEqual([r.status, r.reason], ['deferred', 'outside_window']);
    assert.equal((await getApplication(c, id)).state, 'approved');
  });
  test('another Easy Apply awaiting submit holds the slot (G9)', async () => {
    const other = await seedApproved();
    await c.query(`UPDATE ic_job_applications SET state = 'needs_human', pending_question = '{"kind":"awaiting_submit","target_id":"OTHER"}' WHERE id = $1`, [other]);
    const id = await seedApproved();
    const r = await runApplyWorker(id, harness().deps());
    assert.deepEqual([r.status, r.reason], ['deferred', 'easy_apply_in_flight']);
    assert.equal((await getApplication(c, id)).state, 'approved');
  });
  test('daily cap exhausted (G10)', async () => {
    const id = await seedApproved();
    await c.query(`INSERT INTO ic_scan_budget (source, day, pages, details) VALUES ('linkedin_easy_apply', $1, 5, 0)`, [new Date().toISOString().slice(0, 10)]);
    const r = await runApplyWorker(id, harness().deps());
    assert.deepEqual([r.status, r.reason], ['deferred', 'easy_apply_daily_cap']);
    assert.equal((await getApplication(c, id)).state, 'approved');
  });
});

describe('assisted Easy Apply: outcomes', () => {
  test('verified finish -> needs_human awaiting_submit, target id stored, tab left open, no marker file write', async () => {
    const id = await seedApproved();
    const h = harness({ onRun: finishWith({ stopReason: 'finished', finishResult: { ok: true, screenshot_rel_path: 'applications/1/x.png', ledger: [] }, exitCode: 1 }) });
    const r = await runApplyWorker(id, h.deps());
    assert.equal(r.status, 'awaiting_submit');
    const app = await getApplication(c, id);
    assert.equal(app.state, 'needs_human');
    assert.equal(app.pending_question.kind, 'awaiting_submit');
    assert.equal(app.pending_question.target_id, 'TAB-1');
    assert.ok(!h.calls.some((x) => x[0] === 'Target.closeTarget'), 'the awaiting tab must never be closed');
    assert.ok(h.calls.some((x) => x[0] === 'openDialog'));
    assert.ok(h.calls.some((x) => x[0] === 'navigate' && /linkedin\.com\/jobs\/view\//.test(x[1])));
  });
  test('a clean model exit with no finish never parks awaiting_submit; the tab is closed', async () => {
    const id = await seedApproved();
    const h = harness();
    const r = await runApplyWorker(id, h.deps());
    assert.equal(r.status, 'needs_human');
    const app = await getApplication(c, id);
    assert.equal(app.pending_question.kind, 'easy_apply_stopped');
    assert.ok(h.calls.some((x) => x[0] === 'Target.closeTarget'));
  });
  test('a parked question becomes a question card with the field text', async () => {
    const id = await seedApproved();
    const h = harness({ onRun: finishWith({ stopReason: 'parked', finishResult: { ok: false, park: { question: 'Do you have an active clearance?', reason: 'no_exact_match', bank_key: null } } }) });
    await runApplyWorker(id, h.deps());
    const app = await getApplication(c, id);
    assert.equal(app.pending_question.kind, 'question');
    assert.equal(app.pending_question.label, 'Do you have an active clearance?');
  });
  test('uncertain_last_step with every field verified parks awaiting_submit; without, it does not (G2)', async () => {
    const a = await seedApproved();
    await runApplyWorker(a, harness({ onRun: finishWith({ stopReason: 'uncertain_last_step' }, { allVerified: true }) }).deps());
    assert.equal((await getApplication(c, a)).pending_question.kind, 'awaiting_submit');
    await c.query(`UPDATE ic_job_applications SET state = 'withdrawn' WHERE id = $1`, [a]);
    const b = await seedApproved();
    await runApplyWorker(b, harness({ onRun: finishWith({ stopReason: 'uncertain_last_step' }, { allVerified: false }) }).deps({ easyApply: { now: () => new Date(Date.now() + 10 * 60000) } }));
    assert.equal((await getApplication(c, b)).pending_question.kind, 'easy_apply_stopped');
  });
  test('unexpected submit -> error event, tab left open, distinct card', async () => {
    const id = await seedApproved();
    const h = harness({ onRun: finishWith({ stopReason: 'unexpected_submit' }) });
    await runApplyWorker(id, h.deps());
    const app = await getApplication(c, id);
    assert.equal(app.pending_question.kind, 'easy_apply_unexpected_submit');
    assert.ok((await listApplicationEvents(c, id)).some((e) => e.kind === 'error'));
    assert.ok(!h.calls.some((x) => x[0] === 'Target.closeTarget'));
  });
  test('retry first checks the Applied badge and stops before any lease or runner (G12)', async () => {
    const id = await seedApproved();
    const h = harness({ badge: 'applied' });
    await runApplyWorker(id, h.deps());
    assert.equal(h.ran(), 0);
    assert.equal((await getApplication(c, id)).pending_question.kind, 'applied_badge_present');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM ic_easy_apply_leases WHERE application_id = $1', [id])).rows[0].n, 0);
  });
  test('a challenge page on the job page trips the breaker (G11)', async () => {
    const id = await seedApproved();
    const h = harness({ jobStep: 'challenge' });
    await runApplyWorker(id, h.deps());
    assert.equal(h.ran(), 0);
    assert.equal((await breakerStatus(c)).tripped, true);
    assert.equal((await getApplication(c, id)).pending_question.kind, 'easy_apply_challenge');
  });
  test('the runner receives a lease token for this application', async () => {
    const id = await seedApproved();
    /** @type {any} */
    let token = null;
    await runApplyWorker(id, harness({ onRun: async (input) => { token = input.leaseToken; return { timedOut: false, exitCode: 0, spawnError: false }; } }).deps());
    assert.equal(parseLeaseToken(token)?.applicationId, id);
  });
});
