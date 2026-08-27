// @ts-check
/**
 * src/dashboard/scan-runner.js: marker-file correlation race (pr2-spec-decisions.md "Scan runner"). The
 * child process is a fake EventEmitter; the "marker file" is a real temp file this test writes directly,
 * exactly like bin/scan.js's --run-marker would, so the polling logic under test is real.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createScanRunner, LOCKED_EXIT_CODE } from '../src/dashboard/scan-runner.js';
import { JobSearchError } from '../src/core/errors.js';
import { DashboardError } from '../src/dashboard/http.js';

/** @type {string} */
let logDir;

before(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-scanrunner-'));
});
after(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

/** @param {{ mode: 'resolve'|'exit'|'timeout', runId?: number, exitCode?: number, delayMs?: number }} opts */
function makeFakeSpawn(opts) {
  const delayMs = opts.delayMs ?? 30;
  /** @type {any} */
  let lastChild = null;
  const spawnFn = (/** @type {string} */ node, /** @type {string[]} */ args) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 4242;
    child.stderr = new EventEmitter();
    child.unref = () => {};
    lastChild = child;
    const markerPath = args[args.indexOf('--run-marker') + 1];
    const jsonPath = args[args.indexOf('--json') + 1];
    setTimeout(() => {
      if (opts.mode === 'resolve') {
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify({ ok: true }));
        fs.writeFileSync(markerPath, JSON.stringify({ run_id: opts.runId ?? 555 }));
      } else if (opts.mode === 'exit') {
        child.emit('exit', opts.exitCode ?? 1);
      }
      // 'timeout': do nothing; the caller's own short markerTimeoutMs fires instead.
    }, delayMs);
    return child;
  };
  return { spawnFn, getLastChild: () => lastChild };
}

const okConfigLock = () => ({ ok: true, expected: 'x', actual: 'x' });
const mismatchConfigLock = () => ({ ok: false, expected: 'x', actual: 'y' });

describe('createScanRunner.start', () => {
  test('marker appears -> resolves {runId, pid}; json output renamed to the canonical name', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'resolve', runId: 777 });
    const runner = createScanRunner({ env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock });
    const result = await runner.start({ profile: 'exec-default' });
    assert.equal(result.runId, 777);
    assert.equal(result.pid, 4242);
    const finalJson = fs.readdirSync(logDir).find((f) => f === 'scan-run-777.json');
    assert.ok(finalJson, 'expected scan-run-777.json to exist after marker resolution');
    const status = runner.status();
    assert.equal(status.running, true);
    assert.equal(status.runId, 777);
  });

  test('CONFIG_LOCK_MISMATCH refuses before spawning', async () => {
    let spawnCalled = false;
    const runner = createScanRunner({
      env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'),
      spawn: () => { spawnCalled = true; throw new Error('should never spawn'); },
      checkConfigLock: mismatchConfigLock,
    });
    await assert.rejects(runner.start({}), (err) => err instanceof JobSearchError && err.code === 'CONFIG_LOCK_MISMATCH');
    assert.equal(spawnCalled, false);
  });

  test('a second start() while one is already tracked as running is refused LOCKED without spawning', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'resolve', runId: 901, delayMs: 200 });
    const runner = createScanRunner({ env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock });
    const first = runner.start({});
    await assert.rejects(runner.start({}), (err) => err instanceof JobSearchError && err.code === 'LOCKED');
    await first; // let the first one finish so it does not leak into later tests
  });

  test('child exits with the locked exit code before the marker -> LOCKED', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'exit', exitCode: LOCKED_EXIT_CODE });
    const runner = createScanRunner({ env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock });
    await assert.rejects(runner.start({}), (err) => err instanceof JobSearchError && err.code === 'LOCKED');
    assert.equal(runner.status().running, false);
  });

  test('child exits with any other code before the marker -> SCAN_START_FAILED with exit code and stderr tail', async () => {
    const { spawnFn, getLastChild } = makeFakeSpawn({ mode: 'exit', exitCode: 1, delayMs: 20 });
    const runner = createScanRunner({ env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock });
    const p = runner.start({});
    // stderr arrives before the exit event in this fake, same as a real pipe would buffer it first.
    setTimeout(() => getLastChild()?.stderr.emit('data', Buffer.from('fatal: something broke\n')), 5);
    await assert.rejects(p, (err) => {
      assert.ok(err instanceof DashboardError);
      assert.equal(err.status, 500);
      assert.equal(err.code, 'SCAN_START_FAILED');
      assert.equal(err.details.exit_code, 1);
      assert.ok(String(err.details.stderr_tail).includes('fatal: something broke'));
      return true;
    });
  });

  test('neither a marker nor an exit within the bound -> SCAN_START_TIMEOUT', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'timeout' });
    const runner = createScanRunner({ env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock, markerTimeoutMs: 40 });
    await assert.rejects(runner.start({}), (err) => err instanceof DashboardError && err.status === 500 && err.code === 'SCAN_START_TIMEOUT');
  });

  test('status() clears once the spawned process exits normally after start() already resolved', async () => {
    const { spawnFn, getLastChild } = makeFakeSpawn({ mode: 'resolve', runId: 1001, delayMs: 15 });
    const runner = createScanRunner({ env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock });
    await runner.start({});
    assert.equal(runner.status().running, true);
    getLastChild().emit('exit', 0);
    assert.equal(runner.status().running, false);
  });
});

describe('armCancelBackstop', () => {
  test('forced_kill_available is true only when this runner spawned that exact run id and pid', async () => {
    const { spawnFn } = makeFakeSpawn({ mode: 'resolve', runId: 2002, delayMs: 10 });
    const runner = createScanRunner({ env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock });
    await runner.start({});
    assert.equal(runner.armCancelBackstop(2002).forced_kill_available, true);
    assert.equal(runner.armCancelBackstop(9999).forced_kill_available, false);
  });

  test('after 45s-equivalent (short test window), taskkill runs only if the run is still tracked as live', async () => {
    const { spawnFn, getLastChild } = makeFakeSpawn({ mode: 'resolve', runId: 3003, delayMs: 10 });
    /** @type {Array<{args: string[]}>} */
    const calls = [];
    const fakeExecFile = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ cb) => {
      calls.push({ args });
      cb(null);
    };
    const runner = createScanRunner({
      env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock,
      execFile: fakeExecFile, cancelBackstopMs: 20,
    });
    await runner.start({});
    runner.armCancelBackstop(3003);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('/pid'));
    assert.ok(calls[0].args.includes(String(getLastChild().pid)));
  });

  test('taskkill backstop does not fire once the run has already finished', async () => {
    const { spawnFn, getLastChild } = makeFakeSpawn({ mode: 'resolve', runId: 4004, delayMs: 10 });
    let calls = 0;
    const fakeExecFile = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ cb) => {
      calls++;
      cb(null);
    };
    const runner = createScanRunner({
      env: {}, logDir, scanScript: path.join(logDir, 'fake-scan.js'), spawn: spawnFn, checkConfigLock: okConfigLock,
      execFile: fakeExecFile, cancelBackstopMs: 20,
    });
    await runner.start({});
    runner.armCancelBackstop(4004);
    getLastChild().emit('exit', 0); // the run finished before the backstop window elapsed
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls, 0);
  });
});
