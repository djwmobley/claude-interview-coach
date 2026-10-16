// @ts-check
/**
 * Runtime guard tests (2026-10-15): tests never spawn real powershell (Defender flags it). Every production
 * entry point that spawns powershell.exe throws real_shell_blocked_in_tests when called WITHOUT an injected
 * exec under the test runner. There is no opt-in variable: JOBSEARCH_BROWSER_TESTS=1 does not unblock it.
 * The throw happens before any spawn, which is what proves nothing launched.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertRealShellAllowed, RealShellBlockedError, REAL_SHELL_BLOCKED } from '../src/core/test-guard.js';
import { listScanProfileProcesses } from '../src/core/chrome-launch.js';
import { getProcessInfo } from '../src/dashboard/watchdog.js';
import { realLayers } from '../src/core/dashboard-restart.js';
import { readCredential, writeCredential, deleteCredential, listCredentials, credentialTarget } from '../src/core/credentials.js';

const BLOCKED = /real_shell_blocked_in_tests/;

describe('real shell guard unit', () => {
  test('blocks under the test runner markers, with no opt-in', () => {
    assert.throws(() => assertRealShellAllowed('x', { NODE_TEST_CONTEXT: 'child-v8' }), (e) => e instanceof RealShellBlockedError && /** @type {any} */ (e).code === REAL_SHELL_BLOCKED);
    assert.throws(() => assertRealShellAllowed('x', { JOBSEARCH_TEST_GUARD: '1' }), BLOCKED);
    assert.throws(() => assertRealShellAllowed('x', { JOBSEARCH_TEST_GUARD: '1', JOBSEARCH_BROWSER_TESTS: '1' }), BLOCKED, 'the browser opt-in never unblocks powershell');
    assert.doesNotThrow(() => assertRealShellAllowed('x', {}));
  });
});

describe('unguarded powershell entry points throw under the test runner (nothing spawns)', () => {
  test('chrome-launch: listScanProfileProcesses', async () => {
    await assert.rejects(() => listScanProfileProcesses('x'), BLOCKED);
  });

  test('watchdog: getProcessInfo', async () => {
    await assert.rejects(async () => getProcessInfo(1), BLOCKED);
    assert.throws(() => getProcessInfo(1), BLOCKED);
  });

  test('dashboard-restart: realLayers.processInfo and findByScript', async () => {
    const layers = realLayers({ port: 7311, script: 'bin/dashboard.js', pidFile: 'x.pid', repoRoot: '.' });
    await assert.rejects(() => layers.processInfo(1), BLOCKED);
    await assert.rejects(() => layers.findByScript(), BLOCKED);
  });

  test('credentials: read, write, delete and list with the real execFile', async () => {
    const target = credentialTarget('boards.greenhouse.io');
    await assert.rejects(() => readCredential(target), BLOCKED);
    await assert.rejects(() => writeCredential(target, 'a@b.com', 'pw'), BLOCKED);
    await assert.rejects(() => deleteCredential(target), BLOCKED);
    await assert.rejects(() => listCredentials(), BLOCKED);
  });
});
