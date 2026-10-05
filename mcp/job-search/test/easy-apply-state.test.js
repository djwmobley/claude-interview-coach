// @ts-check
/**
 * src/core/easy-apply-state.js + sql/018_easy_apply_assisted.sql (assisted Easy Apply, spec G8-G12):
 * lease issue/validate (expired, wrong application, wrong nonce, closed), the unique-index race (at most
 * one linkedin_easy application in submitting OR awaiting_submit), the persisted circuit breaker, the
 * daily cap through reserveBudget (also charged to LinkedIn's own budget), awaiting-target listing,
 * abandoned-tab demotion, and stale marking. Real test database.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, getApplication, transition, listApplicationEvents } from '../src/core/applications.js';
import {
  issueLease, validateLease, closeLease, parseLeaseToken, tripBreaker, breakerStatus, reserveEasyApplyAttempt,
  hasEasyApplyInFlight, listAwaitingTargets, demoteAbandonedTabs, markStaleAwaiting, lastAttemptAt, parkAwaitingSubmit,
  updateLeaseState, getLease, clearBreakerForTests,
} from '../src/core/easy-apply-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '018_easy_apply_assisted.sql'), 'utf8');
const CO = `ZZ-TEST-EASYSTATE-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

async function insertListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url)
     VALUES ('Easy State Test', $1, 'linkedin', $2, 'listing', $3, 'easy state test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-easystate-${process.pid}:${n}`, `easy state co ${n}`, `zz-easystate-hash-${n}`, `https://www.linkedin.com/jobs/view/${n}/`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {string} state @param {any} [pq] */
async function appInState(state, pq = null) {
  const listingId = await insertListing();
  const app = await createApplication(client, { listingId, atsType: 'linkedin_easy', applyUrl: `https://www.linkedin.com/jobs/view/${listingId}/`, floors: { texas_or_remote: 1, relocation: 1 } });
  await client.query('UPDATE ic_job_applications SET state = $2, pending_question = $3::jsonb WHERE id = $1', [app.id, state, pq ? JSON.stringify(pq) : null]);
  return app.id;
}

async function cleanup() {
  await client.query(`DELETE FROM ic_scan_budget WHERE source IN ('linkedin_easy_apply', 'zz-easy-linkedin')`);
  await clearBreakerForTests(client);
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_easy_apply_leases WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await client.query(SQL); // idempotent re-apply
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
});
beforeEach(cleanup);

describe('leases (spec B2: every tool call validates application id, nonce, expiry)', () => {
  test('a freshly issued lease validates; the token round-trips', async () => {
    const id = await appInState('submitting');
    const now = new Date();
    const { token, leaseId } = await issueLease(client, { applicationId: id, trigger: 'dashboard', targetId: 'T1', ttlMs: 60000, now });
    assert.deepEqual(parseLeaseToken(token)?.applicationId, id);
    const lease = await validateLease(client, token, now);
    assert.equal(lease.id, leaseId);
    assert.equal(lease.target_id, 'T1');
  });
  test('expired, wrong nonce, wrong application, closed, malformed, and not-submitting are all refused', async () => {
    const id = await appInState('submitting');
    const other = await appInState('approved');
    const now = new Date();
    const { token, leaseId } = await issueLease(client, { applicationId: id, trigger: 'dashboard', targetId: 'T1', ttlMs: 60000, now });
    const nonce = /** @type {any} */ (parseLeaseToken(token)).nonce;
    await assert.rejects(validateLease(client, token, new Date(now.getTime() + 120000)), /lease_expired/);
    await assert.rejects(validateLease(client, `${id}.${'0'.repeat(nonce.length)}`, now), /lease_invalid/);
    await assert.rejects(validateLease(client, `${other}.${nonce}`, now), /lease_invalid/);
    await assert.rejects(validateLease(client, 'garbage', now), /lease_missing/);
    await assert.rejects(validateLease(client, undefined, now), /lease_missing/);
    await client.query(`UPDATE ic_job_applications SET state = 'failed' WHERE id = $1`, [id]);
    await assert.rejects(validateLease(client, token, now), /application_not_submitting/);
    await client.query(`UPDATE ic_job_applications SET state = 'submitting' WHERE id = $1`, [id]);
    await closeLease(client, leaseId, { stopReason: 'finished', finishResult: { ok: true } });
    await assert.rejects(validateLease(client, token, now), /lease_closed/);
  });
  test('updateLeaseState persists state and ledger; lastAttemptAt reports the newest issue time', async () => {
    const id = await appInState('submitting');
    const now = new Date();
    const { leaseId } = await issueLease(client, { applicationId: id, trigger: 'morning', targetId: 'T2', ttlMs: 60000, now });
    await updateLeaseState(client, leaseId, { state: { step: 2 }, ledger: [{ question: 'First name', value: 'Damian' }] });
    const lease = await getLease(client, leaseId);
    assert.deepEqual(lease.state, { step: 2 });
    assert.equal(lease.ledger[0].value, 'Damian');
    const last = await lastAttemptAt(client);
    assert.ok(last && Math.abs(last.getTime() - now.getTime()) < 5000);
  });
});

