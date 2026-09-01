// @ts-check
/**
 * src/apply/mail-confirm.js (apply pipeline slice 7): DB-backed orchestration -- candidate pools,
 * matching, ambiguity handling, review routing, idempotency, and the 5-day-nudge completion. Runs against
 * the real test DB, matching test/applications.test.js's own conventions: rows carry a
 * `ZZ-TEST-MAILCONFIRM-<pid>` company so cleanup finds everything this file created. Gmail itself is
 * ALWAYS a fake fetch injected via `fetch:` -- no live Gmail access in this sandboxed environment (see
 * the PR body's Blind Spots section), matching test/gmail-verify.test.js's own convention.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { SCOPE_GMAIL_READONLY } from '../src/core/google.js';
import { runMailConfirm, GMAIL_MESSAGES_URL } from '../src/apply/mail-confirm.js';
import { APPLY_NUDGE_PREFIX } from '../src/core/applications.js';
import { recordEvent } from '../src/core/events.js';
import { enqueueReview } from '../src/core/upsert.js';

const CO = `ZZ-TEST-MAILCONFIRM-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];
/** @type {string} */
let tmp = '';

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-confirm-'));
  await cleanup();
});

after(async () => {
  await cleanup();
  await client.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [CO])).rows.map((r) => Number(r.id));
  for (const id of ids) if (!listingIds.includes(id)) listingIds.push(id);
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_gmail_processed_messages WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

