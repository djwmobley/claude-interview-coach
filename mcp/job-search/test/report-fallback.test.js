// @ts-check
/**
 * Non-Gmail report delivery (spec G): the toast and browser fallback through an INJECTED spawner (no real
 * powershell, toast or browser is ever started), the real-spawn guard under the test runner, and runRemind's
 * behavior when the report cannot be emailed (auth broken, send error): files written, fallback invoked,
 * nonzero exit code, delivery path recorded, capability line first.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createFollowup } from '../src/core/followups.js';
import { runRemind } from '../src/core/remind.js';
import { deliverFallback, buildToastPayload, htmlSiblingOf } from '../src/core/report-fallback.js';

/** A spawner double that records its calls and never starts anything. */
function fakeSpawn() {
  /** @type {Array<{ cmd: string, args: string[], opts: any }>} */
  const calls = [];
  const spawn = /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    calls.push({ cmd, args, opts });
    return { once() {}, unref() {} };
  });
  return { spawn, calls };
}

let tmp = '';
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-fallback-test-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('deliverFallback', () => {
  test('spawns plain `powershell -NoProfile -File <script> <payload>` (never an encoded command) through the injected spawner', async () => {
    const md = path.join(tmp, '2026-10-24-scan-report.md');
    const html = path.join(tmp, '2026-10-24-scan-report.html');
    fs.writeFileSync(md, '# report');
    fs.writeFileSync(html, '<html></html>');
    const { spawn, calls } = fakeSpawn();
    const r = await deliverFallback({ problem: 'Gmail auth is broken_invalid_grant', reportFile: md, spawnImpl: spawn, platform: 'win32', tmpDir: tmp, scriptPath: 'C:\\x\\report-fallback.ps1', now: new Date(1) });
    assert.equal(r.path, 'toast_browser');
    assert.equal(r.spawned, true);
    assert.equal(r.html_opened, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell');
    assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-File', 'C:\\x\\report-fallback.ps1']);
    assert.equal(calls[0].args.length, 4, 'exactly the flags, the script and the payload path');
    const payload = JSON.parse(fs.readFileSync(calls[0].args[3], 'utf8'));
    assert.match(payload.title, /not emailed/);
    assert.ok(payload.message.includes('Gmail auth is broken_invalid_grant'));
    assert.ok(payload.message.includes(md), 'the toast names the report path');
    assert.equal(payload.html, html);
  });

  test('without an HTML sibling the toast still goes and nothing claims the browser opened', async () => {
    const md = path.join(tmp, 'lonely-scan-report.md');
    fs.writeFileSync(md, '# report');
    const { spawn } = fakeSpawn();
    const r = await deliverFallback({ problem: 'x', reportFile: md, spawnImpl: spawn, platform: 'win32', tmpDir: tmp, scriptPath: 's.ps1' });
    assert.equal(r.html_opened, false);
    assert.equal(htmlSiblingOf(md), null);
  });

  test('no report file at all: the toast says so', () => {
    assert.match(buildToastPayload({ problem: 'Gmail send failed', reportFile: null }).message, /No report file was written/);
  });

  test('a long problem is truncated to a toast-sized message', () => {
    assert.ok(buildToastPayload({ problem: 'p'.repeat(1000), reportFile: null }).message.length <= 240);
  });

  test('not Windows: no spawn, a defined result', async () => {
    const { spawn, calls } = fakeSpawn();
    const r = await deliverFallback({ problem: 'x', reportFile: null, spawnImpl: spawn, platform: 'linux' });
    assert.deepEqual([r.path, r.reason, calls.length], ['none', 'not_windows', 0]);
  });

  test('a spawner that throws yields a none result with the error, never a throw', async () => {
    const r = await deliverFallback({ problem: 'x', reportFile: null, spawnImpl: /** @type {any} */ (() => { throw new Error('spawn EPERM'); }), platform: 'win32', tmpDir: tmp, scriptPath: 's.ps1' });
    assert.equal(r.path, 'none');
    assert.match(r.error ?? '', /EPERM/);
  });

  test('the REAL spawn is blocked under the test runner before anything launches (no opt-in)', async () => {
    const r = await deliverFallback({ problem: 'x', reportFile: null, platform: 'win32', tmpDir: tmp });
    assert.equal(r.path, 'none');
    assert.match(r.error ?? '', /real_shell_blocked_in_tests/);
  });
});

describe('runRemind when the report cannot be emailed', () => {
  /** @type {pg.Client} */
  let client;
  const MARK = `ZZ-TEST-RF-${process.pid}`;
  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await ensureAuxSchema(client);
  });
  beforeEach(async () => {
    await client.query('DELETE FROM ic_google_capability');
    await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-RF-%']);
    await createFollowup(client, { contact: `${MARK} due`, due_at: '2026-10-24T15:00:00Z', channel: 'phone', action: 'x' });
  });
  after(async () => {
    await client.query('DELETE FROM ic_google_capability');
    await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-RF-%']);
    await client.end();
  });

  const now = new Date('2026-10-24T12:00:00Z');
  const brokenGoogle = (/** @type {any} */ tokenState) => /** @type {any} */ (async () => {
    const err = /** @type {any} */ (new Error('google token refresh failed'));
    err.tokenState = tokenState;
    throw err;
  });

  test('auth broken: report files written, fallback invoked once, exit code stays 1, delivery recorded, banner is the first report line', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    /** @type {any[]} */
    const fallbackCalls = [];
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, googleHttp: brokenGoogle({ state: 'broken_invalid_grant' }), writeReportFileRoot: root,
      deliverFallback: /** @type {any} */ (async (/** @type {any} */ a) => { fallbackCalls.push(a); return { path: 'toast_browser', spawned: true, html_opened: true, error: null, reason: null }; }),
    });
    assert.equal(r.code, 1);
    assert.equal(r.sent, false);
    assert.equal(r.delivery, 'fallback_toast_browser');
    assert.equal(fallbackCalls.length, 1);
    assert.match(fallbackCalls[0].problem, /broken_invalid_grant/);
    assert.equal(fallbackCalls[0].reportFile, r.report_file);
    assert.ok(r.report_file && fs.existsSync(r.report_file), 'the markdown report was written');
    assert.ok(fs.existsSync(r.report_file.replace(/\.md$/, '.html')), 'the html report was written');
    const firstLine = fs.readFileSync(r.report_file, 'utf8').split('\n')[0];
    assert.match(firstLine, /^\*\*Gmail read, Gmail send, Google calendar BROKEN since 2026-10-24 \(0 days\): last good read never, last good send never, last good calendar never\. Re-authorize on dashboard\.\*\*$/);
  });

  test('send error after a good refresh: fallback invoked, code 1, send recorded as broken while read stays OK', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    let fallbackCalls = 0;
    const goodGoogle = /** @type {any} */ (async () => ({ deps: { fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }), accessToken: 't' }, info: { has_refresh_token: true, gmail_send_ok: true, gmail_read_ok: true, calendar_ok: true }, expiry: null }));
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, googleHttp: goodGoogle, writeReportFileRoot: root,
      deliverFallback: /** @type {any} */ (async () => { fallbackCalls++; return { path: 'toast_browser', spawned: true, html_opened: true, error: null, reason: null }; }),
    });
    assert.equal(r.code, 1);
    assert.equal(r.delivery, 'fallback_toast_browser');
    assert.equal(fallbackCalls, 1);
    const rows = (await client.query('SELECT capability, broken_since, last_state FROM ic_google_capability ORDER BY capability')).rows;
    const by = Object.fromEntries(rows.map((x) => [x.capability, x]));
    assert.equal(by.send.last_state, 'send_error');
    assert.ok(by.send.broken_since);
    assert.equal(by.read.broken_since, null);
  });

  test('a fallback that reports it could not run is recorded as unavailable and still never changes the exit code', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, googleHttp: brokenGoogle({ state: 'broken_no_refresh_token' }), writeReportFileRoot: root,
      deliverFallback: /** @type {any} */ (async () => ({ path: 'none', spawned: false, html_opened: false, error: 'spawn EPERM', reason: 'spawn_failed' })),
    });
    assert.equal(r.code, 1);
    assert.equal(r.delivery, 'fallback_unavailable');
  });

  test('a fallback that throws is swallowed', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, googleHttp: brokenGoogle({ state: 'broken_invalid_grant' }), writeReportFileRoot: root,
      deliverFallback: /** @type {any} */ (async () => { throw new Error('boom'); }),
    });
    assert.equal(r.code, 1);
    assert.equal(r.delivery, 'fallback_unavailable');
  });

  test('a successful send records email delivery, marks send good, and never calls the fallback', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    let fallbackCalls = 0;
    const okFetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ id: 'm1' }) }));
    const goodGoogle = /** @type {any} */ (async () => ({ deps: { fetch: okFetch, accessToken: 't' }, info: { has_refresh_token: true, gmail_send_ok: true, gmail_read_ok: true, calendar_ok: true }, expiry: null }));
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, googleHttp: goodGoogle, writeReportFileRoot: root,
      deliverFallback: /** @type {any} */ (async () => { fallbackCalls++; return { path: 'none', spawned: false, html_opened: false, error: null, reason: null }; }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.sent, true);
    assert.equal(r.delivery, 'email');
    assert.equal(fallbackCalls, 0);
    const rows = (await client.query('SELECT capability, broken_since FROM ic_google_capability')).rows;
    assert.ok(rows.length >= 1 && rows.every((x) => x.broken_since === null));
  });

  test('a dry run records nothing in the capability table and never calls the fallback', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    let fallbackCalls = 0;
    await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, dryRun: true, googleHttp: brokenGoogle({ state: 'broken_invalid_grant' }), writeReportFileRoot: root,
      deliverFallback: /** @type {any} */ (async () => { fallbackCalls++; return { path: 'none', spawned: false, html_opened: false, error: null, reason: null }; }),
    });
    assert.equal(fallbackCalls, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM ic_google_capability')).rows[0].n, 0);
  });
});
