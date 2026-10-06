// @ts-check
/**
 * src/apply/worker.js assisted Workday handoff (spec v1 clauses 6-9, 11; v2 A8-A12, A15). Real test DB;
 * a fake Playwright-shaped session (route policy tracked as a flag), a fake prepare (the scripted entry and
 * sign-in are covered by test/workday-adapter.test.js), and a fake runner that writes the lease result the
 * way the assisted_apply tool would. Proves:
 *   - the route policy is ON while the model session runs, the target marker lists the tab BEFORE the
 *     lease is issued, and at awaiting_submit the policy comes off FIRST, then awaiting_submit is written,
 *     then progress is notified; the marker is rewritten without the tab and the tab is never closed;
 *   - a failed unroute parks instead of reporting awaiting_submit, and the tab is closed;
 *   - two tabs after prepare park before any lease (A12);
 *   - a crash between prepare and lease leaves the tab in the marker, no lease, and a retryable 'failed'
 *     row (A8), while a crash after a Next click parks for a human (A10);
 *   - the old unattended Workday submit path is unreachable (A15): the worker never calls adapter.run,
 *     the adapter's run touches nothing, and the adapter source has no submit path left;
 *   - Workday has its own breaker, in-flight slot, and daily budget; a tripped LinkedIn breaker or an
 *     in-flight LinkedIn row does not block it.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, transition, getApplication, recordAssistedNextClick } from '../src/core/applications.js';
import { closeLease, tripBreaker, clearBreakerForTests, parseLeaseToken, updateLeaseState } from '../src/core/easy-apply-state.js';
import { runApplyWorker } from '../src/apply/worker.js';
import { ADAPTERS } from '../src/apply/adapters/index.js';
import { workday } from '../src/apply/adapters/workday.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CO = `ZZ-TEST-WDWORKER-${process.pid}`;
/** @type {pg.Client} */
let c;
/** @type {number[]} */
const listingIds = [];

async function freshClient() {
  const x = new pg.Client(pgConnectionConfig());
  await x.connect();
  return x;
}

/** @param {string} [ats] */
async function seedApproved(ats = 'workday') {
  const n = Math.floor(Math.random() * 1e9);
  const url = ats === 'workday' ? `https://acme.wd5.myworkdayjobs.com/careers/job/Director_${n}` : `https://www.linkedin.com/jobs/view/${n}/`;
  const r = await c.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url)
     VALUES ('WD Worker Test', $1, $6, $2, 'listing', $3, 'wd worker test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-wdworker-${process.pid}:${n}`, `wd worker co ${n}`, `zz-wdworker-hash-${n}`, url, ats === 'workday' ? 'workday' : 'linkedin'],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const app = await createApplication(c, { listingId, atsType: ats, applyUrl: url, actor: 'mcp' });
  await c.query(`UPDATE ic_job_applications SET state = 'approved' WHERE id = $1`, [app.id]);
  return app.id;
}

