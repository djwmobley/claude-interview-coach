// @ts-check
/**
 * Dashboard routes for a parked Indeed (sql/032): the parked state in /api/summary and /api/sources/disabled,
 * POST /api/sources/indeed/open-page and POST /api/sources/indeed/resume. The scan Chrome (CDP client and
 * launcher) and the scan runner are fakes; no browser, scan, claude or powershell is ever started.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
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

/** @type {pg.Client} */ let client;
/** @type {string} */ let root;
/** @type {ReturnType<typeof createDashboardServer>} */ let app;
/** @type {number} */ let port;
/** @type {{ running: boolean, starts: any[] }} */ let runner;
/** @type {{ targets: string[], sent: any[], connectFails: number, launched: number, closed: number }} */ let chrome;

const resetFakes = () => {
  runner = { running: false, starts: [] };
  chrome = { targets: [], sent: [], connectFails: 0, launched: 0, closed: 0 };
};

before(async () => {
  resetFakes();
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-indeedpark-'));
  const calendarFn = /** @type {any} */ (async () => null);
  calendarFn.lastState = () => null;
  const deps = {
    withClient, config: loadConfig(),
    env: { OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', GOOGLE_TOKEN_FILE: '', REMINDER_TO: '', SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: root, CHROME_EXECUTABLE: null, JOBSEARCH_LOG_DIR: root, JOBSEARCH_CONFIG_DIR: root, LOG_LEVEL: 'silent', PG_DSN: null },
    calendar: calendarFn, calendarCache: createCalendarCache(),
    scanRunner: {
      async start(/** @type {any} */ args) { runner.starts.push(args); return { runId: 77, pid: 1 }; },
      status: () => ({ running: runner.running, runId: null, pid: null, startedAt: null }),
      armCancelBackstop: () => ({ forced_kill_available: false }),
    },
    parkedTab: {
      async connect() {
        if (chrome.connectFails > 0) { chrome.connectFails--; throw new Error('no chrome'); }
        return {
          async listPageTargets() { return chrome.targets.map((targetId) => ({ targetId, type: 'page', url: '', title: '' })); },
          async send(/** @type {string} */ method, /** @type {any} */ params) {
            chrome.sent.push({ method, params });
            return method === 'Target.createTarget' ? { targetId: 'NEW-TARGET' } : {};
          },
          close() { chrome.closed++; },
        };
      },
      async launchChrome() { chrome.launched++; return {}; },
    },
    outputRoot: root, version: 'test', startedAt: new Date().toISOString(), healthBanner: [],
  };
  app = createDashboardServer(/** @type {any} */ (deps));
  await app.listen(0, '127.0.0.1');
  port = /** @type {any} */ (app.server.address()).port;
});

after(async () => {
  await client.query("DELETE FROM ic_source_state WHERE source = 'indeed'");
  await client.end();
  await app.close();
  await closePool();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  resetFakes();
  await client.query("DELETE FROM ic_source_state WHERE source = 'indeed'");
});

const park = (/** @type {string|null} */ url = 'https://www.indeed.com/verify', /** @type {string|null} */ target = 'OLD-TARGET') => client.query(
  "INSERT INTO ic_source_state (source, parked_at, park_url, park_target_id) VALUES ('indeed', now(), $1, $2)", [url, target]);
const parkRow = async () => (await client.query("SELECT parked_at, park_url, park_target_id FROM ic_source_state WHERE source = 'indeed'")).rows[0];

/** @param {string} method @param {string} p */
async function req(method, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

describe('parked Indeed on the dashboard', () => {
  test('parked state is returned by the summary and the disabled-sources list', async () => {
    await park();
    for (const p of ['/api/summary', '/api/sources/disabled']) {
      const r = await req('GET', p);
      assert.equal(r.status, 200, p);
      assert.equal(r.json.parked_source.source, 'indeed');
      assert.equal(r.json.parked_source.url, 'https://www.indeed.com/verify');
      assert.ok(Date.parse(r.json.parked_source.parked_at) > 0);
    }
  });

  test('not parked: parked_source is null and the existing list is untouched', async () => {
    const r = await req('GET', '/api/sources/disabled');
    assert.equal(r.json.parked_source, null);
    assert.ok(!r.json.sources.some((/** @type {any} */ s) => s.source === 'indeed'));
    assert.equal((await req('GET', '/api/summary')).json.parked_source, null);
  });

  test('Open with a live target brings that tab to the front and opens nothing', async () => {
    await park();
    chrome.targets = ['OLD-TARGET'];
    const r = await req('POST', '/api/sources/indeed/open-page');
    assert.equal(r.status, 200);
    assert.deepEqual(chrome.sent, [{ method: 'Target.activateTarget', params: { targetId: 'OLD-TARGET' } }]);
    assert.equal((await parkRow()).park_target_id, 'OLD-TARGET');
    assert.equal(chrome.launched, 0);
    assert.equal(chrome.closed, 1);
  });

  test('Open with a missing target opens park_url in a new tab and stores the new id', async () => {
    await park();
    chrome.targets = ['SOME-OTHER-TAB'];
    const r = await req('POST', '/api/sources/indeed/open-page');
    assert.equal(r.status, 200);
    assert.equal(r.json.reopened, true);
    assert.deepEqual(chrome.sent[0], { method: 'Target.createTarget', params: { url: 'https://www.indeed.com/verify' } });
    assert.equal((await parkRow()).park_target_id, 'NEW-TARGET');
  });

  test('Open with the scan Chrome gone starts it, then opens park_url', async () => {
    await park();
    chrome.connectFails = 1;
    const r = await req('POST', '/api/sources/indeed/open-page');
    assert.equal(r.status, 200);
    assert.equal(chrome.launched, 1);
    assert.equal((await parkRow()).park_target_id, 'NEW-TARGET');
  });

  test('Open when Indeed is not parked is NOT_FOUND and touches no browser', async () => {
    const r = await req('POST', '/api/sources/indeed/open-page');
    assert.equal(r.status, 404);
    assert.deepEqual(chrome.sent, []);
  });

  test('Resume clears the three columns and starts an Indeed-only scan', async () => {
    await park();
    const r = await req('POST', '/api/sources/indeed/resume');
    assert.equal(r.status, 202);
    assert.equal(r.json.run_id, 77);
    assert.deepEqual(runner.starts, [{ sources: ['indeed'] }]);
    const row = await parkRow();
    assert.equal(row.parked_at, null);
    assert.equal(row.park_url, null);
    assert.equal(row.park_target_id, null);
  });

  test('Resume while a scan runs does nothing: 409 and the park stays', async () => {
    await park();
    runner.running = true;
    const r = await req('POST', '/api/sources/indeed/resume');
    assert.equal(r.status, 409);
    assert.equal(runner.starts.length, 0);
    assert.ok((await parkRow()).parked_at);
  });

  test('Resume when Indeed is not parked is NOT_FOUND and starts nothing', async () => {
    const r = await req('POST', '/api/sources/indeed/resume');
    assert.equal(r.status, 404);
    assert.equal(runner.starts.length, 0);
  });
});
