// @ts-check
/**
 * src/dashboard/apply-runner.js (apply pipeline slice 5): marker-file correlation, single-flight,
 * LOCKED handling, and the cancel/hard-timeout backstops -- copies test/dashboard-scan-runner.test.js's
 * own pattern exactly (a fake EventEmitter child process, a real temp marker file).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApplyRunner } from '../src/dashboard/apply-runner.js';
import { JobSearchError } from '../src/core/errors.js';
import { DashboardError } from '../src/dashboard/http.js';

/** @type {string} */
let logDir;

before(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-applyrunner-'));
});
after(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

/** @param {{ mode: 'resolve'|'exit'|'timeout', applicationId?: number, exitCode?: number, delayMs?: number }} opts */
function makeFakeSpawn(opts) {
  const delayMs = opts.delayMs ?? 30;
  /** @type {any} */
  let lastChild = null;
  const spawnFn = (/** @type {string} */ node, /** @type {string[]} */ args) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 5252;
    child.stderr = new EventEmitter();
    child.unref = () => {};
    lastChild = child;
    const markerPath = args[args.indexOf('--run-marker') + 1];
    setTimeout(() => {
      if (opts.mode === 'resolve') {
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(markerPath, JSON.stringify({ application_id: opts.applicationId ?? 555 }));
      } else if (opts.mode === 'exit') {
        child.emit('exit', opts.exitCode ?? 1);
      }
    }, delayMs);
    return child;
  };
  return { spawnFn, getLastChild: () => lastChild };
}

describe('createApplyRunner.start', () => {
  test('marker appears -> resolves {applicationId, pid}', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'resolve', applicationId: 777 });
    const runner = createApplyRunner({ env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: spawnFn, cancelBackstopMs: 100000, hardTimeoutMs: 100000 });
    const result = await runner.start(777);
    assert.equal(result.applicationId, 777);
    assert.equal(result.pid, 5252);
    const status = runner.status();
    assert.equal(status.running, true);
    assert.equal(status.applicationId, 777);
  });

  test('rejects a non-positive-integer applicationId before spawning', async () => {
    let spawnCalled = false;
    const runner = createApplyRunner({ env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: () => { spawnCalled = true; throw new Error('should never spawn'); } });
    await assert.rejects(() => runner.start(0), (err) => err instanceof JobSearchError && err.code === 'VALIDATION');
    await assert.rejects(() => runner.start(-1), (err) => err instanceof JobSearchError && err.code === 'VALIDATION');
    await assert.rejects(() => runner.start(1.5), (err) => err instanceof JobSearchError && err.code === 'VALIDATION');
    assert.equal(spawnCalled, false);
  });

  test('a second start() while one is already tracked as running is refused LOCKED without spawning ("one application at a time")', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'resolve', applicationId: 901, delayMs: 200 });
    const runner = createApplyRunner({ env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: spawnFn, cancelBackstopMs: 100000, hardTimeoutMs: 100000 });
    const first = runner.start(901);
    await assert.rejects(() => runner.start(902), (err) => err instanceof JobSearchError && err.code === 'LOCKED');
    await first;
  });

  test('marker never appears -> rejects APPLY_START_TIMEOUT within markerTimeoutMs, and status returns to not-running', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'timeout' });
    const runner = createApplyRunner({ env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: spawnFn, markerTimeoutMs: 60, cancelBackstopMs: 100000, hardTimeoutMs: 100000 });
    await assert.rejects(() => runner.start(1), (err) => err instanceof DashboardError && err.code === 'APPLY_START_TIMEOUT');
    assert.equal(runner.status().running, false);
  });

  test('the child exiting with code 2 before the marker appears is reported as LOCKED (another scan or apply run holds the lock)', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'exit', exitCode: 2, delayMs: 10 });
    const runner = createApplyRunner({ env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: spawnFn, markerTimeoutMs: 5000, cancelBackstopMs: 100000, hardTimeoutMs: 100000 });
    await assert.rejects(() => runner.start(1), (err) => err instanceof JobSearchError && err.code === 'LOCKED');
    assert.equal(runner.status().running, false);
  });

  test('the child exiting with a non-2 code before the marker appears is APPLY_START_FAILED', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'exit', exitCode: 7, delayMs: 10 });
    const runner = createApplyRunner({ env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: spawnFn, markerTimeoutMs: 5000, cancelBackstopMs: 100000, hardTimeoutMs: 100000 });
    await assert.rejects(() => runner.start(1), (err) => err instanceof DashboardError && err.code === 'APPLY_START_FAILED');
  });
});

describe('createApplyRunner.armCancelBackstop', () => {
  test('forced_kill_available is true only when THIS process spawned and is still tracking that applicationId', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'resolve', applicationId: 42 });
    const runner = createApplyRunner({ env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: spawnFn, cancelBackstopMs: 100000, hardTimeoutMs: 100000 });
    await runner.start(42);
    assert.equal(runner.armCancelBackstop(42).forced_kill_available, true);
    assert.equal(runner.armCancelBackstop(999).forced_kill_available, false);
  });

  test('taskkill fires after cancelBackstopMs if still tracking the same pid', async () => {
    const killed = [];
    const { spawnFn } = makeFakeSpawn({ mode: 'resolve', applicationId: 11 });
    const runner = createApplyRunner({
      env: {}, logDir, applyScript: path.join(logDir, 'fake-apply.js'), spawn: spawnFn,
      cancelBackstopMs: 20, hardTimeoutMs: 100000,
      execFile: (cmd, args, cb) => { killed.push({ cmd, args }); cb(null, '', ''); },
    });
    await runner.start(11);
    runner.armCancelBackstop(11);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(killed.some((k) => k.cmd === 'taskkill'));
  });
});
