// @ts-check
/**
 * POST /api/listings/:id/apply-now (one-click apply PR A spec item 7): create-or-reuse the drafting
 * application, 202 immediately, then the async runApplyNowChain (resume -> review -> approve -> apply).
 * Same createDashboardServer-against-real-test-DB pattern as test/dashboard-applications-route-slice5.test.js,
 * with fake resumeRunner/reviewRunner/applyRunner so the chain's own branching is directly observable
 * without a real headless claude process.
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createCalendarCache } from '../src/dashboard/calendar-cache.js';
import { createApplication, getApplication, transition, listApplicationEvents } from '../src/core/applications.js';
import { STALE_ACTIONABLE_MS } from '../src/dashboard/routes/applications.js';
import { applyExclusionGate as realApplyExclusionGate } from '../src/dashboard/routes/applications.js';
import { humanizeParkReason } from '../src/apply/resume-gate.js';
import { JobSearchError } from '../src/core/errors.js';

const CO = `ZZ-TEST-APPLYNOW-${process.pid}`;
/** @type {any} the dashboard's own deps object, hoisted so a later describe block can temporarily swap
 *  `applyExclusionGate` back to the real gate for its own tests, then restore the bypass. */
let deps;
/** @type {pg.Client} */
let verifyClient;
/** @type {string} */
let outputRoot;
/** @type {number} */
let port;
/** @type {ReturnType<typeof createDashboardServer>} */
let app;
/** @type {number[]} */
const listingIds = [];
/** @type {{ run: any[] }} */
let resumeRunnerCalls;
/** @type {{ run: any[] }} */
let reviewRunnerCalls;
/** @type {number[]} */
let applyRunnerStartCalls;
/** @type {(applicationId: number, listingId: number) => Promise<{ok:boolean,reason?:string,markdownPath?:string}>} */
let resumeRunnerImpl;
/** @type {(applicationId: number, markdownPath: string, listingId: number) => Promise<{ok:boolean,verdict?:string,reason?:string}>} */
let reviewRunnerImpl;

function makeStubScanRunner() {
  return { async start() { return { runId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } };
}
function makeFakeApplyRunner() {
  return {
    async start(applicationId) { applyRunnerStartCalls.push(Number(applicationId)); return { applicationId, pid: 1 }; },
    status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; },
  };
}
function makeFakeResumeRunner() {
  return { async run(applicationId, listingId) { resumeRunnerCalls.push([applicationId, listingId]); return resumeRunnerImpl(applicationId, listingId); }, status() { return { running: false }; } };
}
function makeFakeReviewRunner() {
  return { async run(applicationId, markdownPath, listingId) { reviewRunnerCalls.push([applicationId, markdownPath, listingId]); return reviewRunnerImpl(applicationId, markdownPath, listingId); }, status() { return { running: false }; } };
}

