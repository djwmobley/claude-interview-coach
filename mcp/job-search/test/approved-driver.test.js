// @ts-check
/**
 * src/apply/approved-driver.js (unblock-auto-apply Item 1, amendments A1, A4, A5, A6): the pure, total
 * classification of an approved application, the total worker-result map, and runApprovedDriver against
 * the real test database with a stub worker, stub reroute, and stub exclusion/blocker checks. Includes
 * the app-13-shaped integration: a needs_human Easy Apply park rerouted to Greenhouse in the pre-pass is
 * driven by the same run.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  createApplication, getApplication, recordSubmitRequestSent, recordAssistedNextClick, rerouteAts, resumeAutomatic, APPLICATION_LOCK_NAMESPACE,
} from '../src/core/applications.js';
import { classifyApproved, mapWorkerResult, runApprovedDriver, summarizeDriver, DRIVER_BRANCHES } from '../src/apply/approved-driver.js';

/** @type {pg.Client} */
let c;
/** @type {number[]} */
const listingIds = [];
const CO = `ZZ Driver Co ${process.pid}`;

async function freshClient() {
  const x = new pg.Client(pgConnectionConfig());
  await x.connect();
  return x;
}

/** @param {{ ats?: string, state?: string, easyOnly?: boolean|null, resume?: boolean, pq?: any, expired?: boolean }} [o] */
async function seed(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const ats = o.ats ?? 'workday';
  const url = ats === 'linkedin_easy' ? `https://www.linkedin.com/jobs/view/${n}/` : `https://zzdriver.wd5.myworkdayjobs.com/careers/job/Director_${n}`;
  const r = await c.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url, apply_easy_only, expired_at)
     VALUES ('Driver Test', $1, 'linkedin', $2, 'listing', $3, 'driver test', 'country-us', $4, now(), $5, $6, $7) RETURNING id`,
    [CO, `zz-driver-${process.pid}:${n}`, `zz driver co ${n}`, `zz-driver-hash-${n}`, url, o.easyOnly === undefined ? null : o.easyOnly, o.expired ? new Date() : null],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const app = await createApplication(c, { listingId, atsType: ats, applyUrl: url, actor: 'mcp', floors: { texas_or_remote: 1, relocation: 1 } });
  let docId = null;
  if (o.resume !== false) {
    docId = Number((await c.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`, [listingId, `resumes/zz-driver-${n}.docx`])).rows[0].id);
  }
  const state = o.state ?? 'approved';
  await c.query(`UPDATE ic_job_applications SET state = $2, resume_doc_id = $3, pending_question = $4::jsonb WHERE id = $1`,
    [app.id, state, docId, state === 'needs_human' ? JSON.stringify(o.pq ?? { kind: 'question', label: 'x' }) : null]);
  // A real approval event, as approve() would write.
  if (state === 'approved') await c.query(`INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor) VALUES ($1, 'state', 'docs_ready', 'approved', 'auto')`, [app.id]);
  return { id: Number(app.id), listingId, n, url };
}

