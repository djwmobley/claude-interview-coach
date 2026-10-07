// @ts-check
/**
 * Unattended submit, DB-backed pieces (spec v1 items 4-7, spec v2 addendum C1-C3, C7-C9, C11), against the
 * real isolated test DB:
 *   - reserveSubmitMarker: one winner per application ever, the daily cap counted and reserved atomically
 *     with the marker (concurrent reservers never exceed the cap), a non-positive cap refused;
 *   - hasSubmitRequestSentEver: an event from an earlier attempt or a marker row both count;
 *   - the transition guard: Resume, Retry, resumeAutomatic, the credential resume, and a re-draft are all
 *     refused once a marker exists; "I applied by hand" is refused (C8);
 *   - reconcileStale (C9): a row whose per-application lock is held, or whose open lease heartbeated
 *     recently, is not stale; a crashed row with a marker becomes submit_unconfirmed;
 *   - the resume gate (C11): submit_unconfirmed and submit_error are refused by name; submit_gate resumes;
 *     a marked row with another kind is re-labelled submit_unconfirmed;
 *   - the Workday hand-off's scripted submit step and lease heartbeat;
 *   - the Gmail cross-check of unconfirmed submits (C7) and the report sections (spec item 7);
 *   - the config block (spec item 6).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { pgConnectionConfig, loadConfig, autoApplySchema } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  createApplication, getApplication, transition, reconcileStale, reserveSubmitMarker, recordSubmitRequestSent, hasSubmitRequestSentEver,
  markAppliedByHand, resume, retry, resumeAutomatic, submitMarkersToday, APPLICATION_LOCK_NAMESPACE, listApplicationEvents,
} from '../src/core/applications.js';
import { resumeParkedApplication, resumeForCredential } from '../src/apply/resume-gate.js';
import { runAssistedHandoff } from '../src/apply/assisted/handoff.js';
import { issueLease, updateLeaseState } from '../src/core/easy-apply-state.js';
import { workdayStartGate } from '../src/apply/assisted/gate.js';
import { runMailConfirm, matchUnconfirmed, requisitionTokens, GMAIL_MESSAGES_URL } from '../src/apply/mail-confirm.js';
import { classifyApplicationMail } from '../src/apply/mail-classifier.js';
import { SCOPE_GMAIL_READONLY } from '../src/core/google.js';
import { collectSubmissions, collectNeedsHumanApplications, renderAutoApplyText, renderAutoApplyMarkdown, renderAutoApplyHtml } from '../src/core/report.js';
import { unattendedSubmitConfig } from '../src/apply/submit-gate.js';

const CO = `ZZ-TEST-UNATTENDED-DB-${process.pid}`;
/** @type {pg.Client} */
let db;
/** @type {number[]} */
const listingIds = [];
/** @type {string} */
let tmp;