async function seedListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await verifyClient.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Apply Now Test', $1, $2, $3, 'listing', 'apply now test co', 'apply now test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-applynow-${process.pid}`, `zz-test-applynow-${process.pid}:${n}`, `zz-applynow-hash-${n}`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await verifyClient.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await verifyClient.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  verifyClient = new pg.Client(pgConnectionConfig());
  await verifyClient.connect();
  await ensureAuxSchema(verifyClient);
  await cleanup();

  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-applynow-output-'));
  for (const dir of ['resumes', 'coverletters', 'cheatsheets', 'markdown', 'research', 'reports', 'applications']) {
    fs.mkdirSync(path.join(outputRoot, dir), { recursive: true });
  }

  deps = {
    withClient,
    config: loadConfig(),
    env: {
      OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'test-model',
      GOOGLE_TOKEN_FILE: '', REMINDER_TO: '',
      SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null,
      JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null,
    },
    calendar: async () => null,
    calendarCache: createCalendarCache(),
    scanRunner: makeStubScanRunner(),
    applyRunner: makeFakeApplyRunner(),
    resumeRunner: makeFakeResumeRunner(),
    reviewRunner: makeFakeReviewRunner(),
    credentials: { read: async () => null, write: async () => {}, delete: async () => false, list: async () => [] },
    outputRoot,
    version: 'test',
    startedAt: new Date().toISOString(),
    healthBanner: [],
    // This file's other tests share a single 'Apply Now Test' / 'apply now test co' listing fixture
    // (seedListing() below) across many test cases in one run -- the apply exclusion gate's own
    // cross-listing "already applied elsewhere with this company+title" DB lookup would otherwise see an
    // EARLIER sibling test's own non-withdrawn application and incorrectly block this one. Bypassed by
    // default; the "apply exclusion gate" describe block further down restores the real gate (imported as
    // realApplyExclusionGate) with its own unique-per-test fixtures to test the gate itself.
    applyExclusionGate: async () => false,
  };
  app = createDashboardServer(/** @type {any} */ (deps));
  await app.listen(0, '127.0.0.1');
  port = /** @type {any} */ (app.server.address()).port;
});

after(async () => {
  await cleanup();
  await verifyClient.end();
  await app.close();
  await closePool();
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resumeRunnerCalls = [];
  reviewRunnerCalls = [];
  applyRunnerStartCalls = [];
  // The fake resumeRunner's default behavior performs the SAME database side effect the real
  // src/dashboard/resume-runner.js produces on success (docs_ready + a linked, on-disk resume document) --
  // approve() (called by the chain on VERDICT: PASS) requires exactly that state, and this route test's
  // job is the CHAIN's own branching, not re-proving resume-runner.js's own internals (covered by
  // test/resume-runner.test.js instead).
  resumeRunnerImpl = async (applicationId, listingId) => {
    const relPath = `resumes/apply-now-${applicationId}.docx`;
    fs.writeFileSync(path.join(outputRoot, relPath), 'fake docx bytes');
    const docRes = await verifyClient.query(
      `INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`,
      [listingId, relPath],
    );
    await verifyClient.query('UPDATE ic_job_applications SET state = $2, resume_doc_id = $3, updated_at = now() WHERE id = $1', [applicationId, 'docs_ready', docRes.rows[0].id]);
    return { ok: true, markdownPath: 'output/markdown/x.md' };
  };
  reviewRunnerImpl = async () => ({ ok: true, verdict: 'PASS' });
});

/** @param {string} method @param {string} p @param {{ body?: unknown }} [opts] */
async function req(method, p, opts = {}) {
  const isMutating = method.toUpperCase() !== 'GET';
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: isMutating ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, json, buf };
}

/** Poll until the application reaches one of `states`, or timeout. Used to observe the async chain
 * without the route itself blocking on it. */
async function waitForState(applicationId, states, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getApplication(verifyClient, applicationId);
    if (states.includes(row.state)) return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('POST /api/listings/:id/apply-now: happy path', () => {
  test('creates a drafting application, returns 202 immediately, then chains resume -> review -> approve -> apply', async () => {
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 202);
    assert.ok(r.json.application_id);
    const appId = r.json.application_id;

    const finalRow = await waitForState(appId, ['approved']);
    assert.equal(finalRow.state, 'approved');
    assert.deepEqual(resumeRunnerCalls, [[appId, listingId]]);
    assert.deepEqual(reviewRunnerCalls, [[appId, 'output/markdown/x.md', listingId]]);
    assert.deepEqual(applyRunnerStartCalls, [appId]);

    const events = await listApplicationEvents(verifyClient, appId);
    const progressNotes = events.filter((e) => e.kind === 'progress').map((e) => e.note);
    assert.ok(progressNotes.some((n) => /drafting resume/.test(n ?? '')));
    assert.ok(progressNotes.some((n) => /reviewing/.test(n ?? '')));
    assert.ok(progressNotes.some((n) => /approving/.test(n ?? '')));
  });
});

describe('POST /api/listings/:id/apply-now: apply-chain-park fix -- resume-runner failure parks to needs_human', () => {
  test('a thin-description precheck failure stops the chain before review/approve and parks the application', async () => {
    resumeRunnerImpl = async () => ({ ok: false, reason: 'no_description' });
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const row = await waitForState(appId, ['needs_human']);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.error, 'no_description');
    assert.equal(row.pending_question?.kind, 'resume_failed');
    assert.ok(row.pending_question?.label, 'pending_question.label must be a human-readable string');
    assert.deepEqual(reviewRunnerCalls, []);
    assert.deepEqual(applyRunnerStartCalls, []);

    const events = await listApplicationEvents(verifyClient, appId);
    assert.ok(events.some((e) => e.kind === 'state' && e.to_state === 'needs_human'), 'a state-transition event to needs_human must be recorded');
  });

  test('a missing resumeRunner/reviewRunner also parks to needs_human, with reason "runner_unavailable"', async () => {
    const savedResumeRunner = deps.resumeRunner;
    deps.resumeRunner = undefined;
    try {
      const listingId = await seedListing();
      const r = await req('POST', `/api/listings/${listingId}/apply-now`);
      const appId = r.json.application_id;
      const row = await waitForState(appId, ['needs_human']);
      assert.equal(row.state, 'needs_human');
      assert.equal(row.error, 'runner_unavailable');
      assert.equal(row.pending_question?.kind, 'resume_failed');
      assert.deepEqual(resumeRunnerCalls, []);
    } finally {
      deps.resumeRunner = savedResumeRunner;
    }
  });

  test('parking an application already moved on to needs_human by another actor is a benign no-op, not a chain failure', async () => {
    // Simulates the race the park's own try/catch guards against: something else already transitioned the
    // application to needs_human (with its OWN pending_question) before this resume-runner failure's own
    // park attempt runs. The original pending_question must survive untouched, and no
    // "apply_now_chain_failed" error event should appear -- the VALIDATION rejection from the second,
    // now-illegal drafting->needs_human transition must be swallowed as an expected race, not surfaced as
    // an unexpected chain failure.
    resumeRunnerImpl = async (applicationId) => {
      await transition(verifyClient, applicationId, 'needs_human', {
        actor: 'apply', pending_question: { kind: 'question', label: 'an earlier, unrelated park' },
      });
      return { ok: false, reason: 'no_description' };
    };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const row = await getApplication(verifyClient, appId);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question?.kind, 'question');
    assert.equal(row.pending_question?.label, 'an earlier, unrelated park');

    const events = await listApplicationEvents(verifyClient, appId);
    assert.ok(!events.some((e) => e.kind === 'error' && e.note === 'one-click apply chain failed unexpectedly'), 'the swallowed park race must never surface as a chain failure event');
  });
});

describe('POST /api/listings/:id/apply-now: per-application chain lock (apply-chain-park fix, spec item 2)', () => {
  test('a second click while the first click\'s chain is still running never starts a second chain', async () => {
    /** @type {() => void} */
    let releaseResumeRunner = () => {};
    resumeRunnerImpl = async (applicationId, listingId2) => {
      await new Promise((resolve) => { releaseResumeRunner = resolve; });
      const relPath = `resumes/apply-now-lock-${applicationId}.docx`;
      fs.writeFileSync(path.join(outputRoot, relPath), 'fake docx bytes');
      const docRes = await verifyClient.query(
        `INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`,
        [listingId2, relPath],
      );
      await verifyClient.query('UPDATE ic_job_applications SET state = $2, resume_doc_id = $3, updated_at = now() WHERE id = $1', [applicationId, 'docs_ready', docRes.rows[0].id]);
      return { ok: true, markdownPath: 'output/markdown/lock.md' };
    };
    const listingId = await seedListing();
    const first = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(first.status, 202);
    const appId = first.json.application_id;

    const second = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(second.status, 202);
    assert.equal(second.json.application_id, appId);
    assert.equal(second.json.outcome, 'chain_running');

    releaseResumeRunner();
    await waitForState(appId, ['approved']);
    assert.equal(resumeRunnerCalls.length, 1, 'only one chain must have actually called the resume runner');
  });
});

describe('POST /api/listings/:id/apply-now: review FAIL leaves docs_ready with findings, never approved', () => {
  test('review runner FAIL stops the chain before approve', async () => {
    reviewRunnerImpl = async () => ({ ok: false, verdict: 'FAIL', reason: 'review_failed' });
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(applyRunnerStartCalls, []);
    const row = await getApplication(verifyClient, appId);
    // The default fake resumeRunner still performs its own DB side effect (docs_ready + linked resume),
    // matching the real resume-runner.js's success shape -- this test asserts the CHAIN's own branching
    // (review FAIL stops it before approve, leaving the application at docs_ready), not resume-runner.js's
    // internals, which are covered by test/resume-runner.test.js instead.
    assert.equal(row.state, 'docs_ready');
    assert.notEqual(row.state, 'approved');
  });
});

describe('POST /api/listings/:id/apply-now: 409 duplicate', () => {
  test('an active (non-drafting) application already existing for the listing is a 409, never a second run', async () => {
    const listingId = await seedListing();
    const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
    await transition(verifyClient, created.id, 'needs_human', { actor: 'apply', pending_question: { kind: 'question', label: 'x' } });
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'DUPLICATE_APPLICATION');
    assert.deepEqual(resumeRunnerCalls, []);
  });

  test('an existing drafting application is REUSED, not rejected', async () => {
    const listingId = await seedListing();
    const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 202);
    assert.equal(r.json.application_id, created.id);
  });
});

describe('POST /api/listings/:id/apply-now: apply exclusion gate (real gate restored, unique fixtures)', () => {
  /** Restores the real gate for one test, then restores the bypass -- see deps.applyExclusionGate's own
   * doc comment above (this file's other describe blocks share one listing fixture across many tests). */
  beforeEach(() => { deps.applyExclusionGate = realApplyExclusionGate; });
  afterEach(() => { deps.applyExclusionGate = async () => false; });

  /** Unique-per-test company/title (never the shared 'apply now test co' / 'apply now test' literal) --
   * see seedListing()'s own sibling tests for why a subset-matching company gate needs this. */
  async function seedUniqueListing(o = {}) {
    const n = Math.floor(Math.random() * 1e9);
    const r = await verifyClient.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, apply_url)
       VALUES ($1, $2, $3, $4, 'listing', $5, $6, 'legacy-unknown', $7, now(), $8) RETURNING id`,
      [
        o.title ?? 'Apply Now Excl Test', o.company ?? CO, `zz-test-applynow-excl-${process.pid}`,
        `zz-test-applynow-excl-${process.pid}:${n}`, o.companyNorm ?? `zzapplynowexclco${n}`, o.titleNorm ?? `zzapplynowexclrole${n}`,
        `zz-applynow-excl-hash-${n}`, o.applyUrl ?? null,
      ],
    );
    const id = Number(r.rows[0].id);
    listingIds.push(id);
    return id;
  }

  test('a blocked company is rejected with APPLY_EXCLUDED, no application row created', async () => {
    const listingId = await seedUniqueListing({ company: 'Immunotec Research Ltd', companyNorm: 'immunotec research' });
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'APPLY_EXCLUDED');
    assert.equal(r.json.branch, 'blocked_company');
    const app = await verifyClient.query('SELECT id FROM ic_job_applications WHERE listing_id = $1', [listingId]);
    assert.equal(app.rowCount, 0);
  });

  test('an unknown company (NEEDS_HUMAN) is rejected with APPLY_NEEDS_OVERRIDE unless override:true is sent', async () => {
    const listingId = await seedUniqueListing({ company: 'N/A', companyNorm: 'n a' });
    const blocked = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'APPLY_NEEDS_OVERRIDE');
    assert.equal(blocked.json.branch, 'unknown_company');
    const overridden = await req('POST', `/api/listings/${listingId}/apply-now`, { body: { override: true } });
    assert.equal(overridden.status, 202);
  });

  test('an eligible listing proceeds normally (202) with no override needed', async () => {
    const listingId = await seedUniqueListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 202);
  });

  test('re-clicking Apply on a listing\'s own still-drafting application is never blocked as already_applied_listing', async () => {
    const listingId = await seedUniqueListing();
    // The route's own async chain (runApplyNowChain) is fire-and-forget after the 202 -- this test wants
    // to catch the application while it is STILL 'drafting', which is what "re-clicking Apply on a
    // listing's own still-drafting application" actually means. The default beforeEach's fake
    // resumeRunnerImpl performs its DB side effect essentially instantly (a single local INSERT/UPDATE,
    // no real headless work), so on a fast local Postgres the whole chain (resume -> review -> approve)
    // can race ahead of this test's own second HTTP round trip and land on 'approved' before the second
    // click is even sent -- a real race with no synchronization on either side, not something specific to
    // any one implementation detail. A short artificial delay here, scoped to only this test, keeps the
    // chain reliably mid-flight (still 'drafting') for the immediate re-click, matching what the test
    // name actually describes, independent of how fast the surrounding I/O happens to be.
    resumeRunnerImpl = async (applicationId, listingId2) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const relPath = `resumes/apply-now-reclick-${applicationId}.docx`;
      fs.writeFileSync(path.join(outputRoot, relPath), 'fake docx bytes');
      const docRes = await verifyClient.query(
        `INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`,
        [listingId2, relPath],
      );
      await verifyClient.query('UPDATE ic_job_applications SET state = $2, resume_doc_id = $3, updated_at = now() WHERE id = $1', [applicationId, 'docs_ready', docRes.rows[0].id]);
      return { ok: true, markdownPath: 'output/markdown/x.md' };
    };

    const first = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(first.status, 202);
    const second = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(second.status, 202);
    assert.equal(second.json.application_id, first.json.application_id);
  });
});

