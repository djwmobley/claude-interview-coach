// @ts-check
/**
 * Unblock-auto-apply Item 2 (reroute) with amendments A1, A3, A8, A11: src/core/applications.js's
 * rerouteAts (row lock, state guard, marker refusals, ats_type vocabulary, listing target written in the
 * same transaction) and src/apply/reroute.js's rerouteApplication (the total probe-result table). Real test
 * database for every application/listing write; the LinkedIn page, the browser, the budget, and the
 * breaker are stubs, so no page is loaded and no real budget is spent.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  createApplication, getApplication, rerouteAts, recordSubmitRequestSent, recordAssistedNextClick, APPLICATION_LOCK_NAMESPACE,
} from '../src/core/applications.js';
import { rerouteApplication, companyMatchesTarget, summarizeReroute, REROUTE_OUTCOMES } from '../src/apply/reroute.js';

const CO = `ZZ Reroute Robotics ${process.pid}`;
const CO_NORM = `zz reroute robotics ${process.pid}`;
const TENANT = `zzrerouterobotics${process.pid}`;
const GH_URL = (/** @type {number} */ n) => `https://boards.greenhouse.io/${TENANT}/jobs/${n}`;
/** @type {pg.Client} */
let c;
/** @type {number[]} */
const listingIds = [];

async function freshClient() {
  const x = new pg.Client(pgConnectionConfig());
  await x.connect();
  return x;
}

/**
 * @param {{ state?: 'approved'|'needs_human'|'docs_ready', pq?: any, company?: string, companyNorm?: string, listing?: Record<string, any> }} [o]
 */