async function cleanup() {
  // Approved rows other test files may have left behind would be driven by this file's runs; park them out.
  await c.query(`UPDATE ic_job_applications SET state = 'withdrawn' WHERE state = 'approved' AND listing_id NOT IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
  if (listingIds.length === 0) return;
  await c.query('DELETE FROM ic_job_submit_markers WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  c = await freshClient();
  await ensureAuxSchema(c);
});
after(async () => {
  await cleanup();
  await c.end();
});
beforeEach(cleanup);

const ATS_ALLOW = ['greenhouse', 'lever', 'smartrecruiters', 'workday', 'icims', 'dayforce'];
/** @param {any} over */
const facts = (over = {}) => ({
  ats_type: 'workday', apply_easy_only: null, submitMarker: false, partialDraft: { marked: false, allowed: true },
  exclusionBranch: 'eligible', blockers: { blocked: false, blockedReason: null, siblingActive: false }, expired: false, resume_doc_id: 5, ...over,
});

describe('classifyApproved: total, safety rows first (A6)', () => {
  const ctx = { atsAllow: ATS_ALLOW };
  test('one row per branch', () => {
    assert.equal(classifyApproved(facts(), ctx).branch, 'drive');
    assert.equal(classifyApproved(facts({ submitMarker: true }), ctx).reason, 'submit_marker_conflict');
    assert.equal(classifyApproved(facts({ partialDraft: { marked: true, allowed: false } }), ctx).reason, 'partial_draft_human_only');
    assert.equal(classifyApproved(facts({ partialDraft: { marked: true, allowed: true } }), ctx).branch, 'drive');
    assert.equal(classifyApproved(facts({ exclusionBranch: 'blocked_company' }), ctx).reason, 'apply_exclusion');
    assert.equal(classifyApproved(facts({ blockers: { blocked: true, blockedReason: 'closed', siblingActive: false } }), ctx).reason, 'blocked_listing');
    assert.equal(classifyApproved(facts({ blockers: { blocked: false, blockedReason: null, siblingActive: true } }), ctx).reason, 'blocked_sibling_active');
    assert.equal(classifyApproved(facts({ expired: true }), ctx).reason, 'listing_closed');
    assert.equal(classifyApproved(facts({ resume_doc_id: null }), ctx).reason, 'missing_resume');
    assert.equal(classifyApproved(facts({ ats_type: 'linkedin_easy', apply_easy_only: true }), ctx).branch, 'easy_apply_path');
    assert.equal(classifyApproved(facts({ ats_type: 'linkedin_easy', apply_easy_only: null }), ctx).branch, 'easy_apply_path');
    assert.equal(classifyApproved(facts({ ats_type: 'linkedin_easy', apply_easy_only: false }), ctx).branch, 'reroute');
    assert.equal(classifyApproved(facts({ ats_type: 'unknown' }), ctx).reason, 'ats_not_drivable');
    assert.equal(classifyApproved(facts({ ats_type: 'indeed_easy' }), ctx).reason, 'ats_not_drivable');
    assert.equal(classifyApproved(facts({ ats_type: 'workday' }), { atsAllow: ['greenhouse'] }).reason, 'ats_not_drivable');
  });
  test('safety rows come before the Easy Apply and reroute rows', () => {
    assert.equal(classifyApproved(facts({ ats_type: 'linkedin_easy', apply_easy_only: false, submitMarker: true }), ctx).reason, 'submit_marker_conflict');
    assert.equal(classifyApproved(facts({ ats_type: 'linkedin_easy', apply_easy_only: true, expired: true }), ctx).reason, 'listing_closed');
  });
  test('every branch is declared', () => {
    for (const b of ['drive', 'park', 'easy_apply_path', 'reroute']) assert.ok(DRIVER_BRANCHES.includes(b));
  });
});

describe('mapWorkerResult: total', () => {
  test('every worker status maps; anything else is unknown', () => {
    assert.equal(mapWorkerResult({ status: 'submitted' }), 'drove_ok');
    assert.equal(mapWorkerResult({ status: 'applied' }), 'drove_ok');
    assert.equal(mapWorkerResult({ status: 'needs_human' }), 'drove_parked');
    assert.equal(mapWorkerResult({ status: 'awaiting_submit' }), 'drove_parked');
    assert.equal(mapWorkerResult({ status: 'deferred' }), 'drove_deferred');
    assert.equal(mapWorkerResult({ status: 'locked' }), 'drove_locked');
    assert.equal(mapWorkerResult({ status: 'skipped' }), 'drove_state_changed');
    assert.equal(mapWorkerResult({ status: 'failed' }), 'drove_failed');
    assert.equal(mapWorkerResult({ status: 'weird' }), 'worker_result_unknown');
    assert.equal(mapWorkerResult(null), 'worker_result_unknown');
  });
});

/**
 * @param {{ worker?: (id: number) => Promise<any>, exclusion?: (id: number) => any, blockers?: (id: number) => any, reroute?: any, dryRun?: boolean, maxPerRun?: number, onlyId?: number, fresh?: any }} [o]
 */
function driverDeps(o = {}) {
  const h = { driven: /** @type {number[]} */ ([]), logs: /** @type {any[]} */ ([]) };
  const deps = {
    connectDedicated: freshClient,
    freshConfig: () => o.fresh ?? { autoApply: { atsAllow: ATS_ALLOW } },
    exclusionConfig: /** @type {any} */ ({}),
    now: () => new Date(),
    log: (/** @type {any} */ f) => h.logs.push(f),
    dryRun: Boolean(o.dryRun),
    maxPerRun: o.maxPerRun ?? 5,
    onlyId: o.onlyId,
    runWorker: async (/** @type {number} */ id, /** @type {any} */ opts) => {
      h.driven.push(id);
      assert.equal(opts.workday.trigger, 'morning');
      return o.worker ? o.worker(id) : { ok: true, status: 'submitted' };
    },
    classifyExclusion: async (/** @type {any} */ _l, /** @type {any} */ ctx) => (o.exclusion ? o.exclusion(ctx.excludeApplicationId) : { branch: 'eligible' }),
    checkBlockers: async (/** @type {any} */ _c, /** @type {any} */ app) => (o.blockers ? o.blockers(app.id) : { blocked: false, blockedReason: null, siblingActive: false }),
    reroute: o.reroute ?? null,
  };
  return { h, deps };
}

describe('runApprovedDriver (real DB, stub worker)', () => {
  test('drives a clean Workday row, parks a closed listing, leaves an Easy Apply row alone; each row classified once', async () => {
    const drive = await seed();
    const closed = await seed({ expired: true });
    const easy = await seed({ ats: 'linkedin_easy', easyOnly: true });
    const { h, deps } = driverDeps();
    const out = await runApprovedDriver(deps);
    const mine = out.results.filter((r) => [drive.id, closed.id, easy.id].includes(r.applicationId));
    assert.equal(mine.length, 3, JSON.stringify(out.results));
    assert.deepEqual(h.driven, [drive.id]);
    const byId = Object.fromEntries(mine.map((r) => [r.applicationId, r]));
    assert.equal(byId[drive.id].outcome, 'drove_ok');
    assert.deepEqual([byId[closed.id].outcome, byId[closed.id].reason], ['parked', 'listing_closed']);
    assert.equal(byId[easy.id].outcome, 'easy_apply_path');
    const parked = await getApplication(c, closed.id);
    assert.deepEqual([parked.state, parked.pending_question.kind, parked.pending_question.reason], ['needs_human', 'morning_driver_park', 'listing_closed']);
    assert.equal((await getApplication(c, easy.id)).state, 'approved');
    assert.ok(h.logs.some((l) => l.evt === 'approved_driver_done'));
    assert.equal(h.logs.filter((l) => l.evt === 'approved_driver_classified').length, 3);
  });

  test('a deferred worker leaves the row approved and is reported with its reason', async () => {
    const s = await seed();
    const { deps } = driverDeps({ worker: async () => ({ ok: true, status: 'deferred', reason: 'workday_daily_cap' }) });
    const out = await runApprovedDriver(deps);
    const r = out.results.find((x) => x.applicationId === s.id);
    assert.deepEqual([r?.outcome, r?.reason], ['drove_deferred', 'workday_daily_cap']);
    assert.equal(out.counts.drove_deferred, 1);
    assert.deepEqual(out.counts.deferred_reasons, { workday_daily_cap: 1 });
  });

  test('a throwing check parks classify_error; an unknown worker result parks worker_result_unknown', async () => {
    const a = await seed();
    const b = await seed();
    const { deps } = driverDeps({
      exclusion: (id) => { if (id === a.id) throw new Error('boom'); return { branch: 'eligible' }; },
      worker: async () => ({ ok: true, status: 'surprise' }),
    });
    const out = await runApprovedDriver(deps);
    const ra = out.results.find((x) => x.applicationId === a.id);
    const rb = out.results.find((x) => x.applicationId === b.id);
    assert.deepEqual([ra?.outcome, ra?.reason], ['parked', 'classify_error']);
    assert.deepEqual([rb?.outcome, rb?.reason], ['parked', 'worker_result_unknown']);
    assert.equal((await getApplication(c, b.id)).state, 'needs_human');
  });

  test('A1: a row whose per-application lock is held elsewhere is reported locked, never parked or driven', async () => {
    const s = await seed();
    const other = await freshClient();
    try {
      await other.query('SELECT pg_advisory_lock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, s.id]);
      const { h, deps } = driverDeps();
      const out = await runApprovedDriver(deps);
      assert.equal(out.results.find((x) => x.applicationId === s.id)?.outcome, 'drove_locked');
      assert.deepEqual(h.driven, []);
    } finally {
      await other.end();
    }
    assert.equal((await getApplication(c, s.id)).state, 'approved');
  });

  test('A5: a partial-draft row drives only after an acknowledging dashboard approval made after the marker', async () => {
    const s = await seed();
    await recordAssistedNextClick(c, s.id);
    const first = await runApprovedDriver(driverDeps().deps);
    assert.equal(first.results.find((x) => x.applicationId === s.id)?.reason, 'partial_draft_human_only');
    // Human Resume with acknowledgement, after the marker.
    await c.query(`INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor, meta, created_at)
                   VALUES ($1, 'state', 'needs_human', 'approved', 'dashboard', '{"partial_draft":true,"partial_draft_acknowledged":true}', now() + interval '1 second')`, [s.id]);
    await c.query(`UPDATE ic_job_applications SET state = 'approved', pending_question = NULL WHERE id = $1`, [s.id]);
    const { h, deps } = driverDeps();
    await runApprovedDriver(deps);
    assert.deepEqual(h.driven, [s.id]);
  });

  test('A5: a later automated re-approval after the acknowledgement refuses', async () => {
    const s = await seed();
    await recordAssistedNextClick(c, s.id);
    await c.query(`INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor, meta, created_at)
                   VALUES ($1, 'state', 'needs_human', 'approved', 'dashboard', '{"partial_draft_acknowledged":true}', now() + interval '1 second')`, [s.id]);
    await c.query(`INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor, created_at)
                   VALUES ($1, 'state', 'failed', 'approved', 'auto', now() + interval '2 seconds')`, [s.id]);
    const out = await runApprovedDriver(driverDeps().deps);
    assert.equal(out.results.find((x) => x.applicationId === s.id)?.reason, 'partial_draft_human_only');
  });

  test('a submit-marker row parks submit_marker_conflict with the unconfirmed-submit question', async () => {
    const s = await seed();
    await recordSubmitRequestSent(c, s.id);
    const out = await runApprovedDriver(driverDeps().deps);
    assert.equal(out.results.find((x) => x.applicationId === s.id)?.reason, 'submit_marker_conflict');
    const app = await getApplication(c, s.id);
    assert.equal(app.pending_question.kind, 'submit_unconfirmed');
  });

  test('maxPerRun caps drives; the rest stay approved and are reported drive_capped', async () => {
    const a = await seed();
    const b = await seed();
    const { h, deps } = driverDeps({ maxPerRun: 1 });
    const out = await runApprovedDriver(deps);
    assert.equal(h.driven.length, 1);
    assert.equal(out.results.filter((x) => [a.id, b.id].includes(x.applicationId) && x.outcome === 'drive_capped').length, 1);
  });

  test('dry run classifies only: nothing driven, nothing parked', async () => {
    const a = await seed();
    const closed = await seed({ expired: true });
    const { h, deps } = driverDeps({ dryRun: true });
    const out = await runApprovedDriver(deps);
    assert.deepEqual(h.driven, []);
    assert.equal(out.results.find((x) => x.applicationId === a.id)?.outcome, 'would_drive');
    assert.equal(out.results.find((x) => x.applicationId === closed.id)?.outcome, 'would_park');
    assert.equal((await getApplication(c, closed.id)).state, 'approved');
  });

  test('onlyId drives just that application', async () => {
    const a = await seed();
    await seed();
    const { h, deps } = driverDeps({ onlyId: a.id });
    const out = await runApprovedDriver(deps);
    assert.deepEqual(h.driven, [a.id]);
    assert.equal(out.results.length, 1);
  });

  test('integration (app 13 shape): the reroute pre-pass moves a needs_human Easy Apply park to Greenhouse; the same run drives it', async () => {
    const s = await seed({ ats: 'linkedin_easy', state: 'needs_human', easyOnly: false, pq: { kind: 'easy_apply_unverified', branch: 'external', label: 'x' } });
    const gh = `https://boards.greenhouse.io/zzdriver/jobs/${s.n}`;
    /** @type {any[]} */
    const prepass = [];
    const reroute = {
      run: async (/** @type {number} */ id, /** @type {string} */ readState) => {
        prepass.push([id, readState]);
        await rerouteAts(c, id, { atsType: 'greenhouse', applyUrl: gh, actor: 'auto', listingTarget: { applyUrl: gh, applyAts: 'greenhouse' } });
        await resumeAutomatic(c, id, { actor: 'auto', note: 'rerouted' });
        return { applicationId: id, readState, outcome: 'rerouted', reason: null, ats: 'greenhouse' };
      },
    };
    const { h, deps } = driverDeps({ reroute });
    const out = await runApprovedDriver(deps);
    assert.deepEqual(prepass, [[s.id, 'needs_human']]);
    assert.deepEqual(h.driven, [s.id]);
    const app = await getApplication(c, s.id);
    assert.equal(app.ats_type, 'greenhouse');
    assert.equal(out.reroute?.rerouted, 1);
    assert.equal(out.results.filter((x) => x.applicationId === s.id).length, 1, 'classified exactly once (A4)');
  });

  test('an approved linkedin_easy row is untouched when it is still Easy Apply', async () => {
    const s = await seed({ ats: 'linkedin_easy', easyOnly: true });
    const { h, deps } = driverDeps({ worker: async () => ({ ok: true, status: 'submitted' }) });
    await runApprovedDriver(deps);
    assert.deepEqual(h.driven, []);
    assert.equal((await getApplication(c, s.id)).state, 'approved');
  });
});

describe('summarizeDriver', () => {
  test('every result lands in exactly one bucket', () => {
    const s = summarizeDriver([
      { outcome: 'drove_ok' }, { outcome: 'drove_parked' }, { outcome: 'drove_deferred', reason: 'breaker' }, { outcome: 'parked', reason: 'listing_closed' },
      { outcome: 'reroute' }, { outcome: 'easy_apply_path' }, { outcome: 'drove_locked' },
    ]);
    assert.deepEqual([s.approved, s.drove, s.drove_ok, s.drove_parked, s.drove_deferred, s.parked, s.reroute, s.easy_apply_path, s.other], [7, 3, 1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(s.other_outcomes, { drove_locked: 1 });
  });
});
