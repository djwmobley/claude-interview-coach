// @ts-check
/**
 * Route-level integration tests for src/dashboard/server.js against the real isolated test database
 * (guarded by src/core/config.js's assertTestDbGuard, same as every other test file). scanRunner and
 * calendar are stubbed per pr2-spec-decisions.md's own process rule ("route tests use createDashboardServer
 * on port 0 with stubbed calendar and runner and a fixture output/ tree"); everything else (listings,
 * follow-ups, review, documents, reports, analytics) goes through the real functions the MCP tools use,
 * against real rows this file creates and cleans up.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createCalendarCache } from '../src/dashboard/calendar-cache.js';

const CO = `ZZ-TEST-DASHBOARD-${process.pid}`;

/** @type {pg.Client} */
let verifyClient;
/** @type {string} */
let outputRoot;
/** @type {number} */
let port;
/** @type {ReturnType<typeof createDashboardServer>} */
let app;
/** @type {{ nextResult: any, nextError: any, calls: any[] }} */
let scanRunnerState;
/** @type {{ provider: any }} */
let calendarState;

function makeStubScanRunner() {
  scanRunnerState = { nextResult: { runId: 1, pid: 1234 }, nextError: null, calls: [] };
  return {
    async start(args) {
      scanRunnerState.calls.push(args);
      if (scanRunnerState.nextError) throw scanRunnerState.nextError;
      return scanRunnerState.nextResult;
    },
    status() {
      return { running: false, runId: null, pid: null, startedAt: null };
    },
    armCancelBackstop() {
      return { forced_kill_available: false };
    },
  };
}

async function cleanup() {
  const ids = (await verifyClient.query(`SELECT id FROM ic_job_listings WHERE company ILIKE $1`, [`%${CO}%`])).rows.map((r) => r.id);
  if (ids.length) {
    await verifyClient.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [ids]);
    await verifyClient.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [ids]);
    await verifyClient.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
    await verifyClient.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await verifyClient.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await verifyClient.query(`DELETE FROM ic_followups WHERE contact ILIKE $1`, [`%${CO}%`]);
}