async function seed(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const url = `https://www.linkedin.com/jobs/view/${n}/`;
  const r = await c.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url, url_normalized, apply_easy_only)
     VALUES ('Reroute Test CTO', $1, 'linkedin', $2, 'listing', $3, 'reroute test cto', 'country-us', $4, now(), $5, $5, false) RETURNING id`,
    [o.company ?? CO, `zz-reroute-${process.pid}:${n}`, o.companyNorm ?? CO_NORM, `zz-reroute-hash-${n}`, url],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  if (o.listing) {
    const keys = Object.keys(o.listing);
    await c.query(`UPDATE ic_job_listings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [listingId, ...keys.map((k) => o.listing?.[k])]);
  }
  const app = await createApplication(c, { listingId, atsType: 'linkedin_easy', applyUrl: url, actor: 'mcp', floors: { texas_or_remote: 1, relocation: 1 } });
  const state = o.state ?? 'approved';
  await c.query(`UPDATE ic_job_applications SET state = $2, pending_question = $3::jsonb WHERE id = $1`, [app.id, state, state === 'needs_human' ? JSON.stringify(o.pq ?? { kind: 'easy_apply_unverified', branch: 'external', label: 'x' }) : null]);
  return { id: Number(app.id), listingId, n };
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await c.query('DELETE FROM ic_job_submit_markers WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
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

/** @param {number} id */
const events = async (id) => (await c.query('SELECT kind, note, meta, to_state, actor FROM ic_job_application_events WHERE application_id = $1 ORDER BY id', [id])).rows;
/** @param {number} id */
const listingRow = async (id) => (await c.query('SELECT apply_url, apply_ats, apply_ats_confidence, apply_easy_only, probe_attempts FROM ic_job_listings WHERE id = $1', [id])).rows[0];

const FRESH = {
  autoApply: {
    atsAllow: ['greenhouse', 'lever', 'smartrecruiters', 'workday', 'icims', 'dayforce'],
    unattendedSubmit: { enabled: true, ats: { greenhouse: true, lever: true, smartrecruiters: true, icims: true, dayforce: true, workday: true }, dailySubmitCap: 5 },
  },
};
const CONFIG = {
  autoApply: { reprobeAfterHours: 48 },
  adapters: { adapters: { linkedin: { dailyPages: 40, dailyDetails: 200, maxDetailsPerRun: 60 } } },
};

/**
 * Harness: a stub prepare that writes whatever listing target the test wants (exactly what the real
 * prepareLinkedInListing persists) and returns the given branch.
 * @param {{ branch?: string, outcome?: string, target?: { url: string, ats: string, confidence: string }|null, clicked?: boolean, browser?: boolean,
 *   budgetOk?: boolean, breaker?: boolean, fresh?: any, exclusion?: (l: any) => { branch: string, reason?: string }, scanRanToday?: boolean, budget?: { used: number, max: number } }} [o]
 */
function harness(o = {}) {
  const h = { reserves: /** @type {any[]} */ ([]), refunds: /** @type {any[]} */ ([]), opened: 0, closed: 0, prepared: 0, logs: /** @type {any[]} */ ([]) };
  const deps = {
    connectDedicated: freshClient,
    config: CONFIG,
    freshConfig: () => o.fresh ?? FRESH,
    exclusionConfig: /** @type {any} */ ({}),
    now: () => new Date('2026-10-07T15:00:00Z'),
    log: (/** @type {any} */ f) => h.logs.push(f),
    runBudget: o.budget ?? { used: 0, max: 5 },
    scanRanToday: o.scanRanToday ?? true,
    openBrowser: async () => {
      if (o.browser === false) return null;
      h.opened++;
      return { cap: {}, probeSession: {}, close: async () => { h.closed++; } };
    },
    prepareLinkedIn: async (/** @type {any} */ client, /** @type {any} */ listing) => {
      h.prepared++;
      const branch = o.branch ?? 'external';
      if (o.target) {
        await client.query(
          `UPDATE ic_job_listings SET apply_url = $2, apply_ats = $3, apply_ats_confidence = $4, apply_easy_only = false, apply_probed_at = now(), probe_attempts = probe_attempts + 1 WHERE id = $1`,
          [listing.id, o.target.url, o.target.ats, o.target.confidence],
        );
      } else if (branch === 'easy_apply') {
        await client.query(`UPDATE ic_job_listings SET apply_easy_only = true, apply_ats = 'linkedin_easy', apply_ats_confidence = 'inferred', probe_attempts = probe_attempts + 1 WHERE id = $1`, [listing.id]);
      }
      return { outcome: o.outcome ?? (o.target ? 'resolved' : 'unresolved'), branch, clicked: Boolean(o.clicked) };
    },
    reserveBudget: async (/** @type {any} */ _c, /** @type {string} */ source, /** @type {any} */ want, /** @type {any} */ caps) => { h.reserves.push({ source, want, caps }); return { ok: o.budgetOk !== false }; },
    refundBudget: async (/** @type {any} */ _c, /** @type {string} */ source, /** @type {any} */ give) => { h.refunds.push({ source, give }); },
    breakerStatus: async () => ({ tripped: Boolean(o.breaker) }),
    classifyExclusion: async (/** @type {any} */ l) => (o.exclusion ? o.exclusion(l) : { branch: 'eligible', reason: 'ok' }),
  };
  return { h, deps };
}

describe('rerouteAts (src/core/applications.js)', () => {
  test('approved: moves the application to the new ATS, writes the listing target in the same transaction, one note event', async () => {
    const s = await seed();
    await rerouteAts(c, s.id, { atsType: 'greenhouse', applyUrl: GH_URL(1), actor: 'auto', note: 'test reroute', listingTarget: { applyUrl: GH_URL(1), applyAts: 'greenhouse' } });
    const app = await getApplication(c, s.id);
    assert.equal(app.ats_type, 'greenhouse');
    assert.equal(app.apply_url, GH_URL(1));
    assert.equal(app.state, 'approved');
    const l = await listingRow(s.listingId);
    assert.deepEqual([l.apply_url, l.apply_ats, l.apply_ats_confidence, l.apply_easy_only], [GH_URL(1), 'greenhouse', 'exact', false]);
    const notes = (await events(s.id)).filter((e) => e.kind === 'note');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].meta.from_ats, 'linkedin_easy');
    assert.equal(notes[0].meta.to_ats, 'greenhouse');
  });
  test('needs_human is allowed too; any other state is refused', async () => {
    const nh = await seed({ state: 'needs_human' });
    await rerouteAts(c, nh.id, { atsType: 'lever', applyUrl: 'https://jobs.lever.co/x/1', actor: 'auto' });
    assert.equal((await getApplication(c, nh.id)).ats_type, 'lever');
    const dr = await seed({ state: 'docs_ready' });
    await assert.rejects(rerouteAts(c, dr.id, { atsType: 'greenhouse', applyUrl: GH_URL(2), actor: 'auto' }), (/** @type {any} */ e) => e.details?.reason === 'state_not_reroutable');
    assert.equal((await getApplication(c, dr.id)).ats_type, 'linkedin_easy');
  });
  test('refused when the submit marker or the A10 marker is set', async () => {
    const a = await seed();
    await recordSubmitRequestSent(c, a.id);
    await assert.rejects(rerouteAts(c, a.id, { atsType: 'greenhouse', applyUrl: GH_URL(3), actor: 'auto' }), (/** @type {any} */ e) => e.details?.reason === 'submit_request_sent');
    const b = await seed();
    await recordAssistedNextClick(c, b.id);
    await assert.rejects(rerouteAts(c, b.id, { atsType: 'greenhouse', applyUrl: GH_URL(4), actor: 'auto' }), (/** @type {any} */ e) => e.details?.reason === 'requires_human_retry');
    assert.equal((await getApplication(c, b.id)).ats_type, 'linkedin_easy');
  });
  test('an ats_type outside the vocabulary is refused before any write, and the column CHECK backs it', async () => {
    const s = await seed();
    await assert.rejects(rerouteAts(c, s.id, { atsType: 'bogus', applyUrl: GH_URL(5), actor: 'auto' }), /ats_type must be one of/);
    await assert.rejects(c.query(`UPDATE ic_job_applications SET ats_type = 'bogus' WHERE id = $1`, [s.id]), /check/i);
  });
  test('expectedFromState: a row that moved on is refused (A1)', async () => {
    const s = await seed({ state: 'needs_human' });
    await assert.rejects(rerouteAts(c, s.id, { atsType: 'greenhouse', applyUrl: GH_URL(6), actor: 'auto', expectedFromState: 'approved' }), (/** @type {any} */ e) => e.details?.reason === 'state_changed');
  });
});

