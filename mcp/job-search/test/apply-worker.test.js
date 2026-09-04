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
import { runApplyWorker, preSubmitExclusionRecheck, LOCK_KEY as APPLY_LOCK_KEY } from '../src/apply/worker.js';
import { ADAPTERS } from '../src/apply/adapters/index.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';

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

/** baseDeps()'s default apply-exclusion-gate bypass (see its own doc comment): performs the SAME
 * approved -> submitting transition the real preSubmitExclusionRecheck always performs first, but skips
 * the exclusion classification entirely, so the worker's own subsequent state machine (submitting ->
 * submitted/needs_human/failed) is completely unaffected by this file's shared fixtures. */
async function alwaysEligible(client, app) {
  await transition(client, app.id, 'submitting', { actor: 'apply', note: 'worker started' });
  return { branch: 'eligible', reason: 'test bypass', evidence: {} };
}

function baseDeps(extra = {}) {
  return {
    config: loadConfig(),
    lookup: dnsLookup,
    connectDedicated: freshClient,
    connectSession: async () => fakeSession(),
    log: () => {},
    progress: () => {},
    // This file's OTHER describe blocks all share the literal 'apply worker test co' / 'apply worker
    // test' company/title fixture across many test cases in the SAME run (seedApprovedApplication()
    // above) -- the apply exclusion gate's own "already applied elsewhere with this company+title" DB
    // lookup (src/apply/exclusions.js's classifyExclusion, branch c) would otherwise see an EARLIER
    // sibling test's own non-withdrawn application and incorrectly block this one. Bypassed by default
    // here; the "apply exclusion gate" describe block below explicitly restores the real function (and
    // uses its own unique-per-test fixtures) to test the gate itself.
    preSubmitExclusionRecheck: alwaysEligible,
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
    // 'unknown' is the one ATS_TYPES value that will never get a registered adapter (it is
    // classifyApplyUrl()'s own default branch for a URL this codebase does not recognize at all) -- icims
    // and dayforce both got adapters in slice 8 (see the "adapter registry" describe block below), so this
    // test no longer uses either of them.
    const id = await seedApprovedApplication({ atsType: 'unknown', applyUrl: 'https://totally-unrecognized.example.com/x' });
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

describe('runApplyWorker: icims and dayforce are registered adapters (apply pipeline slice 8)', () => {
  test('the default ADAPTERS registry has icims and dayforce entries with a run() function', () => {
    assert.equal(typeof ADAPTERS.icims?.run, 'function');
    assert.equal(typeof ADAPTERS.dayforce?.run, 'function');
  });

  /**
   * A fake page whose waitForSelector always misses -- every cap.waitFor(..., {optional:true}) call
   * resolves to null, so the real icims/dayforce adapter's very first probe fails to find its own page
   * shape and parks with kind 'unrecognized_page'. The point of this test is NOT to exercise the real
   * selectors (see each adapter's own KNOWN LIMITATION doc comment) -- it is to prove the worker's total
   * `adapterRegistry[app.ats_type]` lookup now finds a real adapter for these two ATSs and actually calls
   * it, rather than falling into the "no automated adapter for this ATS yet" branch this test used to
   * cover before slice 8 registered them (see the "unsupported ATS" test above, now using 'unknown').
   */
  function fakePageNothingFound() {
    return {
      async goto() {},
      async waitForSelector() { throw new Error('no such element in this fake DOM'); },
      async $eval() { return null; },
      async $$eval() { return []; },
      async fill() {},
      async click() {},
      async selectOption() {},
      async setInputFiles() { return null; },
      async screenshot() { return Buffer.from(''); },
    };
  }

  function fakeSessionNothingFound() {
    return {
      attachPage: async () => fakePageNothingFound(),
      reconcile: async () => 0,
      reconcileTargets: async () => ({ attempted: 0, closed: 0 }),
      writeTargetMarker: async () => {},
      closeAll: async () => {},
      openPages: () => 0,
    };
  }

  test('ats_type "icims" reaches the real icims adapter -- parks unrecognized_page, never unsupported_ats', async () => {
    const id = await seedApprovedApplication({ atsType: 'icims', applyUrl: 'https://acme.icims.com/jobs/1/apply' });
    const result = await runApplyWorker(id, baseDeps({ connectSession: async () => fakeSessionNothingFound() }));
    assert.equal(result.status, 'needs_human');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.pending_question.kind, 'unrecognized_page');
    assert.notEqual(row.pending_question.kind, 'unsupported_ats');
  });

  test('ats_type "dayforce" reaches the real dayforce adapter -- parks unrecognized_page, never unsupported_ats', async () => {
    const id = await seedApprovedApplication({ atsType: 'dayforce', applyUrl: 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/1' });
    const result = await runApplyWorker(id, baseDeps({ connectSession: async () => fakeSessionNothingFound() }));
    assert.equal(result.status, 'needs_human');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.pending_question.kind, 'unrecognized_page');
    assert.notEqual(row.pending_question.kind, 'unsupported_ats');
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

describe('runApplyWorker: one-click apply PR A spec item 3 -- effective bank salary_floor override', () => {
  /** A fake AnswerBank matching src/apply/answers.js's parseAnswerBank() shape: facts is a Map, meta
   * carries the bank's own (personal-data) salary_floor. */
  function fakeBank(bankSalaryFloor) {
    return { facts: new Map(), labels: new Map(), meta: { salary_floor: bankSalaryFloor } };
  }

  /** @param {any} probeBank captures ctx.answers.bank as seen by the adapter */
  function probeAdapter(seen) {
    return {
      ats: 'greenhouse', requires: [], classifyOnly: false, uploadHosts: [],
      async run(cap, ctx) {
        seen.bank = ctx.answers.bank;
        return { outcome: 'needs_human', pendingQuestion: { kind: 'salary_floor_probe', label: String(ctx.answers.bank.meta.salary_floor) } };
      },
    };
  }

  test('the application\'s own salary_floor wins over the shared bank\'s meta.salary_floor', async () => {
    const id = await seedApprovedApplication({ atsType: 'greenhouse' });
    await verifyClient.query('UPDATE ic_job_applications SET salary_floor = $2 WHERE id = $1', [id, 250000]);
    const seen = {};
    const result = await runApplyWorker(id, baseDeps({ adapters: { greenhouse: probeAdapter(seen) }, answerBank: fakeBank(150000) }));
    assert.equal(result.status, 'needs_human');
    assert.equal(seen.bank.meta.salary_floor, 250000, 'the application-level floor (250000) must win over the bank file\'s own value (150000)');
  });

  test('falls back to the bank\'s own meta.salary_floor when the application has none recorded', async () => {
    const id = await seedApprovedApplication({ atsType: 'greenhouse' });
    await verifyClient.query('UPDATE ic_job_applications SET salary_floor = NULL WHERE id = $1', [id]);
    const seen = {};
    const result = await runApplyWorker(id, baseDeps({ adapters: { greenhouse: probeAdapter(seen) }, answerBank: fakeBank(150000) }));
    assert.equal(result.status, 'needs_human');
    assert.equal(seen.bank.meta.salary_floor, 150000);
  });

  test('the effective bank never mutates the shared answerBank object passed in (a spread copy, not an in-place set)', async () => {
    const id = await seedApprovedApplication({ atsType: 'greenhouse' });
    await verifyClient.query('UPDATE ic_job_applications SET salary_floor = $2 WHERE id = $1', [id, 999999]);
    const sharedBank = fakeBank(150000);
    const seen = {};
    await runApplyWorker(id, baseDeps({ adapters: { greenhouse: probeAdapter(seen) }, answerBank: sharedBank }));
    assert.equal(sharedBank.meta.salary_floor, 150000, 'the ORIGINAL bank object passed by the caller is untouched -- a second application sharing it must see its own floor, not a leaked one');
  });
});

describe('apply exclusion gate: pre-submit recheck (worker.js\'s own transition to submitting)', () => {
  const EXCL_CFG = { blockedCompanies: [...BUILT_IN_BLOCKED], appliedHistory: [] };

  /** Unlike seedApprovedApplication() (shared 'apply worker test co' / 'apply worker test' fixture reused
   * by every OTHER describe block in this file), this describe block's own classifyExclusion branch c/d
   * checks look across ALL listings sharing a company+title -- so each test here needs its own unique
   * company_norm/title_norm to avoid colliding with sibling tests' own non-withdrawn applications. */
  async function seedApprovedApplicationUnique() {
    const n = Math.floor(Math.random() * 1e9);
    // Single-token, non-dictionary strings (no shared words like "test"/"co"/"apply") -- branch c/d's
    // company match is a BIDIRECTIONAL subset check, so any fixture built from common words risks a false
    // match against some other test file's own listing sharing one of those words as its entire
    // company_norm. A random single token can never be a subset of, or a superset containing, anything
    // else already in this shared test database.
    const companyNorm = `zzexclworkerco${n}`;
    const titleNorm = `zzexclworkerrole${n}`;
    const r = await verifyClient.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
       VALUES ('Apply Worker Excl Test', $1, $2, $3, 'listing', $4, $5, 'legacy-unknown', $6, now()) RETURNING id`,
      [CO, `zz-test-applyworker-excl-${process.pid}`, `zz-test-applyworker-excl-${process.pid}:${n}`, companyNorm, titleNorm, `zz-applyworker-excl-hash-${n}`],
    );
    const listingId = Number(r.rows[0].id);
    listingIds.push(listingId);
    const created = await createApplication(verifyClient, { listingId, atsType: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/12345', actor: 'mcp' });
    await transition(verifyClient, created.id, 'docs_ready', { actor: 'dashboard' });
    await verifyClient.query(`UPDATE ic_job_applications SET state = 'approved' WHERE id = $1`, [created.id]);
    return created.id;
  }

  test('eligible: preSubmitExclusionRecheck transitions approved -> submitting and excludes its OWN row', async () => {
    const id = await seedApprovedApplicationUnique();
    const app = await getApplication(verifyClient, id);
    const verdict = await preSubmitExclusionRecheck(verifyClient, app, EXCL_CFG, { actor: 'apply' });
    assert.equal(verdict.branch, 'eligible');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'submitting');
  });

  test('a race: a DIFFERENT application appears on a duplicate listing between select and submit -> aborts to needs_human', async () => {
    const id = await seedApprovedApplicationUnique();
    const app = await getApplication(verifyClient, id);
    // Simulate the race: after this application was approved, a second listing sharing its dedup root
    // picked up its own non-withdrawn application (e.g. a duplicate discovered by a later scan, applied to
    // through a completely different path).
    const n = Math.floor(Math.random() * 1e9);
    const dupRes = await verifyClient.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, duplicate_of)
       VALUES ('Apply Worker Test Dup', $1, $2, $3, 'listing', 'zz-race-dup-company', 'zz-race-dup-title', 'legacy-unknown', $4, now(), $5) RETURNING id`,
      [CO, `zz-test-applyworker-dup-${process.pid}`, `zz-test-applyworker-dup-${process.pid}:${n}`, `zz-applyworker-dup-hash-${n}`, app.listing_id],
    );
    const dupListingId = Number(dupRes.rows[0].id);
    listingIds.push(dupListingId);
    await createApplication(verifyClient, { listingId: dupListingId, actor: 'mcp' });

    const verdict = await preSubmitExclusionRecheck(verifyClient, app, EXCL_CFG, { actor: 'apply' });
    assert.equal(verdict.branch, 'already_applied_listing');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'apply_exclusion');
  });

  test('runApplyWorker end to end: the pre-submit recheck blocks BEFORE the adapter ever runs', async () => {
    const id = await seedApprovedApplicationUnique();
    const app = await getApplication(verifyClient, id);
    const n = Math.floor(Math.random() * 1e9);
    const dupRes = await verifyClient.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, duplicate_of)
       VALUES ('Apply Worker Test Dup2', $1, $2, $3, 'listing', 'zz-race-dup2-company', 'zz-race-dup2-title', 'legacy-unknown', $4, now(), $5) RETURNING id`,
      [CO, `zz-test-applyworker-dup2-${process.pid}`, `zz-test-applyworker-dup2-${process.pid}:${n}`, `zz-applyworker-dup2-hash-${n}`, app.listing_id],
    );
    const dupListingId = Number(dupRes.rows[0].id);
    listingIds.push(dupListingId);
    await createApplication(verifyClient, { listingId: dupListingId, actor: 'mcp' });

    let adapterRan = false;
    const fakeAdapters = { greenhouse: { ats: 'greenhouse', requires: [], classifyOnly: false, uploadHosts: [], async run() { adapterRan = true; return { outcome: 'submitted', confirmationRef: 'should-never-happen' }; } } };
    // Restores the REAL gate for this one test (baseDeps() bypasses it by default -- see its own doc
    // comment); this test's own fixture is unique-per-run (seedApprovedApplicationUnique above) so the
    // real gate's DB-wide lookups are safe here.
    const result = await runApplyWorker(id, baseDeps({ adapters: fakeAdapters, exclusionConfig: EXCL_CFG, preSubmitExclusionRecheck }));
    assert.equal(result.status, 'needs_human');
    assert.equal(adapterRan, false, 'the adapter must never run once the pre-submit recheck aborts');
    const row = await getApplication(verifyClient, id);
    assert.equal(row.state, 'needs_human');
  });
});