before(async () => {
  verifyClient = new pg.Client(pgConnectionConfig());
  await verifyClient.connect();
  await ensureAuxSchema(verifyClient);
  await cleanup();

  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-dashboard-output-'));
  for (const dir of ['resumes', 'coverletters', 'cheatsheets', 'markdown', 'research', 'reports']) {
    fs.mkdirSync(path.join(outputRoot, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(outputRoot, 'markdown', `${CO}-notes.md`), '# fixture');

  calendarState = { provider: null };
  const deps = {
    withClient,
    // Loaded for real (rather than a hand-built stub): several routes read nested fields like
    // config.adapters.run.timezone without full optional-chaining past the first hop, so a partial stub
    // risks a TypeError in routes this file's other tests already exercise. The repo's real config/*.json
    // is what config-lock validates against anyway, so loading it here is also the more realistic test.
    config: loadConfig(),
    env: {
      OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'test-model',
      GOOGLE_TOKEN_FILE: '', REMINDER_TO: '',
      SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null,
      JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null,
    },
    calendar: async () => calendarState.provider,
    calendarCache: createCalendarCache(),
    scanRunner: makeStubScanRunner(),
    outputRoot,
    version: 'test',
    startedAt: new Date().toISOString(),
    healthBanner: [],
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

/**
 * @param {string} method
 * @param {string} p
 * @param {{ body?: unknown, headers?: Record<string,string> }} [opts]
 */
async function req(method, p, opts = {}) {
  const isMutating = !['GET', 'HEAD'].includes(method.toUpperCase());
  const headers = { ...(isMutating ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) };
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  /** @type {any} */
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

/**
 * Low-level request for guard edge cases fetch() cannot express (a custom Host header, an oversized raw
 * body with an incremental cap).
 * @param {{ method?: string, path: string, headers?: Record<string,string>, body?: string|Buffer }} opts
 */
function rawReq(opts) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (opts.body !== undefined) request.write(opts.body);
    request.end();
  });
}

describe('guards', () => {
  // The "missing Host" and "more than one Host header" branches are covered directly against
  // checkHost() in test/dashboard-http.test.js; a real HTTP/1.1 client (Node's http module included)
  // cannot be made to omit or duplicate the Host header without violating the protocol at a lower layer
  // than this server controls, so those two branches are not re-exercised here.

  test('non-loopback Host -> 403', async () => {
    const r = /** @type {any} */ (await rawReq({ path: '/api/health', headers: { Host: 'evil.example' } }));
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).code, 'BAD_HOST');
  });

  test('unknown route -> 404 NOT_FOUND', async () => {
    const r = await req('GET', '/api/does-not-exist');
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'NOT_FOUND');
  });

  test('wrong method on a known route -> 405 with Allow header', async () => {
    const r = await req('DELETE', '/api/summary');
    assert.equal(r.status, 405);
    assert.ok(r.headers.get('allow'));
  });

  test('mutating request with a non-JSON content type -> 415', async () => {
    const r = /** @type {any} */ (await rawReq({ method: 'POST', path: '/api/listings', headers: { 'content-type': 'text/plain', 'content-length': '2' }, body: '{}' }));
    assert.equal(r.status, 415);
  });

  test('mutating request over the 256 KB body cap -> 413', async () => {
    const big = Buffer.alloc(300 * 1024, 'a');
    const r = /** @type {any} */ (await rawReq({
      method: 'POST', path: '/api/listings',
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    }));
    assert.equal(r.status, 413);
  });

  test('invalid JSON body -> 400 VALIDATION', async () => {
    const r = /** @type {any} */ (await rawReq({ method: 'POST', path: '/api/listings', headers: { 'content-type': 'application/json' }, body: '{not json' }));
    assert.equal(r.status, 400);
  });

  test('every response carries the base security headers', async () => {
    const r = await req('GET', '/api/health');
    assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

describe('health', () => {
  test('identity probe shape', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.service, 'job-search-dashboard');
    assert.equal(r.json.db_ok, true);
    assert.equal(typeof r.json.pid, 'number');
  });
});

describe('listings', () => {
  /** @type {number} */
  let listingId;

  test('POST /api/listings creates a manual opportunity', async () => {
    const r = await req('POST', '/api/listings', { body: { title: 'CTO', company: `${CO} Alpha`, status: 'new' } });
    assert.equal(r.status, 201);
    assert.ok(r.json.id);
    listingId = r.json.id;
  });

  test('GET /api/listings filters by group=triage and includes the new row', async () => {
    const r = await req('GET', `/api/listings?group=triage&limit=200`);
    assert.equal(r.status, 200);
    assert.ok(r.json.rows.some((row) => row.id === listingId));
    assert.equal(typeof r.json.rows[0].url_ok, 'boolean');
  });

  test('GET /api/listings/:id returns the full detail shape', async () => {
    const r = await req('GET', `/api/listings/${listingId}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.row.id, listingId);
    assert.ok(Array.isArray(r.json.events));
    assert.ok(Array.isArray(r.json.documents));
    assert.ok(Array.isArray(r.json.suggestions));
  });

  test('an invalid status is refused with 400, no event written', async () => {
    const before2 = (await req('GET', `/api/listings/${listingId}`)).json.events.length;
    const r = await req('POST', `/api/listings/${listingId}/status`, { body: { status: 'not-a-real-status' } });
    assert.equal(r.status, 400);
    const after2 = (await req('GET', `/api/listings/${listingId}`)).json.events.length;
    assert.equal(after2, before2);
  });

  test('a status change writes exactly one new event', async () => {
    const before2 = (await req('GET', `/api/listings/${listingId}`)).json.events.length;
    const r = await req('POST', `/api/listings/${listingId}/status`, { body: { status: 'shortlisted', note: 'looks good' } });
    assert.equal(r.status, 200);
    const after2 = (await req('GET', `/api/listings/${listingId}`)).json.events;
    assert.equal(after2.length, before2 + 1);
    assert.equal(after2[0].kind, 'status');
    assert.equal(after2[0].to_status, 'shortlisted');
    assert.equal(after2[0].actor, 'dashboard');
  });

  test('PUT /api/listings/:id/notes updates notes and records a note event', async () => {
    const r = await req('PUT', `/api/listings/${listingId}/notes`, { body: { notes: 'called recruiter' } });
    assert.equal(r.status, 200);
    const detail = await req('GET', `/api/listings/${listingId}`);
    assert.equal(detail.json.row.notes, 'called recruiter');
  });

  test('PUT /api/listings/:id/fit rejects an out-of-range score', async () => {
    const r = await req('PUT', `/api/listings/${listingId}/fit`, { body: { fit_score: 150 } });
    assert.equal(r.status, 400);
  });

  test('bulk-status rejects an empty ids array', async () => {
    const r = await req('POST', '/api/listings/bulk-status', { body: { ids: [], status: 'new' } });
    assert.equal(r.status, 400);
  });

  test('bulk-status applies to multiple ids', async () => {
    const second = await req('POST', '/api/listings', { body: { title: 'VP Eng', company: `${CO} Beta`, status: 'new' } });
    const r = await req('POST', '/api/listings/bulk-status', { body: { ids: [listingId, second.json.id], status: 'maybe' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.results.length, 2);
  });
});

describe('documents', () => {
  /** @type {number} */
  let listingId;

  before(async () => {
    const r = await req('POST', '/api/listings', { body: { title: 'Doc Test', company: `${CO} Docs`, status: 'new' } });
    listingId = r.json.id;
  });

  test('path traversal (..) is rejected before touching the filesystem', async () => {
    const r = await req('GET', `/api/documents/file?path=${encodeURIComponent('../secret.txt')}`);
    assert.equal(r.status, 400);
  });

  test('a backslash in the path is rejected', async () => {
    const r = await req('GET', `/api/documents/file?path=${encodeURIComponent('markdown\\x.md')}`);
    assert.equal(r.status, 400);
  });

  test('an absolute-looking path is rejected', async () => {
    const r = await req('GET', `/api/documents/file?path=${encodeURIComponent('C:/markdown/x.md')}`);
    assert.equal(r.status, 400);
  });

  test('a disallowed extension is rejected', async () => {
    const r = await req('GET', `/api/documents/file?path=${encodeURIComponent('markdown/x.exe')}`);
    assert.equal(r.status, 400);
  });

  test('linking a real fixture file, then serving it as text', async () => {
    const relPath = `markdown/${CO}-notes.md`;
    const link = await req('POST', `/api/listings/${listingId}/documents`, { body: { kind: 'markdown', relPath } });
    assert.equal(link.status, 201);
    const served = await req('GET', `/api/documents/file?path=${encodeURIComponent(relPath)}`);
    assert.equal(served.status, 200);
    assert.equal(served.text, '# fixture');
    const del = await req('DELETE', `/api/documents/${link.json.row.id}`);
    assert.equal(del.status, 200);
  });

  test('rejects an unknown document kind', async () => {
    const r = await req('POST', `/api/listings/${listingId}/documents`, { body: { kind: 'not-a-kind', relPath: `markdown/${CO}-notes.md` } });
    assert.equal(r.status, 400);
  });

  test('GET /api/documents lists the fixture file', async () => {
    const r = await req('GET', '/api/documents?dir=markdown');
    assert.equal(r.status, 200);
    assert.ok(r.json.files.some((f) => f.name === `${CO}-notes.md`));
  });

  test('POST /api/documents/open on win32 attempts an open only after path validation passes; an invalid path is still rejected first', async () => {
    const r = await req('POST', '/api/documents/open', { body: { path: '../nope', reveal: false } });
    assert.equal(r.status, 400);
  });
});

describe('follow-ups', () => {
  /** @type {number} */
  let followupId;

  test('create, then complete', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} Recruiter`, due_at: '2027-01-01', channel: 'email', action_text: 'follow up' } });
    assert.equal(create.status, 201);
    followupId = create.json.row.id;
    const complete = await req('POST', `/api/followups/${followupId}/complete`);
    assert.equal(complete.status, 200);
    assert.equal(complete.json.row.status, 'done');
  });

  test('snooze rejects a past date', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} Snooze`, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const r = await req('POST', `/api/followups/${create.json.row.id}/snooze`, { body: { snoozed_until: '2000-01-01' } });
    assert.equal(r.status, 400);
  });

  test('calendar attach fails cleanly when no calendar is configured', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} Cal`, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const r = await req('POST', `/api/followups/${create.json.row.id}/calendar`);
    assert.equal(r.status, 400);
  });

  test('calendar attach succeeds once a calendar provider is stubbed in', async () => {
    calendarState.provider = { insertEvent: async () => 'evt-123', deleteEvent: async () => {}, listEvents: async () => [] };
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} Cal2`, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const r = await req('POST', `/api/followups/${create.json.row.id}/calendar`);
    assert.equal(r.status, 200);
    assert.equal(r.json.row.calendar_event_id, 'evt-123');
    calendarState.provider = null;
  });

  test('reply on a follow-up with no linked listing warns but succeeds', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} Reply`, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const r = await req('POST', `/api/followups/${create.json.row.id}/reply`, { body: { note: 'got a reply' } });
    assert.equal(r.status, 200);
    assert.ok(r.json.warnings.length > 0);
  });

  test('PUT edits due date and action text', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} Edit`, due_at: '2027-01-01', channel: 'email', action_text: 'original text' } });
    const r = await req('PUT', `/api/followups/${create.json.row.id}`, { body: { due_at: '2027-03-15', action_text: 'updated text' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.row.action, 'updated text');
    assert.equal(new Date(r.json.row.due_at).toISOString().slice(0, 10), '2027-03-15');
  });

  test('PUT with an invalid body (an unrecognized channel) is refused with 400', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} EditBad`, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const r = await req('PUT', `/api/followups/${create.json.row.id}`, { body: { channel: 'carrier-pigeon' } });
    assert.equal(r.status, 400);
  });

  test('PUT on an unknown id is NOT_FOUND', async () => {
    const r = await req('PUT', '/api/followups/999999999', { body: { action_text: 'x' } });
    assert.equal(r.status, 404);
  });

  test('editing a follow-up writes no event on its linked listing (not implemented by this PR)', async () => {
    const listing = await req('POST', '/api/listings', { body: { title: 'Followup Event Test', company: `${CO} FollowupEvent`, status: 'new' } });
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} EditEvent`, listing_id: listing.json.id, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const before2 = (await req('GET', `/api/listings/${listing.json.id}`)).json.events.length;
    const r = await req('PUT', `/api/followups/${create.json.row.id}`, { body: { action_text: 'edited' } });
    assert.equal(r.status, 200);
    const after2 = (await req('GET', `/api/listings/${listing.json.id}`)).json.events;
    // Documents current behavior rather than asserting a design goal: follow-up create/complete/cancel/
    // snooze/reply also never write a 'followup'-kind event today (only 'reply' writes anything, and only
    // on the reply action) -- adding one for edit alone, without the rest of the lifecycle, would be an
    // inconsistent half-step, so this PR leaves it as a documented gap rather than a silent scope change.
    assert.equal(after2.length, before2);
    assert.ok(!after2.some((e) => e.kind === 'followup'));
  });

  test('a due date in the past is accepted on edit (a deliberate correction, not treated as invalid)', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} PastEdit`, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const r = await req('PUT', `/api/followups/${create.json.row.id}`, { body: { due_at: '2020-01-01' } });
    assert.equal(r.status, 200);
  });

  test('adversarial: an impossible calendar date (Feb 30) matches the ISO shape check but is refused, not silently rolled into March', async () => {
    const create = await req('POST', '/api/followups', { body: { contact: `${CO} BadCalendarDate`, due_at: '2027-01-01', channel: 'email', action_text: 'x' } });
    const r = await req('PUT', `/api/followups/${create.json.row.id}`, { body: { due_at: '2027-02-30' } });
    assert.equal(r.status, 400);
  });

  test('GET /api/listings/:id still returns its own follow-up when 30 other open follow-ups are due sooner system-wide', async () => {
    const listing = await req('POST', '/api/listings', { body: { title: 'Followup Truncation Test', company: `${CO} Truncation`, status: 'new' } });
    const targetId = listing.json.id;
    // 30 unlinked, earlier-due follow-ups: sorted ahead of the target's own follow-up by the SQL
    // ORDER BY due_at ASC the route relies on. Before the fix these alone exceeded the route's old
    // hard-coded LIMIT 25, so the target listing's own follow-up never made it into the truncated
    // system-wide page that was then filtered by listing_id in memory.
    for (let i = 0; i < 30; i += 1) {
      const dueAt = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
      const r = await req('POST', '/api/followups', { body: { contact: `${CO} Noise ${i}`, due_at: dueAt, channel: 'email', action_text: 'noise' } });
      assert.equal(r.status, 201);
    }
    const target = await req('POST', '/api/followups', { body: { contact: `${CO} Target`, listing_id: targetId, due_at: '2027-06-01', channel: 'email', action_text: 'target follow-up' } });
    assert.equal(target.status, 201);
    const detail = await req('GET', `/api/listings/${targetId}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.json.followups.some((f) => f.id === target.json.row.id), 'the listing detail follow-ups list includes its own follow-up despite 30 earlier-due follow-ups elsewhere');
  });

  test('GET /api/followups?listing_id scopes in SQL too, for the same reason', async () => {
    const listing = await req('POST', '/api/listings', { body: { title: 'Followup Query Truncation Test', company: `${CO} QueryTruncation`, status: 'new' } });
    const targetId = listing.json.id;
    for (let i = 0; i < 30; i += 1) {
      const dueAt = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
      const r = await req('POST', '/api/followups', { body: { contact: `${CO} QNoise ${i}`, due_at: dueAt, channel: 'email', action_text: 'noise' } });
      assert.equal(r.status, 201);
    }
    const target = await req('POST', '/api/followups', { body: { contact: `${CO} QTarget`, listing_id: targetId, due_at: '2027-07-01', channel: 'email', action_text: 'target follow-up' } });
    assert.equal(target.status, 201);
    const listed = await req('GET', `/api/followups?listing_id=${targetId}`);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.rows.some((f) => f.id === target.json.row.id), 'the listing-scoped follow-ups list includes its own follow-up despite 30 earlier-due follow-ups elsewhere');
    assert.equal(listed.json.total, 1);
  });
});

describe('sources enable', () => {
  // Must be real config/adapters.json keys: the route validates against deps.config.adapters.adapters,
  // loaded for real in this file's before() (see the comment there).
  const KNOWN_SOURCE = 'greenhouse';
  const OTHER_KNOWN_SOURCE = 'dayforce';

  after(async () => {
    await verifyClient.query('DELETE FROM ic_source_state WHERE source ILIKE $1 OR source = $2', [`${KNOWN_SOURCE}%`, OTHER_KNOWN_SOURCE]);
  });

  test('an unknown source name is refused with 404 and never creates a row', async () => {
    const r = await req('POST', '/api/sources/not-a-real-source/enable');
    assert.equal(r.status, 404);
    const row = await verifyClient.query('SELECT 1 FROM ic_source_state WHERE source = $1', ['not-a-real-source']);
    assert.equal(row.rowCount, 0);
  });

  test('a source that is not currently disabled is a visible no-op, not a silent write', async () => {
    await verifyClient.query('DELETE FROM ic_source_state WHERE source = $1', [OTHER_KNOWN_SOURCE]);
    const r = await req('POST', `/api/sources/${OTHER_KNOWN_SOURCE}/enable`);
    assert.equal(r.status, 200);
    assert.equal(r.json.already_enabled, true);
    const row = await verifyClient.query('SELECT 1 FROM ic_source_state WHERE source = $1', [OTHER_KNOWN_SOURCE]);
    assert.equal(row.rowCount, 0);
  });

  test('re-enabling an actually disabled source resets it and reports already_enabled:false', async () => {
    await verifyClient.query(
      `INSERT INTO ic_source_state (source, consecutive_walls, disabled_until, manual_disable) VALUES ($1, 3, NULL, true)
       ON CONFLICT (source) DO UPDATE SET consecutive_walls = 3, disabled_until = NULL, manual_disable = true`,
      [KNOWN_SOURCE],
    );
    const r = await req('POST', `/api/sources/${KNOWN_SOURCE}/enable`);
    assert.equal(r.status, 200);
    assert.equal(r.json.source, KNOWN_SOURCE);
    assert.equal(r.json.already_enabled, false);
    const row = (await verifyClient.query('SELECT manual_disable, disabled_until, consecutive_walls FROM ic_source_state WHERE source = $1', [KNOWN_SOURCE])).rows[0];
    assert.equal(row.manual_disable, false);
    assert.equal(row.disabled_until, null);
    assert.equal(row.consecutive_walls, 0);
  });

  test('adversarial: a differently-cased source name normalizes onto the same canonical row a scan run reads, never a second dead row', async () => {
    await verifyClient.query('DELETE FROM ic_source_state WHERE source ILIKE $1', [`${KNOWN_SOURCE}%`]);
    await verifyClient.query(
      `INSERT INTO ic_source_state (source, consecutive_walls, disabled_until, manual_disable) VALUES ($1, 1, NULL, true)`,
      [KNOWN_SOURCE],
    );
    const r = await req('POST', `/api/sources/${KNOWN_SOURCE.toUpperCase()}/enable`);
    assert.equal(r.status, 200);
    assert.equal(r.json.source, KNOWN_SOURCE);
    const rows = await verifyClient.query('SELECT source, manual_disable FROM ic_source_state WHERE source ILIKE $1', [`${KNOWN_SOURCE}%`]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].source, KNOWN_SOURCE);
    assert.equal(rows.rows[0].manual_disable, false);
  });
});

describe('review', () => {
  test('GET /api/review returns a well-shaped, possibly-empty list', async () => {
    const r = await req('GET', '/api/review');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.rows));
    assert.equal(typeof r.json.total, 'number');
  });

  test('resolving a nonexistent queue item is NOT_FOUND', async () => {
    const r = await req('POST', '/api/review/999999999/resolve', { body: { resolution: 'separate' } });
    assert.equal(r.status, 404);
  });

  test('an invalid resolution value is rejected before touching the DB', async () => {
    const r = await req('POST', '/api/review/1/resolve', { body: { resolution: 'not-a-resolution' } });
    assert.equal(r.status, 400);
  });
});

describe('scans', () => {
  test('POST /api/scans returns 202 with the runner-provided run id', async () => {
    scanRunnerState.nextError = null;
    scanRunnerState.nextResult = { runId: 4242, pid: 999 };
    const r = await req('POST', '/api/scans', { body: { profile: 'exec-default', dryRun: true } });
    assert.equal(r.status, 202);
    assert.equal(r.json.run_id, 4242);
  });

  test('POST /api/scans surfaces LOCKED as 409', async () => {
    const { JobSearchError } = await import('../src/core/errors.js');
    scanRunnerState.nextError = new JobSearchError('LOCKED', 'already running');
    const r = await req('POST', '/api/scans', {});
    assert.equal(r.status, 409);
    scanRunnerState.nextError = null;
  });

  test('POST /api/scans surfaces a scan-start timeout as 500 SCAN_START_TIMEOUT', async () => {
    const { DashboardError } = await import('../src/dashboard/http.js');
    scanRunnerState.nextError = new DashboardError(500, 'SCAN_START_TIMEOUT', 'timed out');
    const r = await req('POST', '/api/scans', {});
    assert.equal(r.status, 500);
    assert.equal(r.json.code, 'SCAN_START_TIMEOUT');
    scanRunnerState.nextError = null;
  });

  test('cancel on a run that is not running is NOT_FOUND', async () => {
    const r = await req('POST', '/api/scans/999999999/cancel');
    assert.equal(r.status, 404);
  });

  test('GET /api/scans/live reflects the stubbed runner status', async () => {
    const r = await req('GET', '/api/scans/live');
    assert.equal(r.status, 200);
    assert.equal(r.json.running, false);
  });

  test('GET /api/chrome reports unreachable against a closed port', async () => {
    const r = await req('GET', '/api/chrome');
    assert.equal(r.status, 200);
    assert.equal(r.json.reachable, false);
  });
});

describe('report', () => {
  test('preview never advances ic_report_state', async () => {
    const before2 = (await verifyClient.query('SELECT last_report_sent_at FROM ic_report_state WHERE id = true')).rows[0].last_report_sent_at;
    const r = await req('GET', '/api/report/preview');
    assert.equal(r.status, 200);
    assert.ok(typeof r.json.subject === 'string');
    const after2 = (await verifyClient.query('SELECT last_report_sent_at FROM ic_report_state WHERE id = true')).rows[0].last_report_sent_at;
    assert.deepEqual(before2, after2);
  });

  test('send without a configured Google token fails cleanly (never a 500)', async () => {
    const r = await req('POST', '/api/report/send', { body: { dryRun: true } });
    assert.equal(r.status, 400);
  });

  test('history returns a well-shaped response', async () => {
    const r = await req('GET', '/api/report/history');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.days));
  });

  // pr3-spec-decisions.md section 9 item 3 / section 6 item 3: the HTML-serving preview variant so the
  // front end's sandboxed iframe can src= it directly, carrying the same sandbox CSP applySandboxHtmlHeaders
  // gives a saved report file through GET /api/documents/file, and never touching ic_report_state.
  test('preview.html responds with rendered HTML under the sandbox CSP and never advances ic_report_state', async () => {
    const before = (await verifyClient.query('SELECT last_report_sent_at FROM ic_report_state WHERE id = true')).rows[0].last_report_sent_at;
    const r = await req('GET', '/api/report/preview.html');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.ok(r.text.length > 0);
    assert.equal(/^\s*\{/.test(r.text), false, 'response body must be HTML, not a JSON envelope');
    const after = (await verifyClient.query('SELECT last_report_sent_at FROM ic_report_state WHERE id = true')).rows[0].last_report_sent_at;
    assert.deepEqual(before, after);
  });

  test('preview.html accepts the same date/run_id/profile params as the JSON preview route', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await req('GET', `/api/report/preview.html?date=${today}&profile=exec-default`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  });
});

describe('calendar', () => {
  test('agenda requires from/to', async () => {
    const r = await req('GET', '/api/calendar/agenda');
    assert.equal(r.status, 400);
  });

  test('agenda reports connected:false when no provider is configured', async () => {
    const r = await req('GET', '/api/calendar/agenda?from=2027-01-01T00:00:00Z&to=2027-01-08T00:00:00Z');
    assert.equal(r.status, 200);
    assert.equal(r.json.connected, false);
  });

  test('agenda merges Google events with followups due in the window once a provider is stubbed in', async () => {
    calendarState.provider = { insertEvent: async () => 'x', deleteEvent: async () => {}, listEvents: async () => [{ id: 'g1', summary: 'Test event' }] };
    const created = await req('POST', '/api/followups', { body: { contact: `${CO} Agenda`, due_at: '2027-02-01', channel: 'email', action_text: 'x' } });
    const r = await req('GET', '/api/calendar/agenda?from=2027-01-25T00:00:00Z&to=2027-02-05T00:00:00Z');
    assert.equal(r.status, 200);
    assert.equal(r.json.connected, true);
    assert.equal(r.json.events.length, 1);
    assert.ok(r.json.followups.some((f) => f.id === created.json.row.id));
    calendarState.provider = null;
  });

  test('creating an event without a configured calendar is refused', async () => {
    const r = await req('POST', '/api/calendar/events', { body: { summary: 'x', startIso: '2027-01-01T00:00:00Z', endIso: '2027-01-01T01:00:00Z' } });
    assert.equal(r.status, 400);
  });
});

describe('memory and companies', () => {
  test('company memory requires a company or listing_id', async () => {
    const r = await req('GET', '/api/memory/company');
    assert.equal(r.status, 400);
  });

  test('company memory returns a well-shaped response for a company with no history', async () => {
    const r = await req('GET', `/api/memory/company?company=${encodeURIComponent(CO)}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.moments));
    assert.ok(Array.isArray(r.json.research));
  });

  test('answers search returns a well-shaped response', async () => {
    const r = await req('GET', '/api/memory/answers?q=leadership');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.rows));
  });

  test('adding a moment without question/response is rejected', async () => {
    const r = await req('POST', '/api/companies/some-norm/moments', { body: {} });
    assert.equal(r.status, 400);
  });

  test('GET /api/companies returns grouped stats including the test rows', async () => {
    const r = await req('GET', '/api/companies');
    assert.equal(r.status, 200);
    assert.ok(r.json.rows.some((row) => String(row.company).includes(CO)));
  });

  test('company memory includes that company_norm\'s listings and their open follow-ups (defect 2)', async () => {
    const company = `${CO} Memory Corp`;
    const created = await req('POST', '/api/listings', { body: { title: 'Head of Memory', company, status: 'applied' } });
    assert.equal(created.status, 201);
    const listingId = created.json.id;

    const followup = await req('POST', '/api/followups', {
      body: { contact: `${CO} Memory Contact`, listing_id: listingId, due_at: '2027-03-01', channel: 'email', action_text: 'check in' },
    });
    assert.equal(followup.status, 201);

    // A resolved (row that company_norm normalizes to) query, not the raw display string: fetch the row
    // back to read the exact company_norm the server computed, then request by that norm the same way
    // pages/company-detail.js does (params.norm), to prove the route resolves both call shapes.
    const norm = (await verifyClient.query('SELECT company_norm FROM ic_job_listings WHERE id = $1', [listingId])).rows[0].company_norm;

    const r = await req('GET', `/api/memory/company?company=${encodeURIComponent(norm)}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.listings));
    assert.ok(Array.isArray(r.json.followups));
    const listingRow = r.json.listings.find((l) => l.id === listingId);
    assert.ok(listingRow, 'the listing just created must appear under its company_norm');
    assert.equal(listingRow.title, 'Head of Memory');
    assert.equal(listingRow.status, 'applied');
    assert.equal(listingRow.source, 'manual');
    assert.ok('url_ok' in listingRow);
    const followupRow = r.json.followups.find((f) => f.listing_id === listingId);
    assert.ok(followupRow, 'the open follow-up on that listing must appear');
    assert.equal(followupRow.action, 'check in');
    assert.equal(followupRow.status, 'open');
  });

  test('company memory omits done/cancelled follow-ups and listings from other companies', async () => {
    const company = `${CO} Memory Scope`;
    const created = await req('POST', '/api/listings', { body: { title: 'Scope Test', company, status: 'new' } });
    const listingId = created.json.id;
    const followup = await req('POST', '/api/followups', {
      body: { contact: `${CO} Scope Contact`, listing_id: listingId, due_at: '2027-03-02', channel: 'email', action_text: 'done already' },
    });
    await req('POST', `/api/followups/${followup.json.row.id}/complete`, {});

    const norm = (await verifyClient.query('SELECT company_norm FROM ic_job_listings WHERE id = $1', [listingId])).rows[0].company_norm;
    const r = await req('GET', `/api/memory/company?company=${encodeURIComponent(norm)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.listings.length, 1, 'only this one company_norm\'s listing, not other test-fixture companies');
    assert.equal(r.json.followups.length, 0, 'a completed follow-up must not appear in the open/snoozed list');
  });
});

