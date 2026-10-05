// @ts-check
/**
 * Daily-attempt charge ordering for the assisted LinkedIn Easy Apply path. The start gate reserves one
 * attempt (one linkedin_easy_apply page plus one LinkedIn detail) before the worker claims the row; when
 * the claim is then refused (the row was withdrawn or otherwise changed between read and claim, the
 * in-flight unique index refused it, or the pre-submit recheck found it no longer eligible), no attempt
 * ran, so the reservation is refunded and nothing stays charged. A claim that succeeds keeps the charge.
 * Real test DB; fake CDP, driver, and runner (never a real browser or model).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, transition, getApplication } from '../src/core/applications.js';
import { clearBreakerForTests, refundEasyApplyAttempt, reserveEasyApplyAttempt } from '../src/core/easy-apply-state.js';
import { runApplyWorker } from '../src/apply/worker.js';

const CO = `ZZ-TEST-EASYCHARGE-${process.pid}`;
const LI_SOURCE = 'zz-easycharge-linkedin';
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
     VALUES ('Easy Charge Test', $1, 'linkedin', $2, 'listing', $3, 'easy charge test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-easycharge-${process.pid}:${n}`, `easy charge co ${n}`, `zz-easycharge-hash-${n}`, `https://www.linkedin.com/jobs/view/${n}/`],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const app = await createApplication(c, { listingId, atsType: 'linkedin_easy', applyUrl: `https://www.linkedin.com/jobs/view/${n}/`, actor: 'mcp' });
  await c.query(`UPDATE ic_job_applications SET state = 'approved' WHERE id = $1`, [app.id]);
  return app.id;
}

async function cleanup() {
  await c.query('DELETE FROM ic_scan_budget WHERE source IN ($1, $2)', ['linkedin_easy_apply', LI_SOURCE]);
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

/** Today's charged units: [easy apply pages, LinkedIn details]. */
async function charged() {
  const day = new Date().toISOString().slice(0, 10);
  const r = await c.query('SELECT source, pages, details FROM ic_scan_budget WHERE day = $1 AND source IN ($2, $3)', [day, 'linkedin_easy_apply', LI_SOURCE]);
  const by = Object.fromEntries(r.rows.map((x) => [x.source, x]));
  return [Number(by.linkedin_easy_apply?.pages ?? 0), Number(by[LI_SOURCE]?.details ?? 0)];
}

/** @param {(client: any, app: any) => Promise<any>} recheck */
function deps(recheck) {
  const cdp = {
    async send(/** @type {string} */ m) { if (m === 'Target.createTarget') return { targetId: 'TAB-1' }; return {}; },
    async listPageTargets() { return [{ targetId: 'TAB-1', type: 'page', url: '', title: '' }]; },
    async attach() { return 'S1'; },
    async detach() {},
    close() {},
  };
  const driver = {
    async attach() {}, async detach() {},
    async navigate(/** @type {string} */ u) { return { readyState: 'complete', url: u }; },
    async snapshot() { return { step: { kind: 'no_dialog' }, dialogPresent: false, fields: [], buttons: [], alerts: [], resumeCards: [], progressValues: [], stepKey: 'job' }; },
    async appliedBadge() { return { state: 'not_applied', evidence: null }; },
    async openDialog() { return { clicked: false, reason: 'no_easy_apply_button' }; },
    async screenshot() { return Buffer.from('png'); },
  };
  return {
    config: loadConfig(), lookup: async () => [{ address: '93.184.216.34', family: 4 }], connectDedicated: freshClient,
    connectSession: async () => { throw new Error('the assisted path must never open a Playwright session'); },
    log: () => {}, progress: () => {}, preSubmitExclusionRecheck: recheck,
    outputRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'easycharge-out-')),
    easyApply: {
      trigger: 'dashboard', now: () => new Date(), connectCdp: async () => cdp, createDriver: () => driver,
      runner: { async run() { return { timedOut: false, exitCode: 0, spawnError: false, costUsd: 0, turns: 0, isError: false }; } },
      linkedinCaps: { source: LI_SOURCE, dailyPages: 1000, dailyDetails: 1000 }, sleep: async () => {},
    },
  };
}

