// @ts-check
/**
 * Runtime guard tests (2026-10-15): every production entry point that can start a real browser, open an
 * OS URL handler, or run real Chrome process control throws real_browser_blocked_in_tests when called
 * WITHOUT injection under the test runner. Each assertion proves nothing was launched: the throw happens
 * before any spawn, connect, or process listing. Skipped only when the operator opted in by hand.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertRealBrowserAllowed, realBrowserBlocked, RealBrowserBlockedError, REAL_BROWSER_BLOCKED } from '../src/core/test-guard.js';
import { killProcessTree } from '../src/core/chrome-launch.js';
import { launchOsBrowser, launchOsBrowserDiagnosed, openDashboard } from '../src/core/open-dashboard.js';
import { connectSession } from '../src/browser/session.js';
import { launchChrome } from '../bin/scan.js';
import { register as registerDocumentRoutes } from '../src/dashboard/routes/documents.js';

const OPTED_IN = process.env.JOBSEARCH_BROWSER_TESTS === '1';
const BLOCKED = /real_browser_blocked_in_tests/;

describe('test-guard unit', () => {
  test('blocked under NODE_TEST_CONTEXT or JOBSEARCH_TEST_GUARD=1, unless JOBSEARCH_BROWSER_TESTS=1', () => {
    assert.equal(realBrowserBlocked({}), false, 'outside the test runner the guard is a no-op');
    assert.equal(realBrowserBlocked({ NODE_TEST_CONTEXT: 'child-v8' }), true);
    assert.equal(realBrowserBlocked({ JOBSEARCH_TEST_GUARD: '1' }), true);
    assert.equal(realBrowserBlocked({ JOBSEARCH_TEST_GUARD: '0' }), false);
    assert.equal(realBrowserBlocked({ NODE_TEST_CONTEXT: 'child-v8', JOBSEARCH_BROWSER_TESTS: '1' }), false);
    assert.equal(realBrowserBlocked({ JOBSEARCH_TEST_GUARD: '1', JOBSEARCH_BROWSER_TESTS: 'yes' }), true, 'only the exact value 1 opts in');
  });

  test('assertRealBrowserAllowed throws the named error and passes when allowed', () => {
    assert.throws(() => assertRealBrowserAllowed('launch x', { JOBSEARCH_TEST_GUARD: '1' }), (err) => {
      return err instanceof RealBrowserBlockedError && /** @type {any} */ (err).code === REAL_BROWSER_BLOCKED && BLOCKED.test(err.message);
    });
    assert.doesNotThrow(() => assertRealBrowserAllowed('launch x', {}));
    assert.doesNotThrow(() => assertRealBrowserAllowed('launch x', { JOBSEARCH_TEST_GUARD: '1', JOBSEARCH_BROWSER_TESTS: '1' }));
  });

  test('the test runner itself is detected (NODE_TEST_CONTEXT and/or the marker bin/run-tests.js sets)', { skip: OPTED_IN }, () => {
    assert.equal(realBrowserBlocked(), true);
  });
});

describe('unguarded entry points throw under the test runner (nothing launches)', { skip: OPTED_IN }, () => {
  test('chrome-launch: real taskkill (the powershell listing is in real-shell-guard.test.js)', async () => {
    await assert.rejects(() => killProcessTree(1), BLOCKED);
  });

  test('open-dashboard: real spawn of the OS URL handler (both variants)', async () => {
    await assert.rejects(() => launchOsBrowser({ dashboardUrl: 'http://127.0.0.1:7311/', spawnImpl: spawn, platform: process.platform }), BLOCKED);
    await assert.rejects(() => launchOsBrowserDiagnosed({ url: 'http://127.0.0.1:7311/', spawnImpl: spawn, platform: process.platform }), BLOCKED);
  });

  test('open-dashboard: openDashboard with real fetch and WebSocket', async () => {
    // openDashboard never throws by design: the blocked CDP attempt is logged as the cdp failure, and with no
    // spawnImpl injected the OS fallback cannot run either, so the result is ok:false and nothing launched.
    /** @type {Record<string, any>[]} */
    const lines = [];
    const r = await openDashboard({ dashboardUrl: 'http://127.0.0.1:7311/', cdpUrl: 'http://127.0.0.1:9333', log: (f) => lines.push(f) });
    assert.equal(r.ok, false);
    const fail = lines.find((l) => l.evt === 'open_dashboard_failed');
    assert.ok(fail && BLOCKED.test(String(fail.cdp_err_message)), JSON.stringify(lines));
    // The WebSocket path: constructing the default (real) WebSocket class throws before connecting.
    assert.ok(lines.length === 1);
  });

  test('browser/session: connectSession without an injected chromium', async () => {
    await assert.rejects(() => connectSession({ cdpUrl: 'http://127.0.0.1:9333' }), BLOCKED);
  });

  test('bin/scan: launchChrome with the real spawn never starts Chrome', async () => {
    /** @type {Record<string, any>[]} */
    const events = [];
    const env = /** @type {any} */ ({ SCAN_CDP_URL: 'http://127.0.0.1:9333', CHROME_EXECUTABLE: 'C:\\fake\\chrome.exe', SCAN_PROFILE_DIR: path.join(os.tmpdir(), 'jobsearch-guard-test-profile') });
    try {
      await launchChrome(env, (e) => events.push(e), { probe: async () => false, listProcesses: async () => [], killTree: async () => true, sleep: async () => {} });
    } catch { /* the failure path is allowed to throw; what matters is the evidence below */ }
    assert.ok(!events.some((e) => e.evt === 'chrome_launched'), 'no chrome_launched event');
    assert.ok(events.some((e) => e.evt === 'chrome_spawn_failed' && BLOCKED.test(String(e.err_message))), `expected a blocked spawn, got ${JSON.stringify(events)}`);
  });

  test('dashboard documents route: open and reveal via explorer/rundll32', { skip: process.platform !== 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-guard-docs-'));
    try {
      fs.mkdirSync(path.join(root, 'markdown'));
      fs.writeFileSync(path.join(root, 'markdown', 'a.txt'), 'x');
      /** @type {Record<string, Function>} */
      const handlers = {};
      registerDocumentRoutes(/** @type {any} */ ({ register: (m, p, h) => { handlers[`${m} ${p}`] = h; } }), /** @type {any} */ ({ outputRoot: root }));
      const h = handlers['POST /api/documents/open'];
      assert.ok(h, 'route registered');
      for (const reveal of [false, true]) {
        await assert.rejects(() => h({ body: { path: 'markdown/a.txt', reveal }, res: {}, query: {}, params: {} }), BLOCKED);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