before(async () => {
  db = new pg.Client(pgConnectionConfig());
  await db.connect();
  await ensureAuxSchema(db);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-db-'));
});
after(async () => {
  if (listingIds.length) {
    await db.query('DELETE FROM ic_gmail_processed_messages WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
    await db.query(`DELETE FROM ic_gmail_processed_messages WHERE message_id LIKE $1`, [`zz-unattended-${process.pid}-%`]);
    await db.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
    await db.query('DELETE FROM ic_easy_apply_leases WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
    await db.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
    await db.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
    await db.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
    await db.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  }
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param {{ state?: string, ats?: string, pq?: any, company?: string, companyNorm?: string, title?: string, applyUrl?: string, resumeDoc?: boolean }} [o]
 */
async function seed(o = {}) {
  const n = crypto.randomBytes(6).toString('hex');
  const company = o.company ?? `${CO}-${n}`;
  const r = await db.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status)
     VALUES ($1, $2, $3, $4, 'listing', $5, $6, 'legacy-unknown', $7, now(), 'shortlisted') RETURNING id`,
    [o.title ?? 'Chief Technology Officer', company, `zz-test-unattended-db-${process.pid}`, `zz-test-unattended-db-${process.pid}:${n}`, o.companyNorm ?? company.toLowerCase(), (o.title ?? 'Chief Technology Officer').toLowerCase(), `zz-unattended-db-${n}`],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const created = await createApplication(db, { listingId, atsType: o.ats ?? 'greenhouse', applyUrl: o.applyUrl ?? 'https://boards.greenhouse.io/acme/jobs/1234567', accountEmail: 'jordan@example.com', actor: 'mcp', floors: { texas_or_remote: 225000, relocation: 275000 } });
  /** @type {any[]} */
  const params = [created.id, o.state ?? 'needs_human', o.pq === undefined ? JSON.stringify({ kind: 'captcha', label: 'x' }) : (o.pq === null ? null : JSON.stringify(o.pq))];
  await db.query('UPDATE ic_job_applications SET state = $2, pending_question = $3::jsonb, resume_doc_id = NULL WHERE id = $1', params);
  if (o.resumeDoc !== false) {
    const d = await db.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', 'resumes/r.docx', 'mcp') RETURNING id`, [listingId]);
    await db.query('UPDATE ic_job_applications SET resume_doc_id = $2 WHERE id = $1', [created.id, Number(d.rows[0].id)]);
  }
  return { id: Number(created.id), listingId };
}

describe('reserveSubmitMarker (C1, C3)', () => {
  test('one winner per application, ever; the marker and the event commit together', async () => {
    const { id } = await seed({ state: 'submitting', pq: null });
    const first = await reserveSubmitMarker(db, { applicationId: id, dailyCap: 1000 });
    assert.equal(first.ok, true);
    const again = await reserveSubmitMarker(db, { applicationId: id, dailyCap: 1000 });
    assert.deepEqual({ ok: again.ok, reason: /** @type {any} */ (again).reason }, { ok: false, reason: 'marker_exists' });
    const ev = await listApplicationEvents(db, id);
    assert.equal(ev.filter((e) => e.note === 'submit_request_sent').length, 1);
  });

  test('concurrent reservers for different applications never exceed the cap (the slot is reserved with the marker)', async () => {
    const apps = await Promise.all([1, 2, 3, 4, 5].map(() => seed({ state: 'submitting', pq: null })));
    const used = await submitMarkersToday(db);
    const clients = await Promise.all(apps.map(async () => { const c = new pg.Client(pgConnectionConfig()); await c.connect(); return c; }));
    try {
      const results = await Promise.all(apps.map((a, i) => reserveSubmitMarker(clients[i], { applicationId: a.id, dailyCap: used + 2 })));
      assert.equal(results.filter((r) => r.ok).length, 2);
      assert.equal(results.filter((r) => !r.ok && /** @type {any} */ (r).reason === 'cap_exhausted').length, 3);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  test('a non-positive or non-integer cap is refused before anything is written', async () => {
    const { id } = await seed({ state: 'submitting', pq: null });
    for (const cap of [0, -1, 1.5, '5', null]) {
      const r = await reserveSubmitMarker(db, { applicationId: id, dailyCap: cap });
      assert.equal(/** @type {any} */ (r).reason, 'cap_invalid', String(cap));
    }
    assert.equal(await hasSubmitRequestSentEver(db, id), false);
  });
});

describe('the durable marker from ANY attempt (C2, C8)', () => {
  test('a legacy event alone, or a marker row alone, both count', async () => {
    const a = await seed();
    await db.query(`INSERT INTO ic_job_application_events (application_id, kind, actor, note) VALUES ($1, 'progress', 'apply', 'submit_request_sent')`, [a.id]);
    assert.equal(await hasSubmitRequestSentEver(db, a.id), true);
    const b = await seed();
    await db.query(`INSERT INTO ic_job_submit_markers (application_id, ats_type, day) VALUES ($1, 'greenhouse', current_date)`, [b.id]);
    assert.equal(await hasSubmitRequestSentEver(db, b.id), true);
    const c = await seed();
    assert.equal(await hasSubmitRequestSentEver(db, c.id), false);
  });

  test('Resume, Retry, resumeAutomatic, the credential resume, and a re-draft are refused; the row never moves', async () => {
    const a = await seed({ pq: { kind: 'credential', target: 'jobsearch:x', username: 'u' } });
    await recordSubmitRequestSent(db, a.id);
    await assert.rejects(() => resume(db, a.id, { actor: 'dashboard' }), /never re-armed/);
    await assert.rejects(() => resumeAutomatic(db, a.id, { actor: 'apply' }), /never re-armed/);
    await assert.rejects(() => resumeForCredential(db, a.id, 'jobsearch:x', { actor: 'dashboard' }), /never re-armed/);
    await assert.rejects(() => transition(db, a.id, 'drafting', { actor: 'dashboard' }), /never re-armed/);
    assert.equal((await getApplication(db, a.id)).state, 'needs_human');
    const f = await seed({ state: 'failed', pq: null });
    await recordSubmitRequestSent(db, f.id);
    await assert.rejects(() => retry(db, f.id, { actor: 'dashboard' }), /never re-armed/);
    assert.equal((await getApplication(db, f.id)).state, 'failed');
  });

  test('"I applied by hand" is refused with a marker and still works without one', async () => {
    const a = await seed({ pq: { kind: 'submit_unconfirmed', label: 'x' } });
    await recordSubmitRequestSent(db, a.id);
    await assert.rejects(() => markAppliedByHand(db, a.id, { actor: 'dashboard' }), /Already submitted \(unconfirmed\)/);
    const b = await seed({ pq: { kind: 'unrecognized_page', label: 'x' } });
    const row = await markAppliedByHand(db, b.id, { actor: 'dashboard' });
    assert.equal(row.state, 'submitted');
  });
});

describe('reconcileStale (spec item 4, C9)', () => {
  test('a crashed submitting row with a marker becomes submit_unconfirmed', async () => {
    const a = await seed({ state: 'submitting', pq: null });
    await recordSubmitRequestSent(db, a.id);
    await db.query(`UPDATE ic_job_applications SET updated_at = now() - interval '30 minutes' WHERE id = $1`, [a.id]);
    await reconcileStale(db, { maxAgeMinutes: 10 });
    const row = await getApplication(db, a.id);
    assert.equal(row.pending_question.kind, 'submit_unconfirmed');
  });

  test('a row whose worker still holds the per-application lock is skipped', async () => {
    const a = await seed({ state: 'submitting', pq: null });
    await db.query(`UPDATE ic_job_applications SET updated_at = now() - interval '30 minutes' WHERE id = $1`, [a.id]);
    const holder = new pg.Client(pgConnectionConfig());
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, a.id]);
      await reconcileStale(db, { maxAgeMinutes: 10 });
      assert.equal((await getApplication(db, a.id)).state, 'submitting', 'a live run is never reconciled');
      await holder.query('SELECT pg_advisory_unlock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, a.id]);
      await reconcileStale(db, { maxAgeMinutes: 10 });
      assert.equal((await getApplication(db, a.id)).state, 'failed', 'once the lock is gone the stale row is reconciled');
    } finally {
      await holder.end();
    }
  });

  test('a row with an open, freshly heartbeated lease is skipped; a stale lease is not', async () => {
    const a = await seed({ state: 'submitting', pq: null, ats: 'workday', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/c/job/X_R1' });
    await db.query(`UPDATE ic_job_applications SET updated_at = now() - interval '40 minutes' WHERE id = $1`, [a.id]);
    const lease = await issueLease(db, { applicationId: a.id, trigger: 'dashboard', targetId: 'T', ttlMs: 3600000, ats: 'workday', now: new Date(Date.now() - 40 * 60000) });
    await updateLeaseState(db, lease.leaseId, { lastActionAt: new Date() });
    await reconcileStale(db, { maxAgeMinutes: 10 });
    assert.equal((await getApplication(db, a.id)).state, 'submitting');
    await updateLeaseState(db, lease.leaseId, { lastActionAt: new Date(Date.now() - 30 * 60000) });
    await reconcileStale(db, { maxAgeMinutes: 10 });
    assert.equal((await getApplication(db, a.id)).state, 'failed');
  });
});

describe('resume gate (C11)', () => {
  const ROOMY = { autoApply: { workday: { assistedDaily: 25 }, linkedin: { easyApplyDaily: 25 } }, adapters: { adapters: { linkedin: { dailyPages: 100, dailyDetails: 100 } } } };

  test('submit_unconfirmed and submit_error are refused by name; submit_gate (a pre-click park) resumes', async () => {
    for (const kind of ['submit_unconfirmed', 'submit_error']) {
      const a = await seed({ pq: { kind, label: 'x' } });
      const out = await resumeParkedApplication(db, a.id, { config: ROOMY });
      assert.equal(out.outcome === 'refused' && out.reason, 'submit_unconfirmed', kind);
    }
    const g = await seed({ pq: { kind: 'submit_gate', label: 'kill switch', gate_reason: 'kill_switch' } });
    const ok = await resumeParkedApplication(db, g.id, { config: ROOMY });
    assert.equal(ok.outcome, 'approved');
  });

  test('a marked row parked under another kind is refused and re-labelled submit_unconfirmed', async () => {
    const a = await seed({ pq: { kind: 'unrecognized_page', label: 'x' } });
    await recordSubmitRequestSent(db, a.id);
    const out = await resumeParkedApplication(db, a.id, { config: ROOMY });
    assert.equal(out.outcome === 'refused' && out.reason, 'submit_request_sent');
    const row = await getApplication(db, a.id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'submit_unconfirmed');
  });
});

describe('Workday hand-off: scripted submit step and lease heartbeat (spec item 2, C9)', () => {
  /** @param {{ submitStep?: any, runnerDelayMs?: number }} o */
  async function runHandoff(o) {
    const a = await seed({ state: 'submitting', pq: null, ats: 'workday', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/c/job/X_R1' });
    /** @type {boolean[]} */
    const releases = [];
    /** @type {any[]} */
    const beats = [];
    const result = await runAssistedHandoff({
      client: db, app: { id: a.id, apply_url: 'https://acme.wd5.myworkdayjobs.com/en-US/c/job/X_R1' },
      profile: { ats: 'workday', label: 'Workday', breakerKey: 'workday' }, ttlMs: 600000, breakerHours: 24, log: (/** @type {any} */ f) => { if (f.evt === 'assisted_lease_heartbeat_failed') beats.push(f); },
      prelude: async () => ({ ok: true, targetId: 'T1', release: async (/** @type {boolean} */ keep) => { releases.push(keep); return { ok: true }; } }),
      runner: {
        run: async (/** @type {any} */ input) => {
          if (o.runnerDelayMs) await new Promise((r) => { setTimeout(r, o.runnerDelayMs); });
          const lease = (await db.query('SELECT id FROM ic_easy_apply_leases WHERE application_id = $1 ORDER BY id DESC LIMIT 1', [input.applicationId])).rows[0];
          const ledger = [{ question: 'City', value: 'Houston' }];
          await db.query(`UPDATE ic_easy_apply_leases SET closed_at = now(), stop_reason = 'finished', ledger = $3::jsonb, finish_result = $2::jsonb WHERE id = $1`, [lease.id, JSON.stringify({ ok: true, ledger, prefilled_unledgered: [] }), JSON.stringify(ledger)]);
          return { exitCode: 0 };
        },
      },
      submitStep: o.submitStep, heartbeatMs: 20,
    });
    // The hand-off never transitions the row (the worker does); free the one Workday in-flight slot.
    await db.query(`UPDATE ic_job_applications SET state = 'failed' WHERE id = $1`, [a.id]);
    return { result, releases, appId: a.id };
  }

  test('a verified finish plus a confirmed scripted submit returns submitted and closes the tab', async () => {
    /** @type {any[]} */
    const seen = [];
    const { result, releases } = await runHandoff({ submitStep: async (/** @type {any} */ m) => { seen.push(m); return { outcome: 'submitted' }; } });
    assert.deepEqual(result, { outcome: 'submitted', confirmationRef: null });
    assert.deepEqual(releases, [false]);
    assert.deepEqual(seen[0].ledger, [{ question: 'City', value: 'Houston' }]);
    assert.deepEqual(seen[0].prefilledUnledgered, []);
  });

  test('a null step (submitMode assisted, or a soft gate park) keeps the assisted awaiting_submit hand-off', async () => {
    const { result, releases } = await runHandoff({ submitStep: async () => null });
    assert.equal(result.outcome, 'awaiting_submit');
    assert.deepEqual(releases, [true]);
  });

  test('a hard gate park becomes needs_human and closes the tab', async () => {
    const pq = { kind: 'submit_gate', label: 'excluded', gate_reason: 'exclusion' };
    const { result, releases } = await runHandoff({ submitStep: async () => ({ outcome: 'needs_human', clicked: false, pendingQuestion: pq }) });
    assert.equal(result.outcome, 'needs_human');
    assert.equal(/** @type {any} */ (result).pendingQuestion.kind, 'submit_gate');
    assert.deepEqual(releases, [false]);
  });

  test('the lease heartbeats while the session runs', async () => {
    const before = Date.now();
    const { appId } = await runHandoff({ submitStep: async () => null, runnerDelayMs: 150 });
    const r = await db.query('SELECT last_action_at FROM ic_easy_apply_leases WHERE application_id = $1 ORDER BY id DESC LIMIT 1', [appId]);
    assert.ok(r.rows[0].last_action_at && new Date(r.rows[0].last_action_at).getTime() >= before - 1000, 'last_action_at was refreshed during the run');
  });
});

describe('Gmail cross-check of unconfirmed submits (spec item 5, C7)', () => {
  test('requisitionTokens: tokens with at least 5 digits only', () => {
    assert.deepEqual(requisitionTokens('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Houston/CTO_R0012345?src=2026'), ['r0012345']);
    assert.deepEqual(requisitionTokens('https://boards.greenhouse.io/acme/jobs/4455667'), ['4455667']);
    assert.deepEqual(requisitionTokens('not a url'), []);
  });

  test('matchUnconfirmed: company plus the title or a requisition token, dated after the marker within 72h', () => {
    const marker = new Date('2026-10-01T12:00:00Z');
    const pool = [{ application_id: 1, listing_id: 1, apply_url: 'https://boards.greenhouse.io/acme/jobs/4455667', company: 'Acme', company_norm: 'acme', title: 'Chief Technology Officer', marker_at: marker }];
    const after = new Date('2026-10-01T13:00:00Z');
    assert.equal(matchUnconfirmed(pool, 'acme', 'Thanks for applying to the Chief Technology Officer role', after).length, 1);
    assert.equal(matchUnconfirmed(pool, 'acme', 'Your application for job 4455667 was received', after).length, 1);
    assert.equal(matchUnconfirmed(pool, 'acme', 'Thanks for applying to Acme', after).length, 0, 'company alone is not enough');
    assert.equal(matchUnconfirmed(pool, 'acme', 'Chief Technology Officer', new Date('2026-10-01T11:00:00Z')).length, 0, 'an email before the marker never matches');
    assert.equal(matchUnconfirmed(pool, 'acme', 'Chief Technology Officer', new Date('2026-10-05T12:00:00Z')).length, 0, 'outside the 72h window');
    assert.equal(matchUnconfirmed(pool, 'other', 'Chief Technology Officer', after).length, 0);
    assert.equal(matchUnconfirmed(pool, 'acme', 'Chief Technology Officer', null).length, 0, 'no received date, no match');
  });

  /** @param {Array<{ id: string, subject: string, text: string, at: number }>} messages */
  function fakeFetch(messages) {
    const b64 = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return async (/** @type {string} */ url) => {
      const u = new URL(url);
      if (u.pathname === new URL(GMAIL_MESSAGES_URL).pathname) return { status: 200, json: async () => ({ messages: messages.map((m) => ({ id: m.id })) }) };
      const m = messages.find((x) => x.id === u.pathname.split('/').pop());
      if (!m) return { status: 404, json: async () => ({}) };
      return { status: 200, json: async () => ({ internalDate: String(m.at), payload: { headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: 'ATS <noreply@ats.example.com>' }], mimeType: 'text/plain', body: { data: b64(m.text) } } }) };
    };
  }

  function token() {
    const file = path.join(tmp, `tok-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify({ client_id: 'zz-cid', client_secret: 'zz-secret', refresh_token: 'zz-rt', scopes: [SCOPE_GMAIL_READONLY] }));
    return file;
  }
  const okDeps = { getAccessToken: async () => ({ token: 'zz-access-token', expiry: '2099-01-01T00:00:00.000Z' }) };

  test('one unambiguous matching email moves needs_human -> submitted -> confirmed; an ambiguous one moves nothing', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const companyName = `Zorblax${suffix} Robotics`;
    const text = `Thank you for applying to ${companyName}. We have received your application for Chief Technology Officer.`;
    const norm = classifyApplicationMail({ subject: 'Thank you for applying', text, html: '', fromName: null }).company_norm;
    assert.ok(norm, 'the classifier extracts a company');
    const a = await seed({ pq: { kind: 'submit_unconfirmed', label: 'x' }, companyNorm: norm });
    await recordSubmitRequestSent(db, a.id);
    const at = Date.now() + 60000;
    const r = await runMailConfirm({ client: db, tokenFile: token(), deps: okDeps, fetch: /** @type {any} */ (fakeFetch([{ id: `zz-unattended-${process.pid}-m1-${suffix}`, subject: 'Thank you for applying', text, at }])) });
    assert.equal(r.ok, true);
    assert.equal(r.outcomes.confirmed_unconfirmed, 1, JSON.stringify(r.outcomes));
    const row = await getApplication(db, a.id);
    assert.equal(row.state, 'confirmed');
    const ev = await listApplicationEvents(db, a.id);
    assert.deepEqual(ev.filter((e) => e.kind === 'state').slice(-2).map((e) => `${e.from_state}->${e.to_state}`), ['needs_human->submitted', 'submitted->confirmed']);

    const b1 = await seed({ pq: { kind: 'submit_unconfirmed', label: 'x' }, companyNorm: norm });
    const b2 = await seed({ pq: { kind: 'submit_unconfirmed', label: 'x' }, companyNorm: norm });
    await recordSubmitRequestSent(db, b1.id);
    await recordSubmitRequestSent(db, b2.id);
    const r2 = await runMailConfirm({ client: db, tokenFile: token(), deps: okDeps, fetch: /** @type {any} */ (fakeFetch([{ id: `zz-unattended-${process.pid}-m2-${suffix}`, subject: 'Thank you for applying', text, at: Date.now() + 60000 }])) });
    assert.equal(r2.outcomes.ambiguous_unconfirmed, 1, JSON.stringify(r2.outcomes));
    assert.equal((await getApplication(db, b1.id)).state, 'needs_human');
    assert.equal((await getApplication(db, b2.id)).state, 'needs_human');
  });
});

describe('report sections read from the DB (spec item 7, D6)', () => {
  test('collectSubmissions lists submissions of the last 24h and unconfirmed submits; needs-human excludes the unconfirmed', async () => {
    const s = await seed({ state: 'submitted', pq: null });
    await db.query(`UPDATE ic_job_applications SET submitted_at = now() - interval '1 hour' WHERE id = $1`, [s.id]);
    const u = await seed({ pq: { kind: 'submit_unconfirmed', label: 'Submitted, unconfirmed.' } });
    const out = await collectSubmissions(db);
    assert.ok(out.submitted.some((x) => x.applicationId === s.id));
    assert.ok(out.unconfirmed.some((x) => x.applicationId === u.id));
    const nh = await collectNeedsHumanApplications(db);
    assert.equal(nh.some((x) => x.applicationId === u.id), false);
  });

  test('every renderer prints both sections', () => {
    const data = /** @type {any} */ ({
      hasRun: true, dryRun: false, appliedCount: 0, cappedCount: 0, capUsed: 0, capRemaining: 5, skippedByReason: {}, warnings: [], funnel: null, dailyCap: 5, prepare: null,
      unresolved: [], needsHuman: [], failed: [], submittedReviewFail: 0, submittedNoVerdict: 0,
      submittedDb: [{ applicationId: 7, listingId: 70, title: 'CTO', company: 'Acme', ats: 'workday', state: 'submitted', submittedAt: null }],
      submitUnconfirmed: [{ applicationId: 8, listingId: 80, title: 'CIO', company: 'Beta', ats: 'lever', reason: 'x' }],
    });
    for (const text of [renderAutoApplyText(data), renderAutoApplyMarkdown(data), renderAutoApplyHtml(data)]) {
      assert.match(text, /submitted in the last 24h, from the database \(1\)/);
      assert.match(text, /submitted, unconfirmed \(1\)/);
      assert.match(text, /app 8/);
    }
  });
});

describe('config (spec item 6)', () => {
  test('the block defaults OFF, and the kill switch is enabled:false', () => {
    const parsed = autoApplySchema.parse({});
    assert.equal(parsed.unattendedSubmit.enabled, false);
    assert.equal(Object.values(parsed.unattendedSubmit.ats).some(Boolean), false);
    assert.equal(parsed.workday.submitMode, 'assisted');
    assert.throws(() => autoApplySchema.parse({ unattendedSubmit: { ats: { linkedin_easy: true } } }), 'LinkedIn can never be switched on');
    assert.throws(() => autoApplySchema.parse({ workday: { submitMode: 'auto' } }));
  });

  test('the committed config switches unattended submit on for the six form ATS types with a submit cap', () => {
    const cfg = unattendedSubmitConfig(loadConfig({ fresh: true }));
    assert.equal(cfg.enabled, true);
    assert.deepEqual(Object.entries(cfg.ats).filter(([, v]) => v).map(([k]) => k).sort(), ['dayforce', 'greenhouse', 'icims', 'lever', 'smartrecruiters', 'workday']);
    assert.equal(typeof cfg.dailySubmitCap, 'number');
    assert.equal(cfg.workdaySubmitMode, 'unattended');
  });

  test("Workday's start gate accepts both submit modes and refuses anything else", async () => {
    for (const mode of ['assisted', 'unattended']) {
      const g = await workdayStartGate(db, { config: { autoApply: { workday: { submitMode: mode, assistedDaily: 25 } } }, now: new Date() });
      assert.notEqual(/** @type {any} */ (g).reason, 'submit_mode_unsupported', mode);
      if (g.ok) await db.query('UPDATE ic_scan_budget SET pages = GREATEST(pages - 1, 0) WHERE source = $1 AND day = $2', ['workday_assisted', new Date().toISOString().slice(0, 10)]);
    }
    const bad = await workdayStartGate(db, { config: { autoApply: { workday: { submitMode: 'auto' } } }, now: new Date() });
    assert.equal(/** @type {any} */ (bad).reason, 'submit_mode_unsupported');
  });
});
