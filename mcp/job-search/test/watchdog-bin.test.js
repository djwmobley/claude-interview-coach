// @ts-check
/**
 * bin/watchdog.js pure-function unit test: the lock file path helper. The CLI's own main() (env/logging/
 * spawn wiring) is covered indirectly by src/dashboard/watchdog.js's runWatchdog tests (test/watchdog.test.js);
 * this file never runs main() or touches a real port, matching bin/dashboard.js's own test/dashboard-bin.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { watchdogLockFile } from '../bin/watchdog.js';

describe('watchdogLockFile', () => {
  test('joins logDir with the fixed lock filename, distinct from the state file name', () => {
    assert.equal(watchdogLockFile('/a/b'), path.join('/a/b', 'watchdog-start.lock'));
  });
});
