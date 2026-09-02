// @ts-check
/**
 * src/dashboard/watchdog.js: the self-healing watchdog's total classification (spec branches a-d), the
 * kill guard, the start-race lock, and the probe's HTTP-module (never fetch) health semantics.
 *
 * probeDashboardHealth is exercised against a REAL http.Server (same style as bin/dashboard.js's own
 * probeExistingHealth test) so the CRITICAL health-semantics rule (200 + db_ok:false is unhealthy, not
 * healthy) is proven end to end rather than by mocking JSON.parse. Every other external dependency
 * (netstat, PowerShell CIM, taskkill, the dashboard child process spawn, the wait between restart and
 * re-probe) is injected, matching the repo's existing DI-seam convention (see scan-runner.js,
 * open-dashboard.js).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  probeDashboardHealth, findListeningPid, getProcessInfo, matchesKillGuard,
  readStartLock, writeStartLock, startDashboard, killProcessTree, runWatchdog,
  RESTART_WAIT_MS, START_LOCK_STALE_MS,
} from '../src/dashboard/watchdog.js';
import { readWatchdogState } from '../src/core/watchdog-state.js';

const SERVICE = 'job-search-dashboard';

let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler */
function withServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = /** @type {any} */ (server.address()).port;
      resolve({ server, port });
    });
  });
}

describe('probeDashboardHealth: CRITICAL health semantics (200 + db_ok:false is unhealthy, never healthy)', () => {
  test('200, service matches, db_ok true -> healthy', async () => {
    const { server, port } = /** @type {any} */ (await withServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: SERVICE, db_ok: true }));
    }));
    const r = await probeDashboardHealth(port, SERVICE);
    assert.equal(r.outcome, 'healthy');
    assert.equal(r.reason, null);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('200, service matches, db_ok FALSE -> unhealthy (the exact server.js trap this feature exists to catch, since server.js hardcodes ok:true regardless)', async () => {
    const { server, port } = /** @type {any} */ (await withServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: SERVICE, db_ok: false }));
    }));
    const r = await probeDashboardHealth(port, SERVICE);
    assert.equal(r.outcome, 'unhealthy');
    assert.equal(r.dbOk, false);
    assert.match(r.reason ?? '', /db_ok/);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('200, db_ok true, but a different service -> unhealthy', async () => {
    const { server, port } = /** @type {any} */ (await withServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'something-else', db_ok: true }));
    }));
    const r = await probeDashboardHealth(port, SERVICE);
    assert.equal(r.outcome, 'unhealthy');
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('non-2xx status -> unhealthy', async () => {
    const { server, port } = /** @type {any} */ (await withServer((req, res) => {
      res.statusCode = 500;
      res.end('nope');
    }));
    const r = await probeDashboardHealth(port, SERVICE);
    assert.equal(r.outcome, 'unhealthy');
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('non-JSON body -> unhealthy', async () => {
    const { server, port } = /** @type {any} */ (await withServer((req, res) => {
      res.end('plain text');
    }));
    const r = await probeDashboardHealth(port, SERVICE);
    assert.equal(r.outcome, 'unhealthy');
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('nothing listening -> not_listening, never throws', async () => {
    const r = await probeDashboardHealth(1, SERVICE); // privileged/unused port, connection refused
    assert.equal(r.outcome, 'not_listening');
  });

  test('a server that never responds -> unhealthy via timeout, using an injected short timeoutMs', async () => {
    const { server, port } = /** @type {any} */ (await withServer(() => {
      // never calls res.end()
    }));
    const r = await probeDashboardHealth(port, SERVICE, { timeoutMs: 200 });
    assert.equal(r.outcome, 'unhealthy');
    assert.match(r.reason ?? '', /timed out/);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });
});

describe('findListeningPid: parses netstat -ano output, total "could not identify" fallback', () => {
  test('finds the pid on a matching LISTENING TCP row', async () => {
    const stdout = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900',
      '  TCP    127.0.0.1:7311         0.0.0.0:0              LISTENING       4321',
      '  TCP    127.0.0.1:7311         127.0.0.1:51000        ESTABLISHED     4321',
      '',
    ].join('\r\n');
    const pid = await findListeningPid(7311, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(null, stdout, '')) });
    assert.equal(pid, 4321);
  });

  test('no matching row -> null', async () => {
    const stdout = '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900\r\n';
    const pid = await findListeningPid(7311, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(null, stdout, '')) });
    assert.equal(pid, null);
  });

  test('netstat itself fails -> null, never throws', async () => {
    const pid = await findListeningPid(7311, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(new Error('not found'), '', '')) });
    assert.equal(pid, null);
  });
});

