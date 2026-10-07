// @ts-check
/**
 * Dashboard Ready to apply routes (spec section 10, T13): GET returns the documented shape and viewing it
 * writes the manual-only lock for a listed row (A1); the resume route refuses with 409 READY_RESUME_BUSY
 * while the shared spawn lock is held and ignores any override flag in the body (A10); hand back releases
 * the lock and logs a listing event (R8); the page's "I applied" and "Dismiss" go through the existing
 * POST /api/listings/:id/status route.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { withClient, closePool } from '../src/core/db.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createCalendarCache } from '../src/dashboard/calendar-cache.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = `zz-test-readyroute-${process.pid}`;
/** @type {pg.Client} */
let c;
/** @type {any} */
let app;
let port = 0;
let listingId = 0;
const spawnLock = { held: true, async tryAcquire() { return this.held ? null : { release: async () => {} }; }, async acquire() { return null; } };

before(async () => {
  c = new pg.Client(pgConnectionConfig());
  await c.connect();
  const r = await c.query(
    `INSERT INTO ic_job_listings (source, external_id, url, url_normalized, title, title_norm, company, company_norm, location_norm, fit_score, description, status, manual_apply_url, first_seen, record_kind)
     VALUES ($1, $2, $3, $3, 'Chief Technology Officer', 'chief technology officer', $4, lower($4), 'state-tx', 88, $5, 'new', $6, now(), 'listing') RETURNING id`,
    [SRC, `${SRC}-1`, `https://jobs.example.com/${process.pid}/1`, `Readyroute${process.pid}`, 'Real description. '.repeat(30), `https://careers.readyroute${process.pid}.com/j/1`],
  );
  listingId = Number(r.rows[0].id);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'readyroute-out-'));
  app = createDashboardServer(/** @type {any} */ ({
    withClient, config: loadConfig(),
    env: { OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', GOOGLE_TOKEN_FILE: '', REMINDER_TO: '', SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null, JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null },
    calendar: async () => null, calendarCache: createCalendarCache(),
    scanRunner: { async start() { return { runId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    applyRunner: { async start() { return { applicationId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    credentials: { read: async () => null, write: async () => {}, delete: async () => false, list: async () => [] },
    outputRoot, version: 'test', startedAt: new Date().toISOString(), healthBanner: [], log: () => {},
    readyResumeRunner: { generate: async () => ({ ok: false, reason: 'no_document' }), review: async () => ({ ok: false, reason: 'x' }) },
    resumeSpawnLock: spawnLock,
  }));
  await app.listen(0, '127.0.0.1');
  port = app.server.address().port;
});
after(async () => {
  await c.query('DELETE FROM ic_scan_budget WHERE source = $1', ['ready_resume']);
  await c.query('DELETE FROM ic_job_listings WHERE source = $1', [SRC]);
  await c.end();
  await app.close();
  await closePool();
});

/** @param {string} method @param {string} p @param {unknown} [body] */
async function req(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

describe('Ready to apply routes', () => {
  test('GET: shape, the seeded row is ready, and viewing it writes the manual-only lock (A1)', async () => {
    const r = await req('GET', '/api/ready-to-apply');
    assert.equal(r.status, 200);
    for (const k of ['ok', 'generatedAt', 'autoSubmitCount', 'ready', 'held', 'excludedCounts', 'counts', 'resumeCounts']) assert.ok(k in r.body, k);
    const row = r.body.ready.find((/** @type {any} */ x) => x.listingId === listingId);
    assert.ok(row, 'seeded row listed');
    assert.equal(row.channel, 'external_manual');
    assert.equal(row.host, `careers.readyroute${process.pid}.com`);
    assert.ok(row.resume);
    const locks = await c.query('SELECT 1 FROM ic_manual_only_locks WHERE listing_id = $1 AND released_at IS NULL', [listingId]);
    assert.equal(locks.rowCount, 1);
  });

  test('resume: 409 READY_RESUME_BUSY while the spawn lock is held; an override flag changes nothing', async () => {
    const r = await req('POST', `/api/ready-to-apply/${listingId}/resume`, { override: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'READY_RESUME_BUSY');
    const used = await c.query(`SELECT coalesce(sum(pages), 0)::int AS n FROM ic_scan_budget WHERE source = 'ready_resume'`);
    assert.equal(used.rows[0].n, 0, 'the refused start refunded its cap slot');
  });

  test('resume: 400 on a bad id; 404 for a listing that is not on the list', async () => {
    assert.equal((await req('POST', '/api/ready-to-apply/abc/resume')).status, 400);
    assert.equal((await req('POST', '/api/ready-to-apply/999999999/resume')).status, 404);
  });

  test('hand back releases the lock and logs a listing event (R8)', async () => {
    const r = await req('POST', `/api/ready-to-apply/${listingId}/hand-back`);
    assert.equal(r.status, 200);
    assert.equal(r.body.released, 1);
    const locks = await c.query('SELECT 1 FROM ic_manual_only_locks WHERE listing_id = $1 AND released_at IS NULL', [listingId]);
    assert.equal(locks.rowCount, 0);
    const ev = await c.query(`SELECT note, actor FROM ic_job_events WHERE listing_id = $1 AND kind = 'note' ORDER BY id DESC LIMIT 1`, [listingId]);
    assert.equal(ev.rows[0].actor, 'dashboard');
  });

  test('the page routes I applied and Dismiss through POST /api/listings/:id/status', () => {
    const page = fs.readFileSync(path.join(HERE, '..', 'src', 'dashboard', 'public', 'pages', 'ready.js'), 'utf8');
    assert.match(page, /\/api\/listings\/\$\{[^}]+\}\/status/);
    assert.match(page, /status: 'applied'/);
    assert.match(page, /status: 'passed'/);
    assert.doesNotMatch(page, /confirm-submitted|applied-by-hand/);
  });
});