async function cleanup() {
  await c.query(`DELETE FROM ic_scan_budget WHERE source IN ('workday_assisted')`);
  await clearBreakerForTests(c);
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
 * @param {{ pages?: number, unrouteOk?: boolean, closeAllThrows?: boolean, prepare?: (cap: any, ctx: any) => Promise<any>, onRun?: (input: any, h: any) => Promise<any>, adapter?: any }} [o]
 */
function harness(o = {}) {
  const seq = /** @type {string[]} */ ([]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdworker-'));
  const marker = path.join(dir, 'apply-targets.json');
  const h = {
    seq, marker, routed: false, tracked: /** @type {string[]} */ ([]), ran: 0, prepared: 0, runCalled: 0,
    readMarker: () => JSON.parse(fs.readFileSync(marker, 'utf8')).target_ids,
  };
  const page = { async goto(/** @type {string} */ u) { seq.push(`goto:${u}`); } };
  const session = {
    async reconcileTargets() { seq.push('reconcileTargets'); return { attempted: 0, closed: 0 }; },
    async reconcile() { return 0; },
    async attachPage(/** @type {any} */ opts) { seq.push(`attach:${opts.mode}:${opts.tenantHost}`); h.routed = true; h.tracked = ['WD-TAB']; return page; },
    async writeTargetMarker(/** @type {string} */ f) { seq.push(`marker:${JSON.stringify(h.tracked)}`); fs.writeFileSync(f, JSON.stringify({ target_ids: h.tracked })); },
    openPages() { return o.pages ?? 1; },
    async targetIdOf() { return 'WD-TAB'; },
    async detachLeaveOpen() {
      seq.push('unroute');
      if (o.unrouteOk === false) return { ok: false, failed: 1 };
      const st = await getApplication(c, h.appId);
      seq.push(`state_at_unroute:${st.state}`);
      h.routed = false; h.tracked = [];
      return { ok: true, failed: 0 };
    },
    async closeAll() { seq.push('closeAll'); if (o.closeAllThrows) throw new Error('boom'); h.routed = false; h.tracked = []; },
    policyFor() { return undefined; },
  };
  const adapter = o.adapter ?? {
    ...ADAPTERS.workday,
    async prepare(/** @type {any} */ cap, /** @type {any} */ ctx) {
      h.prepared++;
      seq.push('prepare');
      assert.equal(typeof ctx.recordSubmitRequestSent, 'undefined', 'prepare never gets a submit hook (A15)');
      return o.prepare ? o.prepare(cap, ctx) : { outcome: 'ok' };
    },
    async run() { h.runCalled++; throw new Error('the unattended Workday run must be unreachable'); },
  };
  const runner = {
    async run(/** @type {any} */ input) {
      h.ran++;
      seq.push(`run:routed=${h.routed}:marker=${JSON.stringify(h.readMarker())}`);
      if (o.onRun) return o.onRun(input, h);
      const parsed = /** @type {any} */ (parseLeaseToken(input.leaseToken));
      const lease = (await c.query('SELECT id FROM ic_easy_apply_leases WHERE application_id = $1 ORDER BY id DESC LIMIT 1', [parsed.applicationId])).rows[0];
      await closeLease(c, Number(lease.id), { stopReason: 'finished', finishResult: { ok: true, screenshot_rel_path: null, ledger: [{ question: 'City', value: 'Houston' }], prefilled_unledgered: ['Phone Extension'] } });
      return { timedOut: false, exitCode: 0, spawnError: false, costUsd: 0.1, turns: 5, isError: false };
    },
  };
  /** @type {any} */
  const progress = (/** @type {any} */ f) => { seq.push(`progress:${f.message}`); };
  return {
    h,
    deps: (/** @type {any} */ extra = {}) => ({
      config: loadConfig(), lookup: async () => [{ address: '93.184.216.34', family: 4 }], connectDedicated: freshClient,
      connectSession: async () => session, adapters: { ...ADAPTERS, workday: adapter },
      log: () => {}, progress, preSubmitExclusionRecheck: alwaysEligible, outputRoot: dir, targetMarkerFile: marker,
      credentials: { read: async () => null, write: async () => {}, generatePassword: () => 'x' },
      gmailVerify: async () => ({ ok: true, code: null, link: null }), sleep: async () => {},
      workday: { runner, now: () => new Date() },
      ...extra,
    }),
  };
}

describe('assisted Workday handoff in the worker', () => {
  test('happy path: policy on during the session, marker before lease, unroute before awaiting_submit, then notify', async () => {
    const id = await seedApproved();
    const { h, deps } = harness();
    /** @type {any} */ (h).appId = id;
    const r = await runApplyWorker(id, deps());
    assert.equal(r.status, 'awaiting_submit', JSON.stringify(r));
    const run = h.seq.find((s) => s.startsWith('run:'));
    assert.equal(run, 'run:routed=true:marker=["WD-TAB"]', 'route policy on and the tab in the marker while the model session runs');
    const iMarker = h.seq.indexOf('marker:["WD-TAB"]');
    const iRun = h.seq.findIndex((s) => s.startsWith('run:'));
    const iUnroute = h.seq.indexOf('unroute');
    const iNotify = h.seq.indexOf('progress:awaiting_submit');
    assert.ok(iMarker >= 0 && iMarker < iRun && iRun < iUnroute && iUnroute < iNotify, h.seq.join(' | '));
    assert.ok(h.seq.includes('state_at_unroute:submitting'), 'awaiting_submit is written only after the unroute');
    assert.deepEqual(h.readMarker(), [], 'marker rewritten without the handed-off tab');
    const app = await getApplication(c, id);
    assert.equal(app.state, 'needs_human');
    assert.equal(app.pending_question.kind, 'awaiting_submit');
    assert.equal(app.pending_question.target_id, 'WD-TAB');
    assert.equal(app.pending_question.ats_label, 'Workday');
    assert.deepEqual(app.pending_question.prefilled_unledgered, ['Phone Extension']);
    assert.equal(h.runCalled, 0);
    const lease = (await c.query('SELECT ats, target_id FROM ic_easy_apply_leases WHERE application_id = $1', [id])).rows[0];
    assert.equal(lease.ats, 'workday');
    assert.equal(lease.target_id, 'WD-TAB');
  });

  test('a failed unroute parks instead of reporting awaiting_submit, and closes the tab (A9)', async () => {
    const id = await seedApproved();
    const { h, deps } = harness({ unrouteOk: false });
    /** @type {any} */ (h).appId = id;
    const r = await runApplyWorker(id, deps());
    assert.equal(r.status, 'needs_human');
    const app = await getApplication(c, id);
    assert.equal(app.pending_question.kind, 'assisted_stopped');
    assert.equal(app.pending_question.assisted_reason, 'unroute_failed');
    assert.ok(h.seq.includes('closeAll'));
    assert.ok(!h.seq.includes('progress:awaiting_submit'));
  });

  test('two tabs after prepare park before any lease or model session (A12)', async () => {
    const id = await seedApproved();
    const { h, deps } = harness({ pages: 2 });
    const r = await runApplyWorker(id, deps());
    assert.equal(r.status, 'needs_human');
    assert.equal(h.ran, 0);
    assert.equal((await c.query('SELECT 1 FROM ic_easy_apply_leases WHERE application_id = $1', [id])).rowCount, 0);
    assert.equal((await getApplication(c, id)).pending_question.assisted_reason, 'multiple_tabs');
  });

  test('prepare parks (e.g. a rejected credential): no lease, tab closed, the prepare question kept', async () => {
    const id = await seedApproved();
    const { h, deps } = harness({ prepare: async () => ({ outcome: 'needs_human', pendingQuestion: { kind: 'credential', target: 'ic-jobsearch/acme.wd5.myworkdayjobs.com', username: 'me@example.com', label: 'rejected', page_url: null } }) });
    const r = await runApplyWorker(id, deps());
    assert.equal(r.status, 'needs_human');
    assert.equal((await getApplication(c, id)).pending_question.kind, 'credential');
    assert.equal(h.ran, 0);
    assert.ok(h.seq.includes('closeAll'));
  });

  test('a crash between prepare and lease: tab in the marker, no lease, retryable failed row (A8)', async () => {
    const id = await seedApproved();
    const { h, deps } = harness({ prepare: async () => { throw new Error('browser died'); } });
    const r = await runApplyWorker(id, deps());
    assert.equal(r.status, 'failed');
    assert.ok(h.seq.indexOf('marker:["WD-TAB"]') < h.seq.indexOf('prepare'));
    assert.equal((await c.query('SELECT 1 FROM ic_easy_apply_leases WHERE application_id = $1', [id])).rowCount, 0);
  });

  test('a session that clicked Next and then stopped parks with requires_human_retry; a crash after a Next click parks too (A10)', async () => {
    const id = await seedApproved();
    const { h, deps } = harness({
      onRun: async (input) => {
        const parsed = /** @type {any} */ (parseLeaseToken(input.leaseToken));
        await recordAssistedNextClick(c, parsed.applicationId);
        const lease = (await c.query('SELECT id FROM ic_easy_apply_leases WHERE application_id = $1 ORDER BY id DESC LIMIT 1', [parsed.applicationId])).rows[0];
        await updateLeaseState(c, Number(lease.id), { state: { allVerified: true } });
        await closeLease(c, Number(lease.id), { stopReason: 'uncertain_last_step' });
        return { exitCode: 0 };
      },
    });
    const r = await runApplyWorker(id, deps());
    assert.equal(r.status, 'needs_human', 'uncertain_last_step is never a Workday success (A11)');
    const pq = (await getApplication(c, id)).pending_question;
    assert.equal(pq.requires_human_retry, true);
    assert.ok(h.seq.includes('closeAll'));

    const id2 = await seedApproved();
    const crash = harness({
      closeAllThrows: true,
      onRun: async (input) => { await recordAssistedNextClick(c, /** @type {any} */ (parseLeaseToken(input.leaseToken)).applicationId); return { exitCode: 1 }; },
    });
    const r2 = await runApplyWorker(id2, crash.deps());
    assert.equal(r2.status, 'needs_human');
    assert.equal((await getApplication(c, id2)).pending_question.kind, 'assisted_partial');
  });

  test('resume gate R3: a crash on a later attempt parks when the Next click came on an EARLIER attempt (durable marker)', async () => {
    const id = await seedApproved();
    await recordAssistedNextClick(c, id);
    await new Promise((r) => { setTimeout(r, 5); });
    const crash = harness({ closeAllThrows: true, onRun: async () => ({ exitCode: 1 }) });
    const r = await runApplyWorker(id, crash.deps());
    assert.equal(r.status, 'needs_human');
    const pq = (await getApplication(c, id)).pending_question;
    assert.equal(pq.kind, 'assisted_partial');
  });

  test('A15: the worker never calls adapter.run; the real run touches nothing; no submit path left in workday.js', async () => {
    const id = await seedApproved();
    const { h, deps } = harness();
    /** @type {any} */ (h).appId = id;
    await runApplyWorker(id, deps());
    assert.equal(h.runCalled, 0);
    assert.equal(h.prepared, 1);
    assert.equal(ADAPTERS.workday.assisted, true);
    const touched = /** @type {string[]} */ ([]);
    const cap = new Proxy({}, { get: (_t, k) => () => { touched.push(String(k)); return null; } });
    const res = await workday.run(cap, { applyUrl: 'https://acme.wd5.myworkdayjobs.com/x' });
    assert.equal(res.outcome, 'needs_human');
    assert.deepEqual(touched, []);
    const src = fs.readFileSync(path.join(HERE, '..', 'src', 'apply', 'adapters', 'workday.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    assert.doesNotMatch(src, /recordSubmitRequestSent|SELECTORS\.submit|SELECTORS\.next\b|answerCustomFields|fillProfileFieldsIfPresent/);
  });
});

describe('Workday start gate (own breaker, slot, budget)', () => {
  test('a tripped LinkedIn breaker and an in-flight LinkedIn row do not block Workday', async () => {
    await tripBreaker(c, { reason: 'challenge', applicationId: null, hours: 24 });
    const li = await seedApproved('linkedin_easy');
    await c.query(`UPDATE ic_job_applications SET state = 'submitting' WHERE id = $1`, [li]);
    const id = await seedApproved();
    const { h, deps } = harness();
    /** @type {any} */ (h).appId = id;
    const r = await runApplyWorker(id, deps());
    assert.equal(r.status, 'awaiting_submit', JSON.stringify(r));
    await c.query(`UPDATE ic_job_applications SET state = 'withdrawn' WHERE id = $1`, [li]);
  });

  test('a tripped Workday breaker defers; an occupied Workday slot defers; both leave the row approved', async () => {
    await tripBreaker(c, { reason: 'unexpected_submit', applicationId: null, hours: 24, ats: 'workday' });
    const id = await seedApproved();
    const r = await runApplyWorker(id, harness().deps());
    assert.equal(r.status, 'deferred');
    assert.equal(/** @type {any} */ (r).reason, 'breaker');
    await clearBreakerForTests(c);
    const busy = await seedApproved();
    await c.query(`UPDATE ic_job_applications SET state = 'needs_human', pending_question = '{"kind":"awaiting_submit","target_id":"OLD"}'::jsonb WHERE id = $1`, [busy]);
    const r2 = await runApplyWorker(id, harness().deps());
    assert.equal(r2.status, 'deferred');
    assert.equal(/** @type {any} */ (r2).reason, 'assisted_in_flight');
    assert.equal((await getApplication(c, id)).state, 'approved');
  });
});
