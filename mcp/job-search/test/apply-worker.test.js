// @ts-check
/**
 * src/apply/worker.js (apply pipeline slice 5): totality (unknown page/unsupported ATS -> needs_human,
 * adapter throw -> failed, an unrecognized adapter outcome shape -> failed, never an assumed-ok path),
 * the submit_request_sent ordering guarantee (abort/crash after it -> needs_human, never failed),
 * classify-only adapters never touching the browser, the document-drift guard, the advisory LOCK_KEY
 * value (must equal scan's own), and single-flight lock contention. Runs against the real isolated test
 * DB for the application row itself (src/core/applications.js has no fake-friendly seam); the browser
 * session and adapters are fully faked -- no real Chrome, no network beyond the DNS stub every guardUrl
 * call needs.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, transition, getApplication, approve } from '../src/core/applications.js';
import { LOCK_KEY as SCAN_LOCK_KEY } from '../src/core/scan-run.js';
import { runApplyWorker, LOCK_KEY as APPLY_LOCK_KEY } from '../src/apply/worker.js';

const CO = `ZZ-TEST-APPLYWORKER-${process.pid}`;
/** @type {pg.Client} */
let verifyClient;
/** @type {number[]} */
const listingIds = [];

async function freshClient() {
  const c = new pg.Client(pgConnectionConfig());
  await c.connect();
  return c;
}