describe('Easy Apply daily attempt: charged only when the claim succeeds', () => {
  test('row withdrawn between read and claim -> no charge', async () => {
    const id = await seedApproved();
    const recheck = async (/** @type {any} */ client, /** @type {any} */ app) => {
      // Another actor withdraws the application after the worker read it as approved.
      const other = await freshClient();
      try {
        await transition(other, app.id, 'withdrawn', { actor: 'dashboard', note: 'withdrawn mid-run (test)' });
      } finally {
        await other.end();
      }
      // The real claim's approved -> submitting transition is refused for a withdrawn row.
      await transition(client, app.id, 'submitting', { actor: 'apply', note: 'worker started' });
      return { branch: 'eligible', reason: 'unreachable', evidence: {} };
    };
    try {
      await runApplyWorker(id, /** @type {any} */ (deps(recheck)));
    } catch {
      /* a refused claim may surface as a throw or a skip; either way nothing may stay charged */
    }
    assert.equal((await getApplication(c, id)).state, 'withdrawn');
    assert.deepEqual(await charged(), [0, 0]);
  });

  test('pre-submit recheck finds the row no longer eligible -> no charge', async () => {
    const id = await seedApproved();
    const recheck = async (/** @type {any} */ client, /** @type {any} */ app) => {
      await transition(client, app.id, 'submitting', { actor: 'apply', note: 'worker started' });
      await transition(client, app.id, 'needs_human', { actor: 'apply', note: 'test: ineligible', pending_question: { kind: 'apply_exclusion', label: 'x', page_url: null } });
      return { branch: 'already_applied', reason: 'test', evidence: {} };
    };
    const r = await runApplyWorker(id, /** @type {any} */ (deps(recheck)));
    assert.equal(r.status, 'needs_human');
    assert.deepEqual(await charged(), [0, 0]);
  });

  test('the in-flight unique index refuses the claim -> deferred, no charge', async () => {
    const id = await seedApproved();
    const recheck = async () => {
      const e = /** @type {any} */ (new Error('duplicate key value violates unique constraint "easy_apply_inflight_uq"'));
      e.code = '23505';
      throw e;
    };
    const r = await runApplyWorker(id, /** @type {any} */ (deps(recheck)));
    assert.deepEqual([r.status, r.reason], ['deferred', 'easy_apply_in_flight']);
    assert.deepEqual(await charged(), [0, 0]);
  });

  test('a successful claim keeps the charge (the checks above are not vacuous)', async () => {
    const id = await seedApproved();
    const recheck = async (/** @type {any} */ client, /** @type {any} */ app) => {
      await transition(client, app.id, 'submitting', { actor: 'apply', note: 'worker started' });
      return { branch: 'eligible', reason: 'test', evidence: {} };
    };
    await runApplyWorker(id, /** @type {any} */ (deps(recheck)));
    assert.deepEqual(await charged(), [1, 1]);
  });
});

describe('refundEasyApplyAttempt', () => {
  test('undoes exactly one reservation for that day and never goes below zero', async () => {
    const now = new Date();
    const caps = { source: LI_SOURCE, dailyPages: 1000, dailyDetails: 1000 };
    assert.equal((await reserveEasyApplyAttempt(c, { easyApplyDaily: 5, linkedinCaps: caps, now })).ok, true);
    assert.equal((await reserveEasyApplyAttempt(c, { easyApplyDaily: 5, linkedinCaps: caps, now })).ok, true);
    await refundEasyApplyAttempt(c, { linkedinSource: LI_SOURCE, now });
    assert.deepEqual(await charged(), [1, 1]);
    await refundEasyApplyAttempt(c, { linkedinSource: LI_SOURCE, now });
    await refundEasyApplyAttempt(c, { linkedinSource: LI_SOURCE, now });
    assert.deepEqual(await charged(), [0, 0]);
  });
});