/** @param {{ title?: string, companyNorm?: string, applyUrl?: string|null, status?: string|null }} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status)
     VALUES ($1, $2, $3, $4, 'listing', $5, 'mail confirm test', 'legacy-unknown', $6, now(), $7) RETURNING id`,
    // Default companyNorm is a value NO OTHER test in this file ever matches against (not 'acme',
    // 'rejectco', etc.): every seeded listing/application in this file lives for the whole file (cleanup
    // only runs in before()/after(), not per-test), so a default that collided with a real matching test's
    // companyNorm would silently make that later test's candidate pool ambiguous (exactly the bug this
    // comment documents -- an earlier version of this fixture defaulted to 'acme' and broke the
    // "received -> confirmed" tests below by adding a second 'acme' candidate from the early-exit tests).
    [o.title ?? 'Mail Confirm Test', CO, `zz-test-mailconfirm-${process.pid}`, `zz-test-mailconfirm-${process.pid}:${n}`, o.companyNorm ?? 'zz-unused-default-co', `zz-mailconfirm-hash-${n}`, o.status ?? 'applied'],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {number} listingId @param {{ state?: string, applyUrl?: string|null
}} o */
async function insertApplication(listingId, o = {}) {
  const r = await client.query(
    `INSERT INTO ic_job_applications (listing_id, state, apply_url, submitted_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [listingId, o.state ?? 'submitted', o.applyUrl ?? null],
  );
  return Number(r.rows[0].id);
}

/** @param {number} applicationId @param {number} listingId */
async function insertNudge(applicationId, listingId) {
  await client.query(
    `INSERT INTO ic_followups (contact, listing_id, due_at, channel, action, notify, status, created_from)
     VALUES ('Acme Corp', $1, now() + interval '5 days', 'other', 'Check application status', ARRAY['email'], 'open', $2)`,
    [listingId, `${APPLY_NUDGE_PREFIX}${applicationId}`],
  );
}

const okDeps = { getAccessToken: async () => ({ token: 'zz-access-token', expiry: '2099-01-01T00:00:00.000Z' }) };

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {{ id: string, subject: string, text: string, from?: string }[]} messages */
function fakeFetch(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const fn = async (/** @type {string} */ url) => {
    const u = new URL(url);
    if (u.pathname === new URL(GMAIL_MESSAGES_URL).pathname) {
      return { status: 200, json: async () => ({ messages: messages.map((m) => ({ id: m.id })) }) };
    }
    const id = u.pathname.split('/').pop();
    const m = id ? byId.get(id) : undefined;
    if (!m) return { status: 404, json: async () => ({}) };
    return {
      status: 200,
      json: async () => ({
        internalDate: String(Date.now()),
        payload: {
          headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from ?? 'ATS <noreply@ats.example.com>' }],
          mimeType: 'text/plain',
          body: { data: b64url(m.text) },
        },
      }),
    };
  };
  return fn;
}

function writeToken(name, fields = {}) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify({ client_id: 'zz-cid', client_secret: 'zz-secret', refresh_token: 'zz-rt', scopes: [SCOPE_GMAIL_READONLY], ...fields }));
  return file;
}

describe('runMailConfirm: early exits', () => {
  test('zero candidate applications -> ok:true, code 0, reason no_candidates, no Gmail call attempted', async () => {
    // Runs first in this file, immediately after before()'s cleanup(), so the candidate pool is
    // guaranteed empty -- no listing/application has been inserted by any test yet.
    let called = false;
    const r = await runMailConfirm({ client, tokenFile: writeToken('unused.json'), fetch: async () => { called = true; return { status: 200, json: async () => ({}) }; }, deps: okDeps });
    assert.equal(r.candidates, 0);
    assert.equal(r.ok, true);
    assert.equal(r.code, 0);
    assert.equal(r.reason, 'no_candidates');
    assert.equal(called, false);
  });

  test('no token file configured -> ok:false, code 1, google_auth_state no_token_file', async () => {
    const listingId = await insertListing();
    await insertApplication(listingId);
    const r = await runMailConfirm({ client, tokenFile: '', deps: okDeps });
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
    assert.equal(r.google_auth_state, 'no_token_file');
  });

  test('token file missing the gmailRead scope -> ok:false, google_auth_state carries broken_missing_scopes', async () => {
    const listingId = await insertListing();
    await insertApplication(listingId);
    const file = writeToken('no-scope.json', { scopes: [] });
    const r = await runMailConfirm({ client, tokenFile: file, deps: okDeps });
    assert.equal(r.ok, false);
    assert.match(String(r.google_auth_state), /broken_missing_scopes/);
  });
});

describe('runMailConfirm: received -> confirmed (amended decision 1)', () => {
  test('a single matching submitted application confirms, and its 5-day nudge completes', async () => {
    // companyNorm 'acme', not 'acme corp': normalizeCompany('Acme Corp') strips the "Corp" legal suffix
    // (src/core/normalize.js's SUFFIX_RE), and the mail classifier runs the SAME extracted company text
    // through the SAME normalizeCompany() -- so a real listing's stored company_norm and the mail's
    // derived company_norm are always symmetric. This fixture value must match what normalizeCompany
    // actually produces, not a hand-typed guess (an earlier version of this test used 'acme corp' and
    // never matched, a test-fixture bug this comment documents so it is not reintroduced).
    const listingId = await insertListing({ companyNorm: 'acme' });
    const appId = await insertApplication(listingId, { state: 'submitted' });
    await insertNudge(appId, listingId);
    const fetchFn = fakeFetch([{ id: 'm1', subject: 'Thank you for applying', text: 'Thank you for applying to Acme Corp. We have received your application.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-happy.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.ok, true);
    assert.equal(r.outcomes.confirmed, 1);
    const app = await client.query('SELECT state FROM ic_job_applications WHERE id = $1', [appId]);
    assert.equal(app.rows[0].state, 'confirmed');
    const nudge = await client.query('SELECT status FROM ic_followups WHERE created_from = $1', [`${APPLY_NUDGE_PREFIX}${appId}`]);
    assert.equal(nudge.rows[0].status, 'done');
    const processed = await client.query('SELECT kind, outcome, company_raw, application_id FROM ic_gmail_processed_messages WHERE message_id = $1', ['m1']);
    assert.equal(processed.rows[0].kind, 'received');
    assert.equal(processed.rows[0].outcome, 'confirmed');
    assert.equal(processed.rows[0].company_raw, 'Acme Corp');
    assert.equal(Number(processed.rows[0].application_id), appId);
  });

  test('idempotency: re-running with the same message id never reprocesses (amended decision 6)', async () => {
    const listingId = await insertListing({ companyNorm: 'acme' });
    const appId = await insertApplication(listingId, { state: 'submitted' });
    const fetchFn = fakeFetch([{ id: 'm-idem', subject: 'Thank you for applying', text: 'Thank you for applying to Acme Corp. We have received your application.' }]);
    const r1 = await runMailConfirm({ client, tokenFile: writeToken('confirm-idem1.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r1.outcomes.confirmed, 1);
    const r2 = await runMailConfirm({ client, tokenFile: writeToken('confirm-idem2.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r2.already_processed, 1);
    assert.deepEqual(r2.outcomes, {});
    const app = await client.query('SELECT state FROM ic_job_applications WHERE id = $1', [appId]);
    assert.equal(app.rows[0].state, 'confirmed');
  });

  test('no company match -> no_match, no state change', async () => {
    const listingId = await insertListing({ companyNorm: 'acme' });
    await insertApplication(listingId, { state: 'submitted' });
    const fetchFn = fakeFetch([{ id: 'm-nomatch', subject: 'Thank you for applying', text: 'Thank you for applying to Totally Unrelated Company. We have received your application.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-nomatch.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.no_match, 1);
  });

  test('classifier trap: forwarded "thank you" for a DIFFERENT role at the SAME company is ambiguous, never confirms either application', async () => {
    const listingA = await insertListing({ companyNorm: 'sharedco', title: 'Senior Engineer' });
    const listingB = await insertListing({ companyNorm: 'sharedco', title: 'Product Manager' });
    const appA = await insertApplication(listingA, { state: 'submitted' });
    const appB = await insertApplication(listingB, { state: 'submitted' });
    const fetchFn = fakeFetch([{ id: 'm-ambig-recv', subject: 'Thank you for applying', text: 'Thank you for applying to SharedCo. We have received your application.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-ambig-recv.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.ambiguous_received, 1);
    const a = await client.query('SELECT state FROM ic_job_applications WHERE id = $1', [appA]);
    const b = await client.query('SELECT state FROM ic_job_applications WHERE id = $1', [appB]);
    assert.equal(a.rows[0].state, 'submitted');
    assert.equal(b.rows[0].state, 'submitted');
  });
});

describe('runMailConfirm: rejected/closed -> review queue only, never a state transition (amended decision 2)', () => {
  test('a matched rejection routes the listing to review with reason mail_rejected, and never touches the application state', async () => {
    const listingId = await insertListing({ companyNorm: 'rejectco', status: 'applied' });
    const appId = await insertApplication(listingId, { state: 'submitted' });
    const fetchFn = fakeFetch([{ id: 'm-rej', subject: 'Update', text: 'Thank you for applying to RejectCo. Unfortunately, we have decided to move forward with other candidates.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-rej.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.routed_review, 1);
    const listing = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [listingId]);
    assert.equal(listing.rows[0].status, 'review');
    const app = await client.query('SELECT state FROM ic_job_applications WHERE id = $1', [appId]);
    assert.equal(app.rows[0].state, 'submitted', 'application state is never touched by a rejection mail');
    const q = await client.query('SELECT reason FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [listingId]);
    assert.equal(q.rows[0].reason, 'mail_rejected');
  });

  test('a matched position-closed mail routes to review with reason mail_closed', async () => {
    const listingId = await insertListing({ companyNorm: 'closedco', status: 'applied' });
    await insertApplication(listingId, { state: 'submitted' });
    const fetchFn = fakeFetch([{ id: 'm-closed', subject: 'Update', text: 'The position at ClosedCo has been filled and is no longer accepting applications.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-closed.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.routed_review, 1);
    const q = await client.query('SELECT reason FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [listingId]);
    assert.equal(q.rows[0].reason, 'mail_closed');
  });

  test('rejection pool is submitted UNION confirmed (amended decision 3): a rejection after an earlier confirmation still routes to review', async () => {
    const listingId = await insertListing({ companyNorm: 'lateco', status: 'applied' });
    await insertApplication(listingId, { state: 'confirmed' });
    const fetchFn = fakeFetch([{ id: 'm-late-rej', subject: 'Update', text: 'Thank you for applying to LateCo. Unfortunately, we have decided to move forward with other candidates.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-late-rej.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.routed_review, 1);
  });

  test('classifier trap / amended decision 3: an ambiguous rejection (two candidates, same company) routes BOTH listings to review, naming each other in matches, never a guess', async () => {
    const listingA = await insertListing({ companyNorm: 'dupco', title: 'Role A', status: 'applied' });
    const listingB = await insertListing({ companyNorm: 'dupco', title: 'Role B', status: 'applied' });
    await insertApplication(listingA, { state: 'submitted' });
    await insertApplication(listingB, { state: 'submitted' });
    const fetchFn = fakeFetch([{ id: 'm-ambig-rej', subject: 'Update', text: 'Thank you for applying to DupCo. Unfortunately, we have decided to move forward with other candidates.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-ambig-rej.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.ambiguous_review, 1);
    const qa = await client.query('SELECT reason, matches FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [listingA]);
    const qb = await client.query('SELECT reason, matches FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [listingB]);
    assert.equal(qa.rows[0].reason, 'mail_rejected');
    assert.equal(qb.rows[0].reason, 'mail_rejected');
    assert.ok(qa.rows[0].matches.includes(listingB));
    assert.ok(qb.rows[0].matches.includes(listingA));
    const la = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [listingA]);
    const lb = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [listingB]);
    assert.equal(la.rows[0].status, 'review');
    assert.equal(lb.rows[0].status, 'review');
  });
});

describe('runMailConfirm: crash-safety on the rejected/closed path (review-queue invariant)', () => {
  test('effects already applied but the ledger row is absent (simulated crash): re-running never creates a duplicate open queue row or a duplicate status event', async () => {
    const listingId = await insertListing({ companyNorm: 'crashco', status: 'applied' });
    const appId = await insertApplication(listingId, { state: 'submitted' });
    // Simulate the exact state a crash between routeListingToReview()'s effects committing and
    // ic_gmail_processed_messages' own insert committing would leave behind, BEFORE this PR's fix wrapped
    // both in one transaction: apply the SAME effects routeListingToReview() applies (status flip, one
    // status event, one open review-queue row) directly, but never write the ledger row for the message.
    await client.query(`UPDATE ic_job_listings SET status = 'review' WHERE id = $1`, [listingId]);
    await recordEvent(client, { listingId, kind: 'status', fromStatus: 'applied', toStatus: 'review', note: 'mail_rejected: simulated pre-crash effect', actor: 'apply', runId: null });
    await enqueueReview(client, { runId: null, candidate: null, candidateId: listingId, matches: [], reason: 'mail_rejected', statusAtCreate: 'applied' });

    const fetchFn = fakeFetch([{ id: 'm-crash', subject: 'Update', text: 'Thank you for applying to CrashCo. Unfortunately, we have decided to move forward with other candidates.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-crash.json'), fetch: fetchFn, deps: okDeps });
    // The message is genuinely new to the ledger (never recorded before this run), so the job still
    // processes and reports it as handled -- the point under test is that REPLAYING the underlying
    // effects is a no-op, not that the message gets skipped outright.
    assert.equal(r.outcomes.routed_review, 1);

    const openQueue = await client.query('SELECT id FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [listingId]);
    assert.equal(openQueue.rowCount, 1, 'exactly one open review-queue row for this listing -- the invariant sql/004_review_queue.sql enforces and bin/migrate.js checks');

    const statusEvents = await client.query(`SELECT id FROM ic_job_events WHERE listing_id = $1 AND kind = 'status' AND to_status = 'review'`, [listingId]);
    assert.equal(statusEvents.rowCount, 1, 'exactly one status event (the pre-existing simulated one) -- the replay must not write a second');

    const processed = await client.query('SELECT outcome, application_id FROM ic_gmail_processed_messages WHERE message_id = $1', ['m-crash']);
    assert.equal(processed.rows[0].outcome, 'routed_review');
    assert.equal(Number(processed.rows[0].application_id), appId);
  });
});

describe('runMailConfirm: unknown mail is a total default branch, never a silent pass-through', () => {
  test('an unrelated/contentless mail is recorded with outcome unknown and changes nothing', async () => {
    const listingId = await insertListing({ companyNorm: 'silentco' });
    await insertApplication(listingId, { state: 'submitted' });
    const fetchFn = fakeFetch([{ id: 'm-unk', subject: 'Your application status has changed', text: 'Your application status has changed. Log in to view details.' }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-unk.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.unknown, 1);
    const processed = await client.query('SELECT kind, outcome, application_id FROM ic_gmail_processed_messages WHERE message_id = $1', ['m-unk']);
    assert.equal(processed.rows[0].kind, 'unknown');
    assert.equal(processed.rows[0].application_id, null);
  });
});

describe('runMailConfirm: URL-veto classifier traps end-to-end', () => {
  test('an exact-confidence URL for a DIFFERENT tenant vetoes an otherwise-plausible company-text match', async () => {
    const listingId = await insertListing({ companyNorm: 'vetoco' });
    await insertApplication(listingId, { state: 'submitted', applyUrl: 'https://boards.greenhouse.io/vetoco/jobs/111' });
    const fetchFn = fakeFetch([{
      id: 'm-veto', subject: 'Thank you for applying',
      text: 'Thank you for applying to VetoCo. We have received your application. Details: https://boards.greenhouse.io/othertenant/jobs/222',
    }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-veto.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.no_match, 1, 'the contradicting URL must veto the company-text match');
  });

  test('a spoofed host (greenhouse.io.example.com) inside the mail body never falsely vetoes a real match', async () => {
    const listingId = await insertListing({ companyNorm: 'spoofco' });
    const appId = await insertApplication(listingId, { state: 'submitted', applyUrl: 'https://boards.greenhouse.io/spoofco/jobs/333' });
    const fetchFn = fakeFetch([{
      id: 'm-spoof', subject: 'Thank you for applying',
      text: 'Thank you for applying to SpoofCo. We have received your application. Tracking: https://boards.greenhouse.io.example.com/spoofco/jobs/333',
    }]);
    const r = await runMailConfirm({ client, tokenFile: writeToken('confirm-spoof.json'), fetch: fetchFn, deps: okDeps });
    assert.equal(r.outcomes.confirmed, 1);
    const app = await client.query('SELECT state FROM ic_job_applications WHERE id = $1', [appId]);
    assert.equal(app.rows[0].state, 'confirmed');
  });
});