describe('profiles: sources list for the Run scan options drawer (defect 4)', () => {
  test('GET /api/profiles reports the full configured source list, not any one profile\'s own (usually empty) sources column', async () => {
    const r = await req('GET', '/api/profiles');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.sources));
    assert.ok(r.json.sources.includes('greenhouse'));
    assert.ok(r.json.sources.includes('lever'));
    assert.ok(Array.isArray(r.json.profiles));
  });
});

describe('analytics', () => {
  test('returns the documented shape', async () => {
    const r = await req('GET', '/api/analytics?weeks=4');
    assert.equal(r.status, 200);
    assert.equal(r.json.weeks, 4);
    assert.ok(Array.isArray(r.json.new_by_source));
    assert.ok(Array.isArray(r.json.funnel));
    assert.ok('response_rate' in r.json);
  });

  test('weeks is clamped into 1-52', async () => {
    const r = await req('GET', '/api/analytics?weeks=9999');
    assert.equal(r.json.weeks, 52);
  });
});

describe('stream', () => {
  test('GET /api/stream responds with SSE headers and an initial retry line', async () => {
    /** @type {any} */
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/api/stream', method: 'GET' }, (res) => {
        let gotChunk = false;
        res.on('data', (chunk) => {
          if (gotChunk) return;
          gotChunk = true;
          resolve({ status: res.statusCode, contentType: res.headers['content-type'], firstChunk: chunk.toString('utf8') });
          request.destroy();
        });
      });
      request.on('error', (err) => {
        // The request is destroyed deliberately once a chunk arrives; ignore the resulting socket error.
        if (!err.message.includes('socket hang up')) reject(err);
      });
      request.end();
      setTimeout(() => reject(new Error('no SSE data within 2s')), 2000).unref?.();
    });
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes('text/event-stream'));
    assert.ok(result.firstChunk.startsWith('retry:'));
  });
});