describe('POST /api/listings/:id/apply-now: D1 total classification of chain failures', () => {
  /** @type {any[]} */
  let logs;
  /** @type {any} */
  let savedLog;
  /** @type {any} */
  let savedWithClient;
  // Earlier describe blocks fire chains they never wait for; let them finish so they never reach the
  // deps.withClient wrappers some tests below install.
  before(async () => { await new Promise((r) => setTimeout(r, 1000)); });
  beforeEach(() => {
    logs = [];
    savedLog = deps.log;
    savedWithClient = deps.withClient;
    deps.log = (/** @type {any} */ f) => { logs.push(f); };
  });
  afterEach(() => {
    deps.log = savedLog;
    deps.withClient = savedWithClient;
  });

  /** Wait until `pred()` holds or the timeout passes. @param {() => boolean | Promise<boolean>} pred */
  async function waitFor(pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await pred()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test('LOCKED from the resume runner parks resume_failed with reason resume_runner_busy, and Resume accepts it', async () => {
    resumeRunnerImpl = async () => { throw new JobSearchError('LOCKED', 'a resume run is already in progress'); };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(r.status, 202);
    const appId = r.json.application_id;
    const row = await waitForState(appId, ['needs_human']);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.error, 'resume_runner_busy');
    assert.equal(row.pending_question?.kind, 'resume_failed');
    assert.equal(row.pending_question?.label, humanizeParkReason('resume_runner_busy'));
    const parkEv = (await listApplicationEvents(verifyClient, appId)).find((e) => e.kind === 'state' && e.to_state === 'needs_human');
    assert.equal(parkEv.meta.phase, 'resume');
    assert.equal(parkEv.meta.err_code, 'LOCKED');
    assert.ok(logs.some((l) => l.evt === 'apply_now_chain_failed' && l.application_id === appId));
    assert.ok(!logs.some((l) => l.evt === 'apply_now_chain_park_failed' && l.application_id === appId));

    const resumed = await req('POST', `/api/applications/${appId}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.outcome, 'drafting');
  });

  test('a generic throw parks resume_failed with reason chain_error, and Resume accepts it', async () => {
    resumeRunnerImpl = async () => { throw new Error('boom'); };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const row = await waitForState(appId, ['needs_human']);
    assert.equal(row.error, 'chain_error');
    assert.equal(row.pending_question?.kind, 'resume_failed');
    const parkEv = (await listApplicationEvents(verifyClient, appId)).find((e) => e.kind === 'state' && e.to_state === 'needs_human');
    assert.equal(parkEv.meta.phase, 'resume');
    assert.equal(parkEv.meta.err_code, 'INTERNAL');
    assert.deepEqual(reviewRunnerCalls, []);
    const resumed = await req('POST', `/api/applications/${appId}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.outcome, 'drafting');
  });

  test('an ok resume result with no markdownPath, row still drafting, parks resume_failed and Resume accepts it', async () => {
    resumeRunnerImpl = async () => ({ ok: true });
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const row = await waitForState(appId, ['needs_human']);
    assert.equal(row.pending_question?.kind, 'resume_failed');
    assert.equal(row.error, 'markdown_not_found');
    assert.deepEqual(reviewRunnerCalls, []);
    const resumed = await req('POST', `/api/applications/${appId}/resume`);
    assert.equal(resumed.status, 200);
  });

  test('a failed result with no reason parks chain_error, never "unknown"', async () => {
    resumeRunnerImpl = async () => ({ ok: false });
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const row = await waitForState(r.json.application_id, ['needs_human']);
    assert.equal(row.error, 'chain_error');
    assert.equal(row.pending_question?.kind, 'resume_failed');
  });

  test('negative: an approve that throws on blockers stays docs_ready, is never parked, and logs an approve-phase error event', async () => {
    // The default fake drafts and links a resume; then the listing is closed so approve()'s blocker check throws.
    const listingId = await seedListing();
    const inner = resumeRunnerImpl;
    resumeRunnerImpl = async (applicationId, lid) => {
      const out = await inner(applicationId, lid);
      await verifyClient.query(`UPDATE ic_job_listings SET status = 'dead' WHERE id = $1`, [lid]);
      return out;
    };
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(async () => (await listApplicationEvents(verifyClient, appId)).some((e) => e.kind === 'error' && e.meta?.phase === 'approve'));
    assert.ok(ok, 'an approve-phase error event must be recorded');
    const row = await getApplication(verifyClient, appId);
    assert.equal(row.state, 'docs_ready');
    assert.equal(row.pending_question, null);
    const events = await listApplicationEvents(verifyClient, appId);
    assert.ok(!events.some((e) => e.kind === 'state' && e.to_state === 'needs_human'));
    assert.ok(!applyRunnerStartCalls.includes(appId), 'the apply runner must never start for this application');
  });

  test('a review that does not PASS stays docs_ready with a progress event saying to approve by hand', async () => {
    reviewRunnerImpl = async () => ({ ok: true, verdict: 'FAIL' });
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(async () => (await listApplicationEvents(verifyClient, appId)).some((e) => e.kind === 'progress' && /review did not pass; approve by hand/.test(e.note ?? '')));
    assert.ok(ok);
    assert.equal((await getApplication(verifyClient, appId)).state, 'docs_ready');
    assert.ok(!applyRunnerStartCalls.includes(appId), 'the apply runner must never start for this application');
  });

  test('a review-phase throw with the row at docs_ready logs a review-phase error event and is never parked', async () => {
    reviewRunnerImpl = async () => { throw new Error('review exploded'); };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(async () => (await listApplicationEvents(verifyClient, appId)).some((e) => e.kind === 'error' && e.meta?.phase === 'review'));
    assert.ok(ok);
    assert.equal((await getApplication(verifyClient, appId)).state, 'docs_ready');
  });

  test('adversarial: a row another actor moved to submitting is never parked by the chain (throw path)', async () => {
    resumeRunnerImpl = async (applicationId) => {
      await verifyClient.query(`UPDATE ic_job_applications SET state = 'submitting' WHERE id = $1`, [applicationId]);
      throw new Error('late failure');
    };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(async () => (await listApplicationEvents(verifyClient, appId)).some((e) => e.kind === 'error' && e.meta?.state === 'submitting'));
    assert.ok(ok, 'an error event naming the foreign state must be recorded');
    const row = await getApplication(verifyClient, appId);
    assert.equal(row.state, 'submitting');
    assert.ok(!(await listApplicationEvents(verifyClient, appId)).some((e) => e.kind === 'state' && e.to_state === 'needs_human'));
  });

  test('adversarial: a row another actor moved to submitting is never parked by the chain (failed-result path, guarded transition)', async () => {
    resumeRunnerImpl = async (applicationId) => {
      await verifyClient.query(`UPDATE ic_job_applications SET state = 'submitting' WHERE id = $1`, [applicationId]);
      return { ok: false, reason: 'timeout' };
    };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(() => logs.some((l) => l.evt === 'apply_now_chain_park_skipped' && l.application_id === appId));
    assert.ok(ok);
    const row = await getApplication(verifyClient, appId);
    assert.equal(row.state, 'submitting');
    assert.ok(!(await listApplicationEvents(verifyClient, appId)).some((e) => e.kind === 'state' && e.to_state === 'needs_human'));
  });

  test('adversarial: a state probe that throws gives an error-level log and no transition', async () => {
    resumeRunnerImpl = async (applicationId) => {
      await verifyClient.query('DELETE FROM ic_job_application_events WHERE application_id = $1', [applicationId]);
      await verifyClient.query('DELETE FROM ic_job_applications WHERE id = $1', [applicationId]);
      throw new Error('row vanished');
    };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(() => logs.some((l) => l.evt === 'apply_now_chain_park_failed' && l.application_id === appId));
    assert.ok(ok);
    const entry = logs.find((l) => l.evt === 'apply_now_chain_park_failed' && l.application_id === appId);
    assert.equal(entry.severity, 'error');
    const left = await verifyClient.query('SELECT 1 FROM ic_job_applications WHERE id = $1', [appId]);
    assert.equal(left.rowCount, 0);
  });

  test('A3: a park that throws a non-VALIDATION error causes no crash and logs apply_now_chain_park_failed', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ e) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let failing = false;
      const real = savedWithClient;
      deps.withClient = (/** @type {any} */ fn) => {
        if (failing) return Promise.reject(new Error('db connection lost'));
        return real(fn);
      };
      resumeRunnerImpl = async () => { failing = true; return { ok: false, reason: 'timeout' }; };
      const listingId = await seedListing();
      const r = await req('POST', `/api/listings/${listingId}/apply-now`);
      const appId = r.json.application_id;
      const ok = await waitFor(() => logs.some((l) => l.evt === 'apply_now_chain_park_failed' && l.application_id === appId));
      assert.ok(ok);
      const entry = logs.find((l) => l.evt === 'apply_now_chain_park_failed' && l.application_id === appId);
      assert.equal(entry.severity, 'error');
      failing = false;
      await new Promise((res) => setTimeout(res, 100));
      assert.deepEqual(unhandled, []);
      assert.equal((await getApplication(verifyClient, appId)).state, 'drafting');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('A5: a VALIDATION error without details.expected is logged at error level, not swallowed as a race', async () => {
    let calls = 0;
    let armed = false;
    const real = savedWithClient;
    deps.withClient = (/** @type {any} */ fn) => {
      if (armed) {
        calls += 1;
        if (calls === 1) return Promise.reject(new JobSearchError('VALIDATION', 'pending_question.kind must be a non-empty string'));
      }
      return real(fn);
    };
    resumeRunnerImpl = async () => { armed = true; return { ok: false, reason: 'timeout' }; };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(() => logs.some((l) => l.evt === 'apply_now_chain_park_failed' && l.application_id === appId && l.severity === 'error'));
    assert.ok(ok);
    assert.ok(!logs.some((l) => l.evt === 'apply_now_chain_park_skipped' && l.application_id === appId));
  });

  test('A5: a VALIDATION state mismatch (details.expected present) is swallowed at info as a race', async () => {
    let calls = 0;
    let armed = false;
    const real = savedWithClient;
    deps.withClient = (/** @type {any} */ fn) => {
      if (armed) {
        calls += 1;
        if (calls === 1) return Promise.reject(new JobSearchError('VALIDATION', 'state mismatch', { details: { from: 'needs_human', expected: 'drafting' } }));
      }
      return real(fn);
    };
    resumeRunnerImpl = async () => { armed = true; return { ok: false, reason: 'timeout' }; };
    const listingId = await seedListing();
    const r = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = r.json.application_id;
    const ok = await waitFor(() => logs.some((l) => l.evt === 'apply_now_chain_park_skipped' && l.application_id === appId));
    assert.ok(ok);
    assert.ok(!logs.some((l) => l.evt === 'apply_now_chain_park_failed' && l.application_id === appId));
  });
});