/** @param {Partial<{ atsType: string, applyUrl: string }>} o */
async function seedApprovedApplication(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Apply Worker Test', $1, $2, $3, 'listing', 'apply worker test co', 'apply worker test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-applyworker-${process.pid}`, `zz-test-applyworker-${process.pid}:${n}`, `zz-applyworker-hash-${n}`],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const created = await createApplication(verifyClient, { listingId, atsType: o.atsType ?? 'greenhouse', applyUrl: o.applyUrl ?? 'https://boards.greenhouse.io/acme/jobs/12345', actor: 'mcp' });
  await transition(verifyClient, created.id, 'docs_ready', { actor: 'dashboard' });
  await verifyClient.query(`UPDATE ic_job_applications SET state = 'approved' WHERE id = $1`, [created.id]);
  return created.id;
}

async function cleanup() {
  if (listingIds.length === 0) return;
  // Apply pipeline slice 7: markSubmitted() (called internally by the worker when an adapter reports
  // 'submitted') now also creates a followup row (created_from = 'apply-nudge:<id>') for the listing --
  // must be deleted before the listing itself or the FK (ic_followups_listing_id_fkey) blocks the delete.
  await verifyClient.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  verifyClient = new pg.Client(pgConnectionConfig());
  await verifyClient.connect();
  await ensureAuxSchema(verifyClient);
  await cleanup();
});
after(async () => {
  await cleanup();
  await verifyClient.end();
});

const dnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeSession() {
  return {
    attachPage: async () => ({ goto: async () => {} }),
    reconcile: async () => 0,
    reconcileTargets: async () => ({ attempted: 0, closed: 0 }),
    writeTargetMarker: async () => {},
    closeAll: async () => {},
    openPages: () => 0,
  };
}

function baseDeps(extra = {}) {
  return {
    config: loadConfig(),
    lookup: dnsLookup,
    connectDedicated: freshClient,
    connectSession: async () => fakeSession(),
    log: () => {},
    progress: () => {},
    ...extra,
  };
}

describe('LOCK_KEY', () => {
  test('equals the scan-run LOCK_KEY verbatim (scans and applies serialize on the same key)', () => {
    assert.equal(APPLY_LOCK_KEY, 730193001);
    assert.equal(APPLY_LOCK_KEY, SCAN_LOCK_KEY);
  });
});

describe('runApplyWorker: totality', () => {
  test('an application not currently "approved" is skipped, never touched', async () => {
    const listingId = (async () => {
      const n = Math.floor(Math.random() * 1e9);
      const r = await verifyClient.query(
        `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
         VALUES ('x', $1, $2, $3, 'listing', 'x', 'x', 'legacy-unknown', $4, now()) RETURNING id`,
        [CO, `zz-test-applyworker-skip-${process.pid}`, `zz-test-applyworker-skip-${process.pid}:${n}`, `zz-applyworker-skip-hash-${n}`],
      );
      return Number(r.rows[0].id);
    })();
    const lId = await listingId;
    listingIds.push(lId);
    const created = await createApplication(verifyClient, { listingId: lId, actor: 'mcp' });
    const result = await runApplyWorker(created.id, baseDeps());
    assert.equal(result.status, 'skipped');
    const row = await getApplication(verifyClient, created.id);
    assert.equal(row.state, 'drafting', 'a non-approved application must never be transitioned by the worker');
  });

  test('an unsupported ATS (no registered adapter) parks in needs_human, never touches the browser session', async () => {
    // icims has no registered adapter as of slice 6 (workday now does -- see test/workday-adapter.test.js
    // and the worker-level workday coverage below, which is why this test no longer uses workday itself).
    const id = await seedApprovedApplication({ atsType: 'icims', applyUrl: 'https://acme.icims.com/jobs/1/apply' });
    let sessionTouched = false;
    const result = await runApplyWorker(id, baseDeps({ connectSession: async () => { sessionTouched = true; return fakeSession(); } }));
    assert.equal(result.status, 'needs_human');
    assert.equal(sessionTouched, false);
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'unsupported_ats');
  });

  test('a classify-only adapter (indeed_easy/linkedin_easy stub) parks in needs_human without ever touching the browser', async () => {
    const id = await seedApprovedApplication({ atsType: 'indeed_easy', applyUrl: 'https://apply.indeed.com/x' });
    let sessionTouched = false;
    const result = await runApplyWorker(id, baseDeps({ connectSession: async () => { sessionTouched = true; return fakeSession(); } }));
    assert.equal(result.status, 'needs_human');
    assert.equal(sessionTouched, false);
    const row = await getApplication(verifyClient, id);
    assert.equal(row.pending_question.kind, 'not_automated');
  });

  test('an adapter that throws (no submit_request_sent recorded) fails the application, never assumes ok', async () => {
    const id = await seedApprovedApplication();
    const fakeAdapters = { greenhouse: { ats: 'greenhouse', requires: [], classifyOnly: false, uploadHosts: [], async run() { throw new Error('adapter blew up'); } } };
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters }));
    assert.equal(result.status, 'failed');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'failed');
    assert.match(row.error, /adapter blew up/);
  });

  test('an adapter that returns an unrecognized outcome shape fails the application, never assumes ok', async () => {
    const id = await seedApprovedApplication();
    const fakeAdapters = { greenhouse: { ats: 'greenhouse', requires: [], classifyOnly: false, uploadHosts: [], async run() { return { outcome: 'something_else' }; } } };
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters }));
    assert.equal(result.status, 'failed');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'failed');
  });

  test('an adapter reporting needs_human parks with the exact pendingQuestion it returned', async () => {
    const id = await seedApprovedApplication();
    const fakeAdapters = { greenhouse: { ats: 'greenhouse', requires: [], classifyOnly: false, uploadHosts: [], async run() { return { outcome: 'needs_human', pendingQuestion: { kind: 'question', label: 'What is your favorite color?' } }; } } };
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters }));
    assert.equal(result.status, 'needs_human');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.pending_question.kind, 'question');
    assert.equal(row.pending_question.label, 'What is your favorite color?');
  });

  test('an adapter reporting submitted transitions through markSubmitted (listing status flips to applied)', async () => {
    const id = await seedApprovedApplication();
    const fakeAdapters = { greenhouse: { ats: 'greenhouse', requires: [], classifyOnly: false, uploadHosts: [], async run() { return { outcome: 'submitted', confirmationRef: 'conf-123' }; } } };
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters }));
    assert.equal(result.status, 'submitted');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'submitted');
    assert.equal(row.confirmation_ref, 'conf-123');
  });

  test('SUBMIT_REQUEST_SENT ORDERING: an adapter that records submit_request_sent then throws parks in needs_human, NEVER failed (duplicate-application guard)', async () => {
    const id = await seedApprovedApplication();
    const fakeAdapters = {
      greenhouse: {
        ats: 'greenhouse', requires: [], classifyOnly: false, uploadHosts: [],
        async run(cap, ctx) {
          await ctx.recordSubmitRequestSent();
          throw new Error('crash right after the submit click');
        },
      },
    };
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters }));
    assert.equal(result.status, 'needs_human');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'post_submit_uncertain');
  });

  test('document-drift guard: a resume_hash mismatch parks in needs_human before ever attaching a page', async () => {
    const id = await seedApprovedApplication();
    await verifyClient.query(`UPDATE ic_job_applications SET resume_hash = 'stale-hash-that-will-never-match' WHERE id = $1`, [id]);
    let sessionTouched = false;
    const result = await runApplyWorker(id, baseDeps({ connectSession: async () => { sessionTouched = true; return fakeSession(); } }));
    assert.equal(result.status, 'needs_human');
    assert.equal(sessionTouched, false, 'a document-drift application must never reach the browser');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.pending_question.kind, 'document_drift');
  });

  test('lock contention: a concurrent holder of the same advisory lock makes the worker report locked, never touching the row', async () => {
    const id = await seedApprovedApplication();
    const lockHolder = await freshClient();
    await lockHolder.query('SELECT pg_advisory_lock($1::bigint)', [APPLY_LOCK_KEY]);
    try {
      const result = await runApplyWorker(id, baseDeps());
      assert.equal(result.status, 'locked');
      const row = await getApplication(verifyClient, id);
      assert.equal(row.state, 'approved', 'a locked-out worker run must never touch the application row');
    } finally {
      await lockHolder.query('SELECT pg_advisory_unlock($1::bigint)', [APPLY_LOCK_KEY]);
      await lockHolder.end();
    }
  });
});

describe('runApplyWorker: apply pipeline slice 6 ctx wiring (credentials, gmailVerify, sleep)', () => {
  test('ctx.credentials is tenant-scoped to the application\'s own apply_url host; generatePassword and target pass through from deps.credentials', async () => {
    const id = await seedApprovedApplication({ atsType: 'workday', applyUrl: 'https://acme.wd5.myworkdayjobs.com/careers/job/1' });
    /** @type {any[]} */
    const credCalls = [];
    const fakeCredentials = {
      read: async (/** @type {string} */ tenantHost) => { credCalls.push(['read', tenantHost]); return null; },
      write: async (/** @type {string} */ tenantHost, /** @type {string} */ username, /** @type {string} */ password) => { credCalls.push(['write', tenantHost, username, password]); },
      generatePassword: () => 'zz-worker-level-generated-password',
    };
    /** @type {any} */
    let seenCtx = null;
    const fakeAdapters = {
      workday: {
        ats: 'workday', requires: ['credential'], classifyOnly: false, uploadHosts: [],
        async run(cap, ctx) {
          seenCtx = ctx;
          await ctx.credentials.read();
          await ctx.credentials.write('someone@example.com', ctx.credentials.generatePassword());
          return { outcome: 'needs_human', pendingQuestion: { kind: 'credential', target: ctx.credentials.target, username: 'someone@example.com' } };
        },
      },
    };
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters, credentials: fakeCredentials }));
    assert.equal(result.status, 'needs_human');
    assert.equal(credCalls[0][0], 'read');
    assert.equal(credCalls[0][1], 'acme.wd5.myworkdayjobs.com', 'read is scoped to the apply_url host, never a caller-supplied host');
    assert.equal(credCalls[1][0], 'write');
    assert.equal(credCalls[1][1], 'acme.wd5.myworkdayjobs.com');
    assert.equal(credCalls[1][3], 'zz-worker-level-generated-password', 'ctx.credentials.generatePassword is the SAME function deps.credentials.generatePassword provided');
    assert.equal(seenCtx.credentials.target, 'ic-jobsearch/acme.wd5.myworkdayjobs.com');
  });

  test('ctx.gmailVerify and ctx.sleep are threaded from deps into ctx, gmailVerify auto-scoped to the tenant host', async () => {
    const id = await seedApprovedApplication({ atsType: 'workday', applyUrl: 'https://acme.wd5.myworkdayjobs.com/careers/job/1' });
    /** @type {any[]} */
    const gmailCalls = [];
    const fakeGmailVerify = async (/** @type {{ tenantHost: string, sentAfter: Date }} */ o) => { gmailCalls.push(o); return { ok: true, code: '000000', link: null }; };
    /** @type {any[]} */
    const sleepCalls = [];
    const fakeSleep = async (/** @type {number} */ ms) => { sleepCalls.push(ms); };
    const fakeAdapters = {
      workday: {
        ats: 'workday', requires: ['credential'], classifyOnly: false, uploadHosts: [],
        async run(cap, ctx) {
          await ctx.gmailVerify({ sentAfter: new Date('2026-09-01T00:00:00Z') });
          await ctx.sleep(1234);
          return { outcome: 'needs_human', pendingQuestion: { kind: 'email_verification', label: 'test probe' } };
        },
      },
    };
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters, gmailVerify: fakeGmailVerify, sleep: fakeSleep, credentials: { read: async () => null, write: async () => {}, generatePassword: () => 'x' } }));
    assert.equal(result.status, 'needs_human');
    assert.equal(gmailCalls.length, 1);
    assert.equal(gmailCalls[0].tenantHost, 'acme.wd5.myworkdayjobs.com', 'the worker fills in tenantHost -- the adapter never has to pass it itself');
    assert.equal(sleepCalls[0], 1234);
  });
});
