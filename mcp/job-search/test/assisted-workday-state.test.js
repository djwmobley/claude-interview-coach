// @ts-check
/**
 * Assisted apply state per ATS (spec v1 clause 9, v2 A8, A10, A13) against the real test database:
 * leases record their ATS, the breaker is keyed per ATS (a tripped LinkedIn breaker leaves Workday
 * alone and vice versa), the in-flight check and the awaiting_submit tab set cover Workday, the stale
 * reconciler's 20-minute exemption is per ATS (a Workday row parked mid-handoff is not stale at 15
 * minutes), and a row whose run clicked Next is never reconciled to 'failed' (A10: a retry needs a human).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, getApplication, reconcileStale, recordAssistedNextClick, hasAssistedNextClickThisAttempt } from '../src/core/applications.js';
import {
  issueLease, getLease, tripBreaker, breakerStatus, clearBreakerForTests, hasAssistedInFlight, hasEasyApplyInFlight, listAwaitingTargets, lastAttemptAt,
} from '../src/core/easy-apply-state.js';

const CO = `ZZ-TEST-WDSTATE-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

/** @param {string} ats @param {string} state @param {any} [pq] @param {string} [age] */
async function appInState(ats, state, pq = null, age = null) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url)
     VALUES ('WD State Test', $1, 'workday', $2, 'listing', $3, 'wd state test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-wdstate-${process.pid}:${n}`, `wd state co ${n}`, `zz-wdstate-hash-${n}`, `https://acme.wd5.myworkdayjobs.com/careers/job/${n}`],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const app = await createApplication(client, { listingId, atsType: ats, applyUrl: `https://acme.wd5.myworkdayjobs.com/careers/job/${n}`, floors: { texas_or_remote: 1, relocation: 1 } });
  await client.query('UPDATE ic_job_applications SET state = $2, pending_question = $3::jsonb WHERE id = $1', [app.id, state, pq ? JSON.stringify(pq) : null]);
  if (age) await client.query(`UPDATE ic_job_applications SET updated_at = now() - $2::interval WHERE id = $1`, [app.id, age]);
  return app.id;
}

async function cleanup() {
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
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
});
beforeEach(cleanup);

describe('assisted state per ATS', () => {
  test('a lease records its ATS; a LinkedIn lease still defaults to linkedin_easy', async () => {
    const wd = await appInState('workday', 'submitting');
    const l1 = await issueLease(client, { applicationId: wd, trigger: 'dashboard', targetId: 'T-WD', ttlMs: 60000, ats: 'workday' });
    assert.equal((await getLease(client, l1.leaseId)).ats, 'workday');
    await client.query(`UPDATE ic_job_applications SET state = 'withdrawn' WHERE id = $1`, [wd]);
    const li = await appInState('linkedin_easy', 'submitting');
    const l2 = await issueLease(client, { applicationId: li, trigger: 'dashboard', targetId: 'T-LI', ttlMs: 60000 });
    assert.equal((await getLease(client, l2.leaseId)).ats, 'linkedin_easy');
    assert.ok(await lastAttemptAt(client, 'workday'));
  });

  test('breakers are independent per ATS; the default key stays linkedin_easy', async () => {
    await tripBreaker(client, { reason: 'challenge', applicationId: null, hours: 24 });
    assert.equal((await breakerStatus(client)).tripped, true);
    assert.equal((await breakerStatus(client, new Date(), 'workday')).tripped, false);
    await tripBreaker(client, { reason: 'unexpected_submit', applicationId: null, hours: 24, ats: 'workday' });
    const wd = await breakerStatus(client, new Date(), 'workday');
    assert.equal(wd.tripped, true);
    assert.equal(wd.reason, 'unexpected_submit');
    assert.equal((await breakerStatus(client, new Date(), 'linkedin_easy')).reason, 'challenge');
  });

  test('in-flight is per ATS: an in-flight LinkedIn row does not count for Workday', async () => {
    await appInState('linkedin_easy', 'submitting');
    assert.equal(await hasEasyApplyInFlight(client), true);
    assert.equal(await hasAssistedInFlight(client, 'workday'), false);
    await appInState('workday', 'needs_human', { kind: 'awaiting_submit', target_id: 'T-WD2' });
    assert.equal(await hasAssistedInFlight(client, 'workday'), true);
  });

  test('the awaiting_submit tab set includes Workday tabs (session.js never closes them)', async () => {
    const id = await appInState('workday', 'needs_human', { kind: 'awaiting_submit', target_id: 'T-WD3' });
    const rows = await listAwaitingTargets(client);
    assert.ok(rows.some((r) => r.applicationId === id && r.targetId === 'T-WD3'));
  });
});

describe('reconcileStale per ATS (A8) and the Next-click retry rule (A10)', () => {
  test('a Workday row 15 minutes into submitting is not stale (crash between prepare and lease is recoverable)', async () => {
    const young = await appInState('workday', 'submitting', null, '15 minutes');
    await reconcileStale(client, { maxAgeMinutes: 10 });
    assert.equal((await getApplication(client, young)).state, 'submitting');
  });

  test('at 25 minutes with nothing clicked it fails (retryable)', async () => {
    const old = await appInState('workday', 'submitting', null, '25 minutes');
    await reconcileStale(client, { maxAgeMinutes: 10 });
    assert.equal((await getApplication(client, old)).state, 'failed');
  });

  test('a stale row whose run clicked Next goes to needs_human, never failed', async () => {
    const id = await appInState('workday', 'submitting', null, '25 minutes');
    await recordAssistedNextClick(client, id);
    assert.equal(await hasAssistedNextClickThisAttempt(client, id), true);
    await client.query(`UPDATE ic_job_applications SET updated_at = now() - interval '25 minutes' WHERE id = $1`, [id]);
    await reconcileStale(client, { maxAgeMinutes: 10 });
    const row = await getApplication(client, id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'assisted_partial');
  });
});