describe('unique in-flight index (spec G9)', () => {
  test('a second linkedin_easy row cannot enter submitting while one is awaiting_submit', async () => {
    await appInState('needs_human', { kind: 'awaiting_submit', target_id: 'T9' });
    const second = await appInState('approved');
    await assert.rejects(transition(client, second, 'submitting', { actor: 'apply' }), (err) => /easy_apply_inflight_uq|duplicate key/.test(String(/** @type {any} */ (err).message) + String(/** @type {any} */ (err).cause ?? '')));
    assert.equal((await getApplication(client, second)).state, 'approved');
    assert.equal(await hasEasyApplyInFlight(client), true);
  });
  test('two concurrent approved -> submitting claims: exactly one wins', async () => {
    const a = await appInState('approved');
    const b = await appInState('approved');
    const c2 = new pg.Client(pgConnectionConfig());
    await c2.connect();
    try {
      const results = await Promise.allSettled([
        transition(client, a, 'submitting', { actor: 'apply' }),
        transition(c2, b, 'submitting', { actor: 'apply' }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    } finally {
      await c2.end();
    }
  });
  test('a non-linkedin application in submitting does not occupy the slot', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId, atsType: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/x/jobs/1', floors: { texas_or_remote: 1, relocation: 1 } });
    await client.query(`UPDATE ic_job_applications SET state = 'submitting' WHERE id = $1`, [app.id]);
    assert.equal(await hasEasyApplyInFlight(client), false);
  });
});

describe('reconcileStale and a running Easy Apply session', () => {
  test('a linkedin_easy row 15 minutes into submitting is not stale; 25 minutes is', async () => {
    const { reconcileStale } = await import('../src/core/applications.js');
    const id = await appInState('submitting');
    await client.query(`UPDATE ic_job_applications SET updated_at = now() - interval '15 minutes' WHERE id = $1`, [id]);
    await reconcileStale(client);
    assert.equal((await getApplication(client, id)).state, 'submitting');
    await client.query(`UPDATE ic_job_applications SET updated_at = now() - interval '25 minutes' WHERE id = $1`, [id]);
    await reconcileStale(client);
    assert.equal((await getApplication(client, id)).state, 'failed');
  });
});

describe('circuit breaker (spec G11)', () => {
  test('trips for 24 h, persists, and expires', async () => {
    const now = new Date('2026-10-05T15:00:00Z');
    assert.equal((await breakerStatus(client, now)).tripped, false);
    await tripBreaker(client, { reason: 'challenge', applicationId: null, hours: 24, now });
    const s = await breakerStatus(client, new Date(now.getTime() + 23 * 3600000));
    assert.equal(s.tripped, true);
    assert.equal(s.reason, 'challenge');
    assert.equal((await breakerStatus(client, new Date(now.getTime() + 25 * 3600000))).tripped, false);
  });
});

describe('daily cap via reserveBudget (spec G10)', () => {
  test('five attempts per day; the sixth is refused; each also charges the LinkedIn budget; next day resets', async () => {
    const now = new Date('2026-10-05T15:00:00Z');
    const linkedinCaps = { source: 'zz-easy-linkedin', dailyPages: 1000, dailyDetails: 1000 };
    for (let i = 0; i < 5; i++) {
      const r = await reserveEasyApplyAttempt(client, { easyApplyDaily: 5, linkedinCaps, now });
      assert.equal(r.ok, true, `attempt ${i + 1}`);
    }
    assert.deepEqual(await reserveEasyApplyAttempt(client, { easyApplyDaily: 5, linkedinCaps, now }), { ok: false, reason: 'easy_apply_daily_cap' });
    const li = await client.query(`SELECT details FROM ic_scan_budget WHERE source = 'zz-easy-linkedin' AND day = '2026-10-05'`);
    assert.equal(li.rows[0].details, 5);
    assert.equal((await reserveEasyApplyAttempt(client, { easyApplyDaily: 5, linkedinCaps, now: new Date('2026-10-06T15:00:00Z') })).ok, true);
  });
  test('an exhausted LinkedIn budget refuses and rolls back the Easy Apply reservation', async () => {
    const now = new Date('2026-10-05T15:00:00Z');
    const linkedinCaps = { source: 'zz-easy-linkedin', dailyPages: 0, dailyDetails: 0 };
    assert.deepEqual(await reserveEasyApplyAttempt(client, { easyApplyDaily: 5, linkedinCaps, now }), { ok: false, reason: 'linkedin_budget' });
    const r = await client.query(`SELECT pages FROM ic_scan_budget WHERE source = 'linkedin_easy_apply' AND day = '2026-10-05'`);
    assert.ok(r.rowCount === 0 || r.rows[0].pages === 0);
  });
});

describe('awaiting tabs (spec B5, G12)', () => {
  test('parkAwaitingSubmit stores the target id; listAwaitingTargets returns it', async () => {
    const id = await appInState('submitting');
    await parkAwaitingSubmit(client, id, { targetId: 'TAB-1', ledger: [{ question: 'First name', bank_key: 'first_name', value: 'Damian' }], screenshotRelPath: null, note: 'finish verified' });
    const app = await getApplication(client, id);
    assert.equal(app.state, 'needs_human');
    assert.equal(app.pending_question.kind, 'awaiting_submit');
    assert.equal(app.pending_question.target_id, 'TAB-1');
    const targets = await listAwaitingTargets(client);
    assert.ok(targets.some((t) => t.applicationId === id && t.targetId === 'TAB-1'));
  });
  test('demoteAbandonedTabs demotes only rows whose tab is gone (or all, when Chrome restarted)', async () => {
    const live = await appInState('needs_human', { kind: 'awaiting_submit', target_id: 'LIVE', awaiting_since: new Date().toISOString() });
    const demoted = await demoteAbandonedTabs(client, { aliveTargetIds: new Set(['LIVE']), reason: 'tab_missing' });
    assert.deepEqual(demoted, []);
    const again = await demoteAbandonedTabs(client, { aliveTargetIds: null, reason: 'chrome_restarted' });
    assert.deepEqual(again, [live]);
    const app = await getApplication(client, live);
    assert.equal(app.state, 'needs_human');
    assert.equal(app.pending_question.kind, 'abandoned_tab');
    assert.ok((await listApplicationEvents(client, live)).some((e) => /abandoned_tab/.test(e.note ?? '')));
  });
  test('markStaleAwaiting flags rows older than 24 h but never closes them', async () => {
    const id = await appInState('needs_human', { kind: 'awaiting_submit', target_id: 'TAB', awaiting_since: '2026-10-05T14:00:00Z' });
    await markStaleAwaiting(client, new Date('2026-10-05T15:00:00Z'), 24);
    assert.notEqual((await getApplication(client, id)).pending_question.stale, true);
    await client.query(`UPDATE ic_job_applications SET pending_question = jsonb_set(pending_question, '{awaiting_since}', '"2026-10-01T00:00:00Z"') WHERE id = $1`, [id]);
    const n = await markStaleAwaiting(client, new Date('2026-10-05T15:00:00Z'), 24);
    assert.ok(n >= 1);
    const app = await getApplication(client, id);
    assert.equal(app.pending_question.stale, true);
    assert.equal(app.pending_question.kind, 'awaiting_submit');
    assert.equal(app.state, 'needs_human');
  });
});