describe('POST /api/listings/:id/apply-now: A1 freshness and A2 busy runner', () => {
  test('A1: create, chain parks it, Resume, then Apply Now within 30 minutes starts a new chain', async () => {
    resumeRunnerImpl = async () => ({ ok: false, reason: 'no_description' });
    const listingId = await seedListing();
    const first = await req('POST', `/api/listings/${listingId}/apply-now`);
    const appId = first.json.application_id;
    await waitForState(appId, ['needs_human']);
    const resumed = await req('POST', `/api/applications/${appId}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.outcome, 'drafting');
    const row = await getApplication(verifyClient, appId);
    assert.ok(Date.now() - new Date(row.created_at).getTime() < STALE_ACTIONABLE_MS, 'the row is still inside the old freshness window');

    const second = await req('POST', `/api/listings/${listingId}/apply-now`);
    assert.equal(second.status, 202);
    assert.equal(second.json.application_id, appId);
    assert.notEqual(second.json.outcome, 'chain_running');
    await waitForState(appId, ['needs_human']);
    assert.equal(resumeRunnerCalls.length, 2, 'the second click must start a real chain');
  });

  test('A2: a busy resume runner is a 409 RESUME_RUNNER_BUSY and creates no row', async () => {
    const savedStatus = deps.resumeRunner.status;
    deps.resumeRunner.status = () => ({ running: true, applicationId: 999999, startedAt: new Date().toISOString() });
    try {
      const listingId = await seedListing();
      const r = await req('POST', `/api/listings/${listingId}/apply-now`);
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'RESUME_RUNNER_BUSY');
      assert.equal(typeof r.json.message, 'string');
      const rows = await verifyClient.query('SELECT id FROM ic_job_applications WHERE listing_id = $1', [listingId]);
      assert.equal(rows.rowCount, 0);
      assert.deepEqual(resumeRunnerCalls, []);
    } finally {
      deps.resumeRunner.status = savedStatus;
    }
  });

  test('A2: a busy resume runner refuses reuse of an existing drafting row too, leaving it untouched', async () => {
    const savedStatus = deps.resumeRunner.status;
    deps.resumeRunner.status = () => ({ running: true, applicationId: 999999, startedAt: new Date().toISOString() });
    try {
      const listingId = await seedListing();
      const created = await createApplication(verifyClient, { listingId, actor: 'mcp' });
      const r = await req('POST', `/api/listings/${listingId}/apply-now`);
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'RESUME_RUNNER_BUSY');
      assert.equal((await getApplication(verifyClient, created.id)).state, 'drafting');
      assert.deepEqual(resumeRunnerCalls, []);
    } finally {
      deps.resumeRunner.status = savedStatus;
    }
  });
});