describe('getProcessInfo: parses PowerShell CIM JSON, total "could not verify" fallback', () => {
  test('a single-match object (PowerShell ConvertTo-Json emits a bare object, not an array, for one row)', async () => {
    const stdout = JSON.stringify({ Name: 'node.exe', CommandLine: 'node "C:\\repo\\mcp\\job-search\\bin\\dashboard.js"' });
    const info = await getProcessInfo(4321, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(null, stdout, '')) });
    assert.equal(info?.name, 'node.exe');
    assert.match(info?.commandLine ?? '', /dashboard\.js/);
  });

  test('an array result (more than one match) uses the first row', async () => {
    const stdout = JSON.stringify([{ Name: 'node.exe', CommandLine: 'dashboard.js' }, { Name: 'node.exe', CommandLine: 'other.js' }]);
    const info = await getProcessInfo(4321, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(null, stdout, '')) });
    assert.equal(info?.commandLine, 'dashboard.js');
  });

  test('PowerShell failure, empty output, or unparseable JSON -> null, never throws', async () => {
    const a = await getProcessInfo(1, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(new Error('nope'), '', '')) });
    assert.equal(a, null);
    const b = await getProcessInfo(1, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(null, '', '')) });
    assert.equal(b, null);
    const c = await getProcessInfo(1, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(null, 'not json', '')) });
    assert.equal(c, null);
  });
});

describe('matchesKillGuard: total classification, fail-safe on anything unverifiable', () => {
  test('node.exe running dashboard.js -> true', () => {
    assert.equal(matchesKillGuard({ name: 'node.exe', commandLine: 'node "C:\\repo\\bin\\dashboard.js"' }), true);
    assert.equal(matchesKillGuard({ name: 'node', commandLine: '/usr/bin/node bin/dashboard.js' }), true, 'no .exe suffix on non-Windows-style names still matches');
  });

  test('node.exe NOT running dashboard.js -> false (a different node process must never be killed)', () => {
    assert.equal(matchesKillGuard({ name: 'node.exe', commandLine: 'node scan.js' }), false);
  });

  test('a non-node executable holding the port -> false', () => {
    assert.equal(matchesKillGuard({ name: 'chrome.exe', commandLine: 'chrome.exe --port=7311' }), false);
  });

  test('null info (could not verify at all) -> false, never a guess in the kill direction', () => {
    assert.equal(matchesKillGuard(null), false);
  });

  test('partial info (missing commandLine or name) -> false', () => {
    assert.equal(matchesKillGuard({ name: 'node.exe', commandLine: null }), false);
    assert.equal(matchesKillGuard({ name: null, commandLine: 'dashboard.js' }), false);
  });
});

describe('killProcessTree', () => {
  test('taskkill success -> true; failure -> false, never throws', async () => {
    const ok = await killProcessTree(1234, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(null, '', '')) });
    assert.equal(ok, true);
    const fail = await killProcessTree(1234, { execFileImpl: /** @type {any} */ ((cmd, args, opts, cb) => cb(new Error('access denied'), '', '')) });
    assert.equal(fail, false);
  });
});

