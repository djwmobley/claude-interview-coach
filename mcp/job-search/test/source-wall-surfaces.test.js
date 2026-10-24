// @ts-check
/**
 * Where "why is this source off" shows up: the three report formats, the dashboard Home / Runs panel, the
 * summary / enable / snapshot routes, and a real runScan (dry and wet) over a permanent LinkedIn skeleton.
 * Real isolated test database; every source row is cleaned up; the only real source names touched
 * (linkedin, indeed) are restored around the tests that need them.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig, loadConfig, getEnv } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createCalendarCache } from '../src/dashboard/calendar-cache.js';
import { resolveSnapshot } from '../src/dashboard/routes/wall-snapshots.js';
import { renderReportText, renderReportHtml, renderReportMarkdown, collectDisabledSources } from '../src/core/report.js';
import { recordWall } from '../src/browser/wall.js';
import { disabledSourcesPanel, snapshotHref, enablePath } from '../src/dashboard/public/components/disabled-sources.js';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, makeFakeSession } from './helpers/scan-fixtures.js';

const DAY = 86400000;
const TAG = `zz-test-wallsurf-${process.pid}`;

// ---------------------------------------------------------------------------------------------------------
// Reports: all three formats, null reason, escaping
// ---------------------------------------------------------------------------------------------------------

describe('reports: the disabled-sources section in text, HTML and markdown', () => {
  /** @param {any[]} disabledSources */
  const data = (disabledSources) => /** @type {any} */ ({
    dayKey: '2026-10-24', timezone: 'America/Chicago', noScan: false, runs: [], lookAtThese: { rows: [], excludedCount: 0 }, suspectUnclassified: [],
    homeLocations: { rows: [], excludedCount: 0 }, reviewQueue: { total: 0, topReasons: [] }, disabledSources,
  });
  const LATCHED = { source: 'linkedin', manual: true, until: null, text: 'auto-disabled after 3 failed scans (2026-10-08, 2026-10-09, 2026-10-12): unhydrated_after_retry, no_cards_no_shell_after_reload after one reload' };
  const PAUSED = { source: 'indeed', manual: false, until: '2026-10-25T14:00:00.000Z', text: 'paused until 2026-10-25T14:00:00.000Z after 1 failed scan: reason not recorded' };

  test('the old "manual disable" label is gone from every format; the new sentence is present', () => {
    const d = data([LATCHED, PAUSED]);
    for (const out of [renderReportText(d), renderReportHtml(d), renderReportMarkdown(d)]) {
      assert.doesNotMatch(out, /manual disable/);
      assert.match(out, /linkedin: auto-disabled after 3 failed scans \(2026-10-08, 2026-10-09, 2026-10-12\): unhydrated_after_retry/);
      assert.match(out, /indeed: paused until 2026-10-25T14:00:00.000Z after 1 failed scan: reason not recorded/);
    }
  });
  test('data built without text (an older caller) still says latched or paused and "reason not recorded"', () => {
    const d = data([{ source: 'a', manual: true, until: null }, { source: 'b', manual: false, until: '2026-10-25T00:00:00.000Z' }]);
    const t = renderReportText(d);
    assert.match(t, /a: disabled: reason not recorded/);
    assert.match(t, /b: paused until 2026-10-25T00:00:00.000Z: reason not recorded/);
  });
  test('HTML escapes the source, the kind, the detail and the url; text and markdown carry them verbatim', () => {
    const hostile = { source: '<b>src</b>', manual: true, until: null, text: 'auto-disabled after 1 failed scan (2026-10-12): <script>alert(1)</script>, <img src=x onerror=y> https://x.test/?a=1&b=2' };
    const html = renderReportHtml(data([hostile]));
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<b>src<\/b>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;b&gt;src&lt;\/b&gt;/);
    assert.match(html, /a=1&amp;b=2/);
    assert.match(renderReportText(data([hostile])), /<script>alert\(1\)<\/script>/);
  });
  test('an empty list still prints (none)', () => {
    for (const out of [renderReportText(data([])), renderReportHtml(data([])), renderReportMarkdown(data([]))]) assert.match(out, /\(none\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The Home / Runs panel against a minimal fake DOM
// ---------------------------------------------------------------------------------------------------------

describe('disabledSourcesPanel (Home and Runs)', () => {
  const created = /** @type {string[]} */ ([]);
  class FakeNode {
    /** @param {string} tag */
    constructor(tag) {
      this.tag = tag;
      created.push(tag);
      /** @type {any[]} */
      this.children = [];
      /** @type {Record<string, string>} */
      this.attributes = {};
      /** @type {Record<string, Function[]>} */
      this.listeners = {};
      this.dataset = /** @type {Record<string, string>} */ ({});
      this.className = '';
      this.nodeType = 1;
      this._text = '';
      this.disabled = false;
    }
    /** @param {string} v */
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join(''); }
    set innerHTML(_v) { throw new Error('innerHTML must never be set'); }
    /** @param {string} k @param {string} v */
    setAttribute(k, v) { this.attributes[k] = String(v); }
    /** @param {any} c */
    appendChild(c) { this.children.push(c); return c; }
    /** @param {string} evt @param {Function} fn */
    addEventListener(evt, fn) { (this.listeners[evt] ??= []).push(fn); }
    /** @returns {FakeNode[]} */
    all() { return [this, ...this.children.flatMap((c) => (c.nodeType === 3 ? [] : c.all()))]; }
    async click() { for (const fn of this.listeners.click ?? []) await fn({}); }
  }
  const realDocument = /** @type {any} */ (globalThis).document;
  const realLocation = /** @type {any} */ (globalThis).location;
  const realFetch = globalThis.fetch;
  /** @type {Array<{ url: string, init?: RequestInit }>} */
  let calls = [];
  before(() => {
    /** @type {any} */ (globalThis).document = {
      createElement: (/** @type {string} */ t) => new FakeNode(t),
      createTextNode: (/** @type {string} */ s) => ({ nodeType: 3, text: String(s) }),
      body: new FakeNode('body'),
    };
    /** @type {any} */ (globalThis).location = { origin: 'http://127.0.0.1:7311' };
    /** @type {any} */ (globalThis).fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, source: 'linkedin', enabled: true, already_enabled: false }), { status: 200 });
    };
  });
  after(() => {
    /** @type {any} */ (globalThis).document = realDocument;
    /** @type {any} */ (globalThis).location = realLocation;
    globalThis.fetch = realFetch;
  });

  const SRC = { source: 'linkedin', manual: true, until: null, snapshot: '2165-6471e56548-p1.html', text: 'auto-disabled after 3 failed scans (2026-10-08): <img src=x onerror=alert(1)>' };

  test('nothing disabled renders nothing', () => {
    assert.equal(disabledSourcesPanel({ sources: [], onChanged() {} }), null);
    assert.equal(disabledSourcesPanel({ sources: undefined, onChanged() {} }), null);
  });
  test('each source gets its sentence as text, a view-page link to the snapshot route, and a Re-enable button; hostile text creates no markup', () => {
    created.length = 0;
    const panel = /** @type {any} */ (disabledSourcesPanel({ sources: [SRC, { source: 'indeed', text: 'paused until x after 1 failed scan: reason not recorded', snapshot: null }], onChanged() {} }));
    assert.match(panel.textContent, /auto-disabled after 3 failed scans \(2026-10-08\): <img src=x onerror=alert\(1\)>/);
    assert.ok(!created.some((t) => ['img', 'script', 'svg', 'iframe'].includes(t)), created.join(','));
    const links = panel.all().filter((/** @type {FakeNode} */ n) => n.tag === 'a');
    assert.equal(links.length, 1, 'only the source with a snapshot gets a link');
    assert.equal(links[0].attributes.href, 'http://127.0.0.1:7311/api/wall-snapshots/2165-6471e56548-p1.html');
    assert.equal(links[0].textContent, 'view page');
    assert.equal(links[0].attributes.rel, 'noopener noreferrer');
    const buttons = panel.all().filter((/** @type {FakeNode} */ n) => n.tag === 'button');
    assert.deepEqual(buttons.map((/** @type {FakeNode} */ b) => b.textContent), ['Re-enable', 'Re-enable']);
    assert.match(panel.textContent, /no page saved/);
  });
  test('Re-enable POSTs to the existing route with Content-Type application/json, then refreshes the view', async () => {
    calls = [];
    let refreshed = 0;
    const panel = /** @type {any} */ (disabledSourcesPanel({ sources: [{ ...SRC, source: 'linkedin:detail' }], onChanged: () => { refreshed++; } }));
    const button = panel.all().find((/** @type {FakeNode} */ n) => n.tag === 'button');
    await button.click();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/sources/linkedin%3Adetail/enable');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(/** @type {any} */ (calls[0].init?.headers)['Content-Type'] ?? /** @type {any} */ (calls[0].init?.headers)['content-type'], 'application/json');
    assert.equal(refreshed, 1);
  });
  test('snapshotHref accepts only a plain .html file name; enablePath encodes the source', () => {
    for (const bad of ['../x.html', 'a/b.html', 'x.txt', '', null, 5, '.html', 'x.html/..']) assert.equal(snapshotHref(bad), null, String(bad));
    assert.equal(snapshotHref('9-ab-p1.html'), 'http://127.0.0.1:7311/api/wall-snapshots/9-ab-p1.html');
    assert.equal(enablePath('a b/c'), '/api/sources/a%20b%2Fc/enable');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Routes: summary, enable, disabled list, snapshot
// ---------------------------------------------------------------------------------------------------------

describe('dashboard routes', () => {
  /** @type {pg.Client} */ let client;
  /** @type {string} */ let root;
  /** @type {string} */ let snapDir;
  /** @type {ReturnType<typeof createDashboardServer>} */ let app;
  /** @type {number} */ let port;
  const SRC_A = `${TAG}-route`;

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await ensureAuxSchema(client);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-wallsurf-'));
    snapDir = path.join(root, 'linkedin-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, '2165-6471e56548-p1.html'), '<html><body><script>alert(document.domain)</script>skeleton</body></html>');
    fs.writeFileSync(path.join(snapDir, 'notes.txt'), 'not html');
    fs.writeFileSync(path.join(root, 'secret.html'), 'outside');
    const calendarFn = /** @type {any} */ (async () => null);
    calendarFn.lastState = () => null;
    const deps = {
      withClient, config: loadConfig(),
      env: { OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', GOOGLE_TOKEN_FILE: '', REMINDER_TO: '', SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: root, CHROME_EXECUTABLE: null, JOBSEARCH_LOG_DIR: root, JOBSEARCH_CONFIG_DIR: root, LOG_LEVEL: 'silent', PG_DSN: null },
      calendar: calendarFn, calendarCache: createCalendarCache(),
      scanRunner: { async start() { return { runId: 1, pid: 1 }; }, status: () => ({ running: false, runId: null, pid: null, startedAt: null }), armCancelBackstop: () => ({ forced_kill_available: false }) },
      outputRoot: root, snapshotDir: snapDir, version: 'test', startedAt: new Date().toISOString(), healthBanner: [],
    };
    app = createDashboardServer(/** @type {any} */ (deps));
    await app.listen(0, '127.0.0.1');
    port = /** @type {any} */ (app.server.address()).port;
  });
  after(async () => {
    await client.query('DELETE FROM ic_source_state WHERE source LIKE $1 OR source = $2', [`${TAG}%`, 'linkedin:detail']);
    await client.end();
    await app.close();
    await closePool();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** @param {string} method @param {string} p @param {unknown} [body] */
  async function req(method, p, body) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, headers: res.headers, text, json };
  }

  test('summary and /api/sources/disabled carry the sentence, the count, the dates and the snapshot name', async () => {
    await client.query('DELETE FROM ic_source_state WHERE source = $1', [SRC_A]);
    const base = Date.now() - 10 * DAY;
    for (let i = 0; i < 3; i++) await recordWall(client, SRC_A, new Date(base + i * DAY), { kind: 'unhydrated_after_retry', detail: 'x after one reload', snapshot: '2165-6471e56548-p1.html', runId: 7 });
    const s = await req('GET', '/api/summary');
    const row = s.json.disabled_sources.find((/** @type {any} */ x) => x.source === SRC_A);
    assert.ok(row);
    assert.equal(row.manual, true);
    assert.equal(row.count, 3);
    assert.equal(row.dates.length, 3);
    assert.equal(row.snapshot, '2165-6471e56548-p1.html');
    assert.match(row.text, /^auto-disabled after 3 failed scans \(\d{4}-\d{2}-\d{2}, \d{4}-\d{2}-\d{2}, \d{4}-\d{2}-\d{2}\): unhydrated_after_retry, x after one reload$/);
    const d = await req('GET', '/api/sources/disabled');
    assert.equal(d.status, 200);
    assert.ok(d.json.sources.some((/** @type {any} */ x) => x.source === SRC_A && x.text === row.text));
    const rep = await collectDisabledSources(client);
    assert.ok(rep.some((x) => x.source === SRC_A && x.text === row.text));
  });

  test('enable (the existing route) resets via the transaction: reset_at set, history kept, row leaves the list', async () => {
    const r = await req('POST', '/api/sources/linkedin/enable');
    assert.equal(r.status, 200);
    await client.query(`INSERT INTO ic_source_state (source, consecutive_walls, manual_disable) VALUES ('linkedin', 3, true) ON CONFLICT (source) DO UPDATE SET consecutive_walls = 3, manual_disable = true`);
    const r2 = await req('POST', '/api/sources/linkedin/enable');
    assert.equal(r2.status, 200);
    assert.equal(r2.json.already_enabled, false);
    const row = (await client.query(`SELECT consecutive_walls, manual_disable, reset_at FROM ic_source_state WHERE source = 'linkedin'`)).rows[0];
    assert.equal(row.manual_disable, false);
    assert.equal(row.consecutive_walls, 0);
    assert.ok(row.reset_at);
    await client.query(`DELETE FROM ic_source_state WHERE source = 'linkedin'`);
  });

  test('a latched <source>:detail key can be re-enabled from the UI route (its adapter is known)', async () => {
    await client.query(`INSERT INTO ic_source_state (source, consecutive_walls, manual_disable) VALUES ('linkedin:detail', 3, true) ON CONFLICT (source) DO UPDATE SET consecutive_walls = 3, manual_disable = true`);
    const r = await req('POST', `/api/sources/${encodeURIComponent('linkedin:detail')}/enable`);
    assert.equal(r.status, 200);
    assert.equal(r.json.source, 'linkedin:detail');
    assert.equal((await client.query(`SELECT manual_disable FROM ic_source_state WHERE source = 'linkedin:detail'`)).rows[0].manual_disable, false);
    assert.equal((await req('POST', `/api/sources/${encodeURIComponent('nope:detail')}/enable`)).status, 404);
  });

  test('snapshot route: serves the file as text with the sandbox CSP, nosniff and no cache', async () => {
    const r = await req('GET', '/api/wall-snapshots/2165-6471e56548-p1.html');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-type') ?? '', /^text\/plain/);
    assert.match(r.text, /<script>alert\(document.domain\)<\/script>/, 'served as inert text');
  });
  for (const [label, name] of /** @type {Array<[string, string]>} */ ([
    ['parent traversal (encoded slash)', '..%2Fsecret.html'],
    ['double traversal', '..%2F..%2Fsecret.html'],
    ['encoded dots', '%2e%2e%2fsecret.html'],
    ['a backslash', '..%5Csecret.html'],
    ['an absolute path', '%2Fetc%2Fpasswd.html'],
    ['a drive path', 'C%3A%5Cwindows%5Cwin.html'],
    ['a non-html extension', 'notes.txt'],
    ['a double extension', 'notes.txt.html'],
    ['no extension', 'notes'],
    ['a missing file', 'missing.html'],
    ['dotdot in the name', 'a..b.html'],
    ['a leading dot', '.hidden.html'],
    ['a NUL byte', 'x%00.html'],
  ])) {
    test(`snapshot route refuses ${label}`, async () => {
      const r = await req('GET', `/api/wall-snapshots/${name}`);
      assert.equal(r.status, 404, `${name} -> ${r.status}`);
      assert.doesNotMatch(r.text, /outside|not html/);
    });
  }
  test('snapshot route refuses a symlink, and a snapshot directory that is itself a link may not escape it', async (t) => {
    const link = path.join(snapDir, 'link.html');
    try {
      fs.symlinkSync(path.join(root, 'secret.html'), link);
    } catch {
      t.skip('symlinks are not permitted in this environment');
      return;
    }
    assert.equal((await req('GET', '/api/wall-snapshots/link.html')).status, 404);
    assert.equal(resolveSnapshot(snapDir, 'link.html'), null);
    fs.rmSync(link);
  });
  test('resolveSnapshot is total: non-strings, long names and a missing directory give null', () => {
    for (const bad of [undefined, null, 5, {}, 'x'.repeat(300) + '.html']) assert.equal(resolveSnapshot(snapDir, bad), null);
    assert.equal(resolveSnapshot(path.join(root, 'nope'), 'x.html'), null);
    assert.ok(resolveSnapshot(snapDir, '2165-6471e56548-p1.html'));
  });
});

// ---------------------------------------------------------------------------------------------------------
// runScan: dry runs never write source state; a permanent skeleton is one wall
// ---------------------------------------------------------------------------------------------------------

describe('runScan over a permanent LinkedIn skeleton', () => {
  const PROFILE = `${TAG}-profile`;
  /** @type {import('pg').Client} */ let c;
  /** @type {string} */ let logDir;
  /** @type {any} */ let saved;

  const stateRow = async (/** @type {string} */ s) => (await c.query('SELECT * FROM ic_source_state WHERE source = $1', [s])).rows[0] ?? null;

  before(async () => {
    c = await newClient();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-wallscan-'));
    saved = (await c.query(`SELECT * FROM ic_source_state WHERE source = 'linkedin'`)).rows[0] ?? null;
    await upsertTestProfile(c, PROFILE, { sources: ['linkedin'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
  });
  after(async () => {
    try {
      await c.query(`DELETE FROM ic_source_state WHERE source = 'linkedin'`);
      if (saved) {
        await c.query(
          `INSERT INTO ic_source_state (source, disabled_until, consecutive_walls, last_wall_at, manual_disable) VALUES ($1, $2, $3, $4, $5)`,
          [saved.source, saved.disabled_until, saved.consecutive_walls, saved.last_wall_at, saved.manual_disable],
        );
      }
      await cleanupScan(c, { profile: PROFILE });
    } finally {
      await c.end();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  const depsWith = (/** @type {ReturnType<typeof makeFakeSession>} */ fake) => offlineDeps({ connectSession: fake.connectSession, env: { ...getEnv(), JOBSEARCH_LOG_DIR: logDir } });

  test('a dry run reports the wall (errors[], partial) but never writes ic_source_state', async () => {
    await c.query(`DELETE FROM ic_source_state WHERE source = 'linkedin'`);
    const fake = makeFakeSession({ emptyState: false });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['linkedin'], dryRun: true, wait: true }, depsWith(fake), { trigger: 'mcp', log: () => {} });
    const walls = r.errors.filter((/** @type {any} */ e) => e.source === 'linkedin' && e.code === 'UNRECOGNIZED_PAGE');
    assert.equal(walls.length, 1, JSON.stringify(r.errors));
    assert.match(walls[0].message, /dry run, source state not changed/);
    assert.equal(r.status, 'partial');
    assert.equal(await stateRow('linkedin'), null, 'no row was created');
    assert.equal(fake.state.reloads, 1, 'the dry run still reloaded once like a real run');
  });

  test('a dry run leaves an existing row exactly as it was', async () => {
    await c.query(`INSERT INTO ic_source_state (source, consecutive_walls, manual_disable, wall_history) VALUES ('linkedin', 2, false, '[]') ON CONFLICT (source) DO UPDATE SET consecutive_walls = 2, manual_disable = false, disabled_until = NULL, wall_history = '[]', last_wall_kind = NULL, reset_at = NULL`);
    const before = await stateRow('linkedin');
    const fake = makeFakeSession({ emptyState: false });
    await runScanWaiting({ profile: PROFILE, sources: ['linkedin'], dryRun: true, wait: true }, depsWith(fake), { trigger: 'mcp', log: () => {} });
    assert.deepEqual(await stateRow('linkedin'), before);
  });

  test('a real run over a permanent skeleton: exactly one wall, one reload, the source ends, and the reason is stored', async () => {
    await c.query(`DELETE FROM ic_source_state WHERE source = 'linkedin'`);
    const fake = makeFakeSession({ emptyState: false });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['linkedin'], dryRun: false, wait: true }, depsWith(fake), { trigger: 'mcp', log: () => {} });
    const walls = r.errors.filter((/** @type {any} */ e) => e.source === 'linkedin' && e.code === 'UNRECOGNIZED_PAGE');
    assert.equal(walls.length, 1);
    assert.equal(fake.state.reloads, 1);
    const row = await stateRow('linkedin');
    assert.equal(row.consecutive_walls, 1);
    assert.equal(row.last_wall_kind, 'unhydrated_after_retry');
    assert.match(row.last_wall_detail, /after one reload/);
    assert.equal(String(row.last_wall_run_id), String(r.run_id));
    assert.match(row.last_wall_url, /^https:\/\/www\.linkedin\.com\/jobs\/search\//);
    assert.match(row.last_wall_snapshot, /^\d+-[0-9a-f]{10}-p1\.html$/);
    assert.equal(row.wall_history.length, 1);
    assert.ok(fs.existsSync(path.join(logDir, 'linkedin-snapshots', row.last_wall_snapshot)), 'the snapshot file exists under the log dir');
  });
});