describe('companyMatchesTarget (A3)', () => {
  test('a tenant naming the listing company matches; a different tenant, an unknown tenant, or a confidential listing does not', () => {
    assert.equal(companyMatchesTarget({ company: 'Acme Robotics, Inc.', companyNorm: 'acme robotics' }, 'https://boards.greenhouse.io/acmerobotics/jobs/1').ok, true);
    assert.equal(companyMatchesTarget({ company: 'Acme', companyNorm: 'acme' }, 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/X_1').ok, true);
    assert.equal(companyMatchesTarget({ company: 'Acme Robotics', companyNorm: 'acme robotics' }, 'https://careers-acmerobotics.icims.com/jobs/123/cto/job').ok, true);
    assert.equal(companyMatchesTarget({ company: 'Acme Robotics', companyNorm: 'acme robotics' }, 'https://boards.greenhouse.io/othercorp/jobs/1').ok, false);
    assert.equal(companyMatchesTarget({ company: 'Acme Robotics', companyNorm: 'acme robotics' }, 'https://example.com/apply').ok, false);
    assert.equal(companyMatchesTarget({ company: 'Confidential', companyNorm: 'confidential:execboard' }, 'https://boards.greenhouse.io/confidential/jobs/1').reason, 'confidential_listing');
    assert.equal(companyMatchesTarget({ company: '', companyNorm: '' }, 'https://boards.greenhouse.io/x/jobs/1').ok, false);
  });
});

describe('rerouteApplication: the total probe-result table (Item 2)', () => {
  test('every outcome is a declared one', () => {
    for (const o of ['rerouted', 'parked', 'noted', 'easy_apply', 'deferred', 'halted', 'state_changed', 'locked', 'skipped']) assert.ok(REROUTE_OUTCOMES.includes(o), o);
  });

  test('external + exact Greenhouse + unattended on: an approved row becomes Greenhouse and stays approved; 2 details reserved, 1 refunded (no click)', async () => {
    const s = await seed();
    const { h, deps } = harness({ target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' } });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.equal(r.outcome, 'rerouted', JSON.stringify(r));
    assert.equal(r.ats, 'greenhouse');
    const app = await getApplication(c, s.id);
    assert.deepEqual([app.state, app.ats_type, app.apply_url], ['approved', 'greenhouse', GH_URL(s.n)]);
    assert.deepEqual(h.reserves.map((x) => x.want), [{ details: 2 }], 'one reservation covering the page and a possible click-probe load (A8)');
    assert.deepEqual(h.refunds.map((x) => x.give), [{ details: 1 }], 'the unused click-probe load is refunded');
    assert.equal(h.opened, 1);
    assert.equal(h.closed, 1);
    assert.equal(deps.runBudget.used, 1);
  });

  test('a click-probe load keeps both reserved details', async () => {
    const s = await seed();
    const { h, deps } = harness({ target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' }, clicked: true });
    await rerouteApplication(s.id, 'approved', deps);
    assert.equal(h.refunds.length, 0);
  });

  test('before today\'s scan finished, the reservation keeps the scan\'s per-run share untouched (A8)', async () => {
    const s = await seed();
    const { h, deps } = harness({ target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' }, scanRanToday: false });
    await rerouteApplication(s.id, 'approved', deps);
    assert.equal(h.reserves[0].caps.dailyDetails, 140);
  });

  test('app 13 shape: a needs_human easy_apply_unverified external row is rerouted and resumed to approved', async () => {
    const s = await seed({ state: 'needs_human', pq: { kind: 'easy_apply_unverified', branch: 'external', label: 'x' } });
    const { deps } = harness({ target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' } });
    const r = await rerouteApplication(s.id, 'needs_human', deps);
    assert.equal(r.outcome, 'rerouted', JSON.stringify(r));
    const app = await getApplication(c, s.id);
    assert.deepEqual([app.state, app.ats_type], ['approved', 'greenhouse']);
  });

  test('allowed and exact but unattended submit off: rerouted, then parked reroute_submit_disabled', async () => {
    const s = await seed();
    const fresh = { autoApply: { ...FRESH.autoApply, unattendedSubmit: { enabled: false, ats: {}, dailySubmitCap: 5 } } };
    const { deps } = harness({ target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' }, fresh });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.equal(r.outcome, 'parked');
    assert.equal(r.reason, 'reroute_submit_disabled');
    const app = await getApplication(c, s.id);
    assert.deepEqual([app.state, app.ats_type, app.pending_question.kind, app.pending_question.reason], ['needs_human', 'greenhouse', 'morning_driver_park', 'reroute_submit_disabled']);
  });

  test('ATS not allowed: parked reroute_ats_not_allowed, the application keeps its ATS', async () => {
    const s = await seed();
    const fresh = { autoApply: { ...FRESH.autoApply, atsAllow: ['lever'] } };
    const { deps } = harness({ target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' }, fresh });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.equal(r.reason, 'reroute_ats_not_allowed');
    assert.equal((await getApplication(c, s.id)).ats_type, 'linkedin_easy');
  });

  test('external but unresolved (not exact): parked reroute_unresolved', async () => {
    const s = await seed();
    const { deps } = harness({ target: null, branch: 'external' });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.deepEqual([r.outcome, r.reason], ['parked', 'reroute_unresolved']);
  });

  test('a tenant that does not match the listing company parks reroute_company_mismatch and demotes the listing target (A3)', async () => {
    const s = await seed();
    const { deps } = harness({ target: { url: 'https://boards.greenhouse.io/othercorp/jobs/77', ats: 'greenhouse', confidence: 'exact' } });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.deepEqual([r.outcome, r.reason], ['parked', 'reroute_company_mismatch']);
    assert.equal((await getApplication(c, s.id)).ats_type, 'linkedin_easy');
    assert.notEqual((await listingRow(s.listingId)).apply_ats_confidence, 'exact', 'a mismatched target can never be auto-applied through later');
  });

  test('a confidential listing parks reroute_company_mismatch (A3)', async () => {
    const s = await seed({ company: 'Confidential', companyNorm: 'confidential:zz' });
    const { deps } = harness({ target: { url: 'https://boards.greenhouse.io/confidential/jobs/1', ats: 'greenhouse', confidence: 'exact' } });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.equal(r.reason, 'reroute_company_mismatch');
  });

  test('the exclusion gate runs with the NEW url before anything commits (A3)', async () => {
    const s = await seed();
    /** @type {any[]} */
    const seen = [];
    const { deps } = harness({
      target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' },
      exclusion: (l) => { seen.push(l.applyUrl); return { branch: 'blocked_company', reason: 'blocked' }; },
    });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.deepEqual(seen, [GH_URL(s.n)]);
    assert.deepEqual([r.outcome, r.reason], ['parked', 'reroute_exclusion']);
    assert.equal((await getApplication(c, s.id)).ats_type, 'linkedin_easy', 'nothing was rerouted');
  });

  test('easy_apply: an approved row returns to the Easy Apply path; a needs_human row gets a note only and the attempt counts (A11)', async () => {
    const a = await seed();
    const r1 = await rerouteApplication(a.id, 'approved', harness({ branch: 'easy_apply', target: null }).deps);
    assert.equal(r1.outcome, 'easy_apply');
    assert.equal((await getApplication(c, a.id)).state, 'approved');
    const b = await seed({ state: 'needs_human', pq: { kind: 'easy_apply_stopped', label: 'Could not open the Easy Apply dialog (no_easy_apply_button). Apply by hand.' } });
    const r2 = await rerouteApplication(b.id, 'needs_human', harness({ branch: 'easy_apply', target: null }).deps);
    assert.deepEqual([r2.outcome, r2.reason], ['noted', 'reroute_easy_apply']);
    const app = await getApplication(c, b.id);
    assert.equal(app.state, 'needs_human');
    assert.equal(app.pending_question.kind, 'easy_apply_stopped', 'the existing park stays');
    assert.equal((await events(b.id)).filter((e) => e.kind === 'note').length, 1);
    assert.equal((await listingRow(b.listingId)).probe_attempts, 1, 'the probe counted toward the lifetime cap');
  });

  test('closed and already_applied park with their own reasons; an unknown page parks reroute_unknown_page', async () => {
    for (const [branch, reason] of [['closed', 'reroute_listing_closed'], ['already_applied', 'reroute_already_applied'], ['no_control', 'reroute_unknown_page'], ['something_new', 'reroute_unknown_page']]) {
      const s = await seed();
      const r = await rerouteApplication(s.id, 'approved', harness({ branch, target: null, outcome: 'resolved' }).deps);
      assert.deepEqual([r.outcome, r.reason], ['parked', reason], branch);
    }
  });

  test('a needs_human row that stays unresolved gets a note only', async () => {
    const s = await seed({ state: 'needs_human' });
    const r = await rerouteApplication(s.id, 'needs_human', harness({ target: null }).deps);
    assert.deepEqual([r.outcome, r.reason], ['noted', 'reroute_unresolved']);
    assert.equal((await getApplication(c, s.id)).pending_question.kind, 'easy_apply_unverified');
  });

  test('challenge or auth wall halts rerouting', async () => {
    const s = await seed();
    const r = await rerouteApplication(s.id, 'approved', harness({ branch: 'challenge', target: null, outcome: 'halted_challenge' }).deps);
    assert.deepEqual([r.outcome, r.reason], ['halted', 'challenge']);
    assert.equal((await getApplication(c, s.id)).state, 'approved');
  });

  test('deferrals: breaker, budget, no browser, load failure, lifetime cap, per-run cap; nothing parks', async () => {
    const cases = /** @type {Array<[any, string]>} */ ([
      [{ breaker: true }, 'breaker'],
      [{ budgetOk: false }, 'budget_exhausted'],
      [{ browser: false }, 'no_browser'],
      [{ outcome: 'skipped_load_failure', branch: 'load_failure', target: null }, 'load_failure'],
      [{ budget: { used: 5, max: 5 } }, 'reroute_cap'],
    ]);
    for (const [o, reason] of cases) {
      const s = await seed();
      const { h, deps } = harness(o);
      const r = await rerouteApplication(s.id, 'approved', deps);
      assert.deepEqual([r.outcome, r.reason], ['deferred', reason], JSON.stringify(o));
      assert.equal((await getApplication(c, s.id)).state, 'approved');
      if (reason === 'no_browser') assert.deepEqual(h.refunds.map((x) => x.give), [{ details: 2 }]);
      if (reason === 'budget_exhausted' || reason === 'breaker' || reason === 'reroute_cap') assert.equal(h.opened, 0);
    }
    const capped = await seed({ listing: { probe_attempts: 3 } });
    const r = await rerouteApplication(capped.id, 'approved', harness().deps);
    assert.deepEqual([r.outcome, r.reason], ['deferred', 'lifetime_cap']);
  });

  test('the listing\'s own exact target probed recently is reused without loading a page', async () => {
    const s = await seed({ listing: { apply_url: GH_URL(9), apply_ats: 'greenhouse', apply_ats_confidence: 'exact', apply_easy_only: false, apply_probed_at: new Date('2026-10-07T10:00:00Z') } });
    const { h, deps } = harness();
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.equal(r.outcome, 'rerouted', JSON.stringify(r));
    assert.equal(h.opened, 0);
    assert.equal(h.reserves.length, 0);
  });

  test('A1: the per-application lock held elsewhere -> locked; a row that moved on -> state_changed', async () => {
    const s = await seed();
    const other = await freshClient();
    try {
      await other.query('SELECT pg_advisory_lock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, s.id]);
      const r = await rerouteApplication(s.id, 'approved', harness().deps);
      assert.equal(r.outcome, 'locked');
    } finally {
      await other.end();
    }
    const moved = await seed({ state: 'needs_human' });
    const r2 = await rerouteApplication(moved.id, 'approved', harness().deps);
    assert.equal(r2.outcome, 'state_changed');
  });

  test('a marker on the row: nothing is probed or rerouted', async () => {
    const s = await seed();
    await recordAssistedNextClick(c, s.id);
    const { h, deps } = harness({ target: { url: GH_URL(s.n), ats: 'greenhouse', confidence: 'exact' } });
    const r = await rerouteApplication(s.id, 'approved', deps);
    assert.deepEqual([r.outcome, r.reason], ['skipped', 'marker_set']);
    assert.equal(h.prepared, 0);
  });
});

describe('summarizeReroute', () => {
  test('counts every outcome in exactly one bucket', () => {
    const s = summarizeReroute([
      { outcome: 'rerouted', ats: 'greenhouse' }, { outcome: 'parked', reason: 'reroute_unresolved' }, { outcome: 'noted', reason: 'reroute_unresolved' },
      { outcome: 'deferred', reason: 'no_browser' }, { outcome: 'easy_apply' }, { outcome: 'locked' },
    ]);
    assert.equal(s.attempted, 6);
    assert.equal(s.rerouted, 1);
    assert.deepEqual(s.by_ats, { greenhouse: 1 });
    assert.equal(s.parked, 2);
    assert.deepEqual(s.parked_reasons, { reroute_unresolved: 2 });
    assert.equal(s.deferred, 1);
    assert.equal(s.other, 2);
    assert.deepEqual(s.other_outcomes, { easy_apply: 1, locked: 1 });
  });
});