describe('readStartLock / writeStartLock: startup race lock staleness', () => {
  test('no lock file -> not fresh', () => {
    const r = readStartLock(path.join(tmp, 'no-lock.json'), new Date(), START_LOCK_STALE_MS);
    assert.equal(r.fresh, false);
  });

  test('a lock written just now is fresh; the same lock is stale once enough time has passed', () => {
    const file = path.join(tmp, 'lock-fresh.json');
    const writtenAt = new Date('2026-09-02T08:00:00.000Z');
    writeStartLock(file, writtenAt);
    const soon = readStartLock(file, new Date(writtenAt.getTime() + 5000), START_LOCK_STALE_MS);
    assert.equal(soon.fresh, true);
    assert.equal(soon.pid, process.pid);
    const later = readStartLock(file, new Date(writtenAt.getTime() + START_LOCK_STALE_MS + 1000), START_LOCK_STALE_MS);
    assert.equal(later.fresh, false, 'a lock older than the stale threshold must never block forever');
  });

  test('a corrupt lock file is treated as absent/stale, never as indefinitely fresh', () => {
    const file = path.join(tmp, 'lock-corrupt.json');
    fs.writeFileSync(file, 'not json');
    const r = readStartLock(file, new Date(), START_LOCK_STALE_MS);
    assert.equal(r.fresh, false);
  });

  test('a lock with a garbage (unparseable) timestamp is treated as stale, not as infinitely fresh or a thrown error', () => {
    const file = path.join(tmp, 'lock-bad-ts.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 1, ts: 'not-a-date' }));
    const r = readStartLock(file, new Date(), START_LOCK_STALE_MS);
    assert.equal(r.fresh, false);
  });
});

describe('startDashboard: detached spawn, stdio never "pipe", fd handed to the child then closed in the parent', () => {
  test('spawns with the expected shape and appends real bytes to the log file via the fd', () => {
    const logFile = path.join(tmp, 'dashboard-spawn-test.log');
    fs.writeFileSync(logFile, '');
    /** @type {any[]} */
    const calls = [];
    const fakeSpawn = /** @type {any} */ ((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      // Prove the fd handed to us is a real, writable fd pointing at logFile: write through it exactly
      // like a real child process's stdout would, before the parent closes its own copy.
      assert.equal(opts.stdio[0], 'ignore');
      assert.equal(typeof opts.stdio[1], 'number');
      assert.equal(opts.stdio[1], opts.stdio[2], 'stdout and stderr share the same fd');
      assert.notEqual(opts.stdio[1], 'pipe');
      assert.notEqual(opts.stdio[2], 'pipe');
      fs.writeSync(opts.stdio[1], 'child log line\n');
      return { pid: 9999, unref: () => {} };
    });
    const pid = startDashboard({ dashboardScript: '/x/bin/dashboard.js', logFile, env: {}, spawnImpl: fakeSpawn });
    assert.equal(pid, 9999);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(fs.readFileSync(logFile, 'utf8'), 'child log line\n');
  });
});

/** Shared deps builder for runWatchdog: real lock/state files under tmp, all external calls injected. */
function baseDeps(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2);
  return {
    port: 7311,
    service: SERVICE,
    dashboardScript: '/x/bin/dashboard.js',
    dashboardLogFile: path.join(tmp, `dashboard-${suffix}.log`),
    lockFile: path.join(tmp, `lock-${suffix}.json`),
    stateFile: path.join(tmp, `state-${suffix}.json`),
    env: {},
    now: new Date('2026-09-02T08:00:00.000Z'),
    log: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

describe('runWatchdog: total classification (branches a-d) end to end, real state-file writes', () => {
  test('branch (a) healthy: state ok, exit 0, nothing spawned or killed', async () => {
    let spawned = false;
    const deps = baseDeps({
      probeHealth: async () => ({ outcome: 'healthy', httpStatus: 200, dbOk: true, service: SERVICE, reason: null }),
      spawnDashboard: () => { spawned = true; return 1; },
    });
    const r = await runWatchdog(deps);
    assert.equal(r.code, 0);
    assert.equal(r.status, 'ok');
    assert.equal(spawned, false);
    assert.equal(readWatchdogState(deps.stateFile)?.status, 'ok');
  });

  test('branch (b) not listening -> restart succeeds: state restarted, exit 0', async () => {
    let probeCalls = 0;
    const deps = baseDeps({
      probeHealth: async () => {
        probeCalls++;
        return probeCalls === 1
          ? { outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: 'connection refused' }
          : { outcome: 'healthy', httpStatus: 200, dbOk: true, service: SERVICE, reason: null };
      },
      spawnDashboard: () => 555,
    });
    const r = await runWatchdog(deps);
    assert.equal(r.code, 0);
    assert.equal(r.status, 'restarted');
    const state = readWatchdogState(deps.stateFile);
    assert.equal(state?.status, 'restarted');
    assert.equal(state?.restarts_since_ack, 1);
  });

  test('branch (b) not listening -> restart still dead after the wait: state down, exit 1', async () => {
    const deps = baseDeps({
      probeHealth: async () => ({ outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: 'connection refused' }),
      spawnDashboard: () => 555,
    });
    const r = await runWatchdog(deps);
    assert.equal(r.code, 1);
    assert.equal(r.status, 'down');
    assert.equal(readWatchdogState(deps.stateFile)?.status, 'down');
  });

  test('branch (b) spawn itself throws: state down, exit 1, never crashes the watchdog', async () => {
    const deps = baseDeps({
      probeHealth: async () => ({ outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: 'connection refused' }),
      spawnDashboard: () => { throw new Error('EPERM'); },
    });
    const r = await runWatchdog(deps);
    assert.equal(r.code, 1);
    assert.equal(r.status, 'down');
    assert.match(r.detail ?? '', /EPERM/);
  });

  test('branch (b) a fresh start lock blocks a second concurrent start: start_in_progress, exit 0, nothing spawned, no state write', async () => {
    let spawned = false;
    const deps = baseDeps({
      probeHealth: async () => ({ outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: 'connection refused' }),
      spawnDashboard: () => { spawned = true; return 1; },
    });
    writeStartLock(deps.lockFile, deps.now); // pre-seed a fresh lock as if another instance just started one
    const r = await runWatchdog(deps);
    assert.equal(r.code, 0);
    assert.equal(r.status, 'start_in_progress');
    assert.equal(spawned, false);
    assert.equal(readWatchdogState(deps.stateFile), null, 'start_in_progress writes no state (another run owns this cycle)');
  });

  test('branch (b) a stale start lock does not block a new start', async () => {
    const deps = baseDeps({
      probeHealth: async () => ({ outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: 'connection refused' }),
      spawnDashboard: () => 1,
    });
    writeStartLock(deps.lockFile, new Date(deps.now.getTime() - START_LOCK_STALE_MS - 1000));
    // Re-probe after the (stale-lock-cleared) start must report healthy for a clean restarted outcome.
    let calls = 0;
    deps.probeHealth = async () => {
      calls++;
      return calls === 1
        ? { outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: 'connection refused' }
        : { outcome: 'healthy', httpStatus: 200, dbOk: true, service: SERVICE, reason: null };
    };
    const r = await runWatchdog(deps);
    assert.equal(r.status, 'restarted');
  });

  test('branch (c) listening but unhealthy, owner cannot be identified: stuck_foreign_process, exit 1, nothing killed', async () => {
    let killed = false;
    const deps = baseDeps({
      probeHealth: async () => ({ outcome: 'unhealthy', httpStatus: 200, dbOk: false, service: SERVICE, reason: 'db_ok is false' }),
      findListeningPid: async () => null,
      killProcessTree: async () => { killed = true; return true; },
    });
    const r = await runWatchdog(deps);
    assert.equal(r.code, 1);
    assert.equal(r.status, 'stuck_foreign_process');
    assert.equal(killed, false);
  });

  test('branch (c) listening but unhealthy, owner identified but guard mismatch (not node.exe/dashboard.js): stuck_foreign_process, exit 1, nothing killed', async () => {
    let killed = false;
    const deps = baseDeps({
      probeHealth: async () => ({ outcome: 'unhealthy', httpStatus: 200, dbOk: false, service: SERVICE, reason: 'db_ok is false' }),
      findListeningPid: async () => 777,
      getProcessInfo: async () => ({ name: 'chrome.exe', commandLine: 'chrome.exe --whatever' }),
      killProcessTree: async () => { killed = true; return true; },
    });
    const r = await runWatchdog(deps);
    assert.equal(r.code, 1);
    assert.equal(r.status, 'stuck_foreign_process');
    assert.equal(killed, false);
    assert.match(r.detail ?? '', /chrome\.exe/);
  });

  test('branch (c) listening but unhealthy, guard matches: kills the pid, restarts, re-probe healthy -> restarted, exit 0', async () => {
    let killedPid = null;
    let spawned = false;
    let probeCalls = 0;
    const deps = baseDeps({
      probeHealth: async () => {
        probeCalls++;
        return probeCalls === 1
          ? { outcome: 'unhealthy', httpStatus: 200, dbOk: false, service: SERVICE, reason: 'db_ok is false' }
          : { outcome: 'healthy', httpStatus: 200, dbOk: true, service: SERVICE, reason: null };
      },
      findListeningPid: async () => 888,
      getProcessInfo: async () => ({ name: 'node.exe', commandLine: 'node bin/dashboard.js' }),
      killProcessTree: async (pid) => { killedPid = pid; return true; },
      spawnDashboard: () => { spawned = true; return 999; },
    });
    const r = await runWatchdog(deps);
    assert.equal(killedPid, 888);
    assert.equal(spawned, true);
    assert.equal(r.code, 0);
    assert.equal(r.status, 'restarted');
  });

  test('branch (d) unexpected exception anywhere in the probe: state error, exit 1, verbatim message logged', async () => {
    /** @type {any[]} */
    const logs = [];
    const deps = baseDeps({
      probeHealth: async () => { throw new Error('boom unexpected'); },
      log: (f) => logs.push(f),
    });
    const r = await runWatchdog(deps);
    assert.equal(r.code, 1);
    assert.equal(r.status, 'error');
    assert.match(r.detail ?? '', /boom unexpected/);
    assert.ok(logs.some((l) => l.evt === 'watchdog_unexpected_error' && /boom unexpected/.test(String(l.err_message))));
  });

  test('consecutive_failures accumulates across separate runWatchdog invocations sharing the same state file, and resets on a healthy run', async () => {
    const stateFile = path.join(tmp, 'accum-state.json');
    const lockFile = path.join(tmp, 'accum-lock.json');
    const failDeps = () => baseDeps({ stateFile, lockFile, probeHealth: async () => ({ outcome: 'unhealthy', httpStatus: 200, dbOk: false, service: SERVICE, reason: 'db_ok is false' }), findListeningPid: async () => null });
    await runWatchdog(failDeps());
    await runWatchdog(failDeps());
    const r3 = await runWatchdog(failDeps());
    assert.equal(r3.state?.consecutive_failures, 3);
    const healthyDeps = baseDeps({ stateFile, lockFile, probeHealth: async () => ({ outcome: 'healthy', httpStatus: 200, dbOk: true, service: SERVICE, reason: null }) });
    const r4 = await runWatchdog(healthyDeps);
    assert.equal(r4.state?.consecutive_failures, 0);
  });
});
