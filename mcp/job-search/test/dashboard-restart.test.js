// @ts-check
/**
 * src/core/dashboard-restart.js with every process/schtasks/http/git layer stubbed. Nothing here touches a
 * real process, the Task Scheduler, or the network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restartDashboard, isDashboardProcess, DASHBOARD_SERVICE_NAME, dashboardPidFile, dashboardPort, writePidFile, removePidFileIfOwn, readPidFile } from '../src/core/dashboard-restart.js';
import { SERVICE_NAME, resolvePort } from '../bin/dashboard.js';
import { TOOLS } from '../src/server.js';
import { parseArgs } from '../bin/restart-dashboard.js';

const SCRIPT = 'C:\\repo\\mcp\\job-search\\bin\\dashboard.js';
const DASH_CMD = `"C:\\Program Files\\nodejs\\node.exe" ${SCRIPT}`;
const HEAD_TIME = '2026-10-08T12:00:00.000Z';

/**
 * Fake world: `procs` maps pid -> info. kill removes the pid. runTask spawns `newPid` (if set) after
 * `bootMs` of fake time. Fake clock advances only through sleep.
 * @param {{ procs?: Record<number, any>, pidfile?: number|null, listener?: number|null, scan?: number[], newPid?: number|null, bootMs?: number, taskOk?: boolean, killRemoves?: boolean }} cfg
 */
function world(cfg = {}) {
  const procs = { ...(cfg.procs ?? {}) };
  let clock = 1_000_000;
  /** @type {number|null} */
  let pidfile = cfg.pidfile ?? null;
  /** @type {number|null} */
  let listener = cfg.listener ?? null;
  /** @type {number[]} */
  const killed = [];
  let taskRuns = 0;
  /** @type {number|null} */
  let bootAt = null;
  const calls = { processInfo: /** @type {number[]} */ ([]) };
  const layers = {
    readPid: () => pidfile,
    listenerPid: async () => listener,
    processInfo: async (/** @type {number} */ pid) => {
      calls.processInfo.push(pid);
      tick();
      return procs[pid] ?? null;
    },
    findByScript: async () => cfg.scan ?? Object.entries(procs).filter(([, v]) => isDashboardProcess(v, SCRIPT)).map(([k]) => Number(k)),
    kill: async (/** @type {number} */ pid) => {
      killed.push(pid);
      if (cfg.killRemoves !== false) {
        delete procs[pid];
        if (listener === pid) listener = null;
        if (pidfile === pid) pidfile = null;
      }
      return true;
    },
    runTask: async () => {
      taskRuns++;
      if (cfg.taskOk === false) return false;
      bootAt = clock + (cfg.bootMs ?? 0);
      return true;
    },
    probe: async () => {
      tick();
      return listener !== null && cfg.newPid != null && listener === cfg.newPid
        ? { outcome: 'healthy', httpStatus: 200, reason: null }
        : { outcome: 'not_listening', httpStatus: null, reason: 'connection refused' };
    },
    head: async () => ({ sha: 'abc123', time: HEAD_TIME }),
    sleep: async (/** @type {number} */ ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  function tick() {
    if (bootAt !== null && clock >= bootAt && cfg.newPid != null && !procs[cfg.newPid]) {
      procs[cfg.newPid] = { name: 'node.exe', commandLine: DASH_CMD, startedAt: new Date(clock).toISOString() };
      pidfile = cfg.newPid;
      listener = cfg.newPid;
    }
  }
  return { layers, killed, get taskRuns() { return taskRuns; }, calls };
}

const dash = (/** @type {string} */ startedAt) => ({ name: 'node.exe', commandLine: DASH_CMD, startedAt });

describe('isDashboardProcess', () => {
  test('requires node AND the absolute dashboard script path (slash and case insensitive)', () => {
    assert.equal(isDashboardProcess(dash('x'), SCRIPT), true);
    assert.equal(isDashboardProcess({ name: 'node.exe', commandLine: 'node C:/REPO/mcp/job-search/bin/dashboard.js', startedAt: null }, SCRIPT), true);
    assert.equal(isDashboardProcess({ name: 'node.exe', commandLine: 'node C:\\repo\\mcp\\job-search\\bin\\scan.js', startedAt: null }, SCRIPT), false);
    assert.equal(isDashboardProcess({ name: 'node.exe', commandLine: 'node C:\\other\\bin\\dashboard.js', startedAt: null }, SCRIPT), false);
    assert.equal(isDashboardProcess({ name: 'powershell.exe', commandLine: DASH_CMD, startedAt: null }, SCRIPT), false);
    assert.equal(isDashboardProcess(null, SCRIPT), false);
  });
  test('service name constant matches bin/dashboard.js', () => {
    assert.equal(DASHBOARD_SERVICE_NAME, SERVICE_NAME);
  });
  test('dashboardPort agrees with resolvePort in bin/dashboard.js', () => {
    for (const v of [undefined, '', '  ', '8123', '80', '70000', 'abc', '7311.5', '1024', '65535']) {
      assert.equal(dashboardPort(v), resolvePort(undefined, v, () => {}).port, String(v));
    }
  });
});

describe('restartDashboard', () => {
  test('single match: stops that pid only, starts the task, reports old and new pid', async () => {
    const w = world({ procs: { 100: dash('2026-10-08T10:00:00.000Z'), 555: { name: 'node.exe', commandLine: 'node other.js', startedAt: null } }, pidfile: 100, listener: 100, newPid: 200, bootMs: 3000 });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers });
    assert.deepEqual(w.killed, [100]);
    assert.equal(w.taskRuns, 1);
    assert.equal(r.ok, true);
    assert.equal(r.restarted, true);
    assert.equal(r.old_pid, 100);
    assert.equal(r.new_pid, 200);
    assert.equal(r.http_status, 200);
    assert.equal(r.served_commit, 'abc123');
    assert.ok(r.started_at);
  });

  test('no match: only starts the task, kills nothing, old_pid null', async () => {
    const w = world({ newPid: 300, bootMs: 2000 });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers });
    assert.deepEqual(w.killed, []);
    assert.equal(w.taskRuns, 1);
    assert.equal(r.ok, true);
    assert.equal(r.old_pid, null);
    assert.equal(r.new_pid, 300);
  });

  test('stale pidfile naming an unrelated process is ignored and that process is never killed', async () => {
    const w = world({ procs: { 777: { name: 'node.exe', commandLine: 'node some-other-app.js', startedAt: null } }, pidfile: 777, newPid: 300 });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers });
    assert.deepEqual(w.killed, []);
    assert.equal(r.ok, true);
    assert.equal(r.old_pid, null);
  });

  test('ambiguous (pidfile pid and a second matching dashboard): refuses, kills nothing, starts nothing', async () => {
    const w = world({ procs: { 100: dash('a'), 101: dash('b') }, pidfile: 100, listener: 101, newPid: 200 });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AMBIGUOUS');
    assert.deepEqual(w.killed, []);
    assert.equal(w.taskRuns, 0);
  });

  test('a non-dashboard node on the dashboard port is left untouched and nothing starts', async () => {
    const w = world({ procs: { 900: { name: 'node.exe', commandLine: 'node C:\\other\\server.js', startedAt: null } }, listener: 900, newPid: 200 });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FOREIGN_LISTENER');
    assert.deepEqual(w.killed, []);
    assert.equal(w.taskRuns, 0);
  });

  test('health timeout is reported with old_pid and no new_pid', async () => {
    const w = world({ procs: { 100: dash('2026-10-08T10:00:00.000Z') }, pidfile: 100, listener: 100, newPid: null });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers, healthTimeoutMs: 5000, pollMs: 1000 });
    assert.deepEqual(w.killed, [100]);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'HEALTH_TIMEOUT');
    assert.equal(r.old_pid, 100);
    assert.equal(r.new_pid, undefined);
  });

  test('schtasks failure after the stop is reported, not hidden', async () => {
    const w = world({ procs: { 100: dash('a') }, pidfile: 100, listener: 100, taskOk: false });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers });
    assert.equal(r.code, 'TASK_START_FAILED');
    assert.equal(r.stopped, true);
  });

  test('a process that survives taskkill is reported KILL_FAILED and the task is not started', async () => {
    const w = world({ procs: { 100: dash('a') }, pidfile: 100, listener: 100, killRemoves: false });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers, exitWaitMs: 1000 });
    assert.equal(r.code, 'KILL_FAILED');
    assert.equal(w.taskRuns, 0);
  });

  test('old process still serving is never accepted as the new one', async () => {
    // kill "succeeds" for taskkill but the same pid keeps listening: must not report success with new_pid === old_pid
    const w = world({ procs: { 100: dash('a') }, pidfile: 100, listener: 100, newPid: 100 });
    const r = await restartDashboard({ script: SCRIPT, layers: w.layers, healthTimeoutMs: 3000, pollMs: 1000 });
    assert.equal(r.ok, false);
  });

  describe('ifStale', () => {
    test('process started after HEAD commit: no restart', async () => {
      const w = world({ procs: { 100: dash('2026-10-08T13:00:00.000Z') }, pidfile: 100, listener: 100, newPid: 200 });
      const r = await restartDashboard({ script: SCRIPT, ifStale: true, layers: w.layers });
      assert.equal(r.ok, true);
      assert.equal(r.restarted, false);
      assert.equal(r.reason, 'not_stale');
      assert.deepEqual(w.killed, []);
      assert.equal(w.taskRuns, 0);
    });
    test('process started before HEAD commit: restarts', async () => {
      const w = world({ procs: { 100: dash('2026-10-08T11:00:00.000Z') }, pidfile: 100, listener: 100, newPid: 200 });
      const r = await restartDashboard({ script: SCRIPT, ifStale: true, layers: w.layers });
      assert.equal(r.restarted, true);
      assert.deepEqual(w.killed, [100]);
    });
    test('unknown start time is not provably stale: no restart', async () => {
      const w = world({ procs: { 100: dash(/** @type {any} */ (null)) }, pidfile: 100, listener: 100, newPid: 200 });
      const r = await restartDashboard({ script: SCRIPT, ifStale: true, layers: w.layers });
      assert.equal(r.restarted, false);
      assert.equal(r.reason, 'staleness_unknown');
      assert.deepEqual(w.killed, []);
    });
    test('nothing running with ifStale still starts the task', async () => {
      const w = world({ newPid: 300 });
      const r = await restartDashboard({ script: SCRIPT, ifStale: true, layers: w.layers });
      assert.equal(r.restarted, true);
      assert.equal(w.taskRuns, 1);
    });
  });
});

describe('pidfile helpers', () => {
  test('write, read, and remove only when the file still names this pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-pid-'));
    try {
      const f = dashboardPidFile(dir);
      assert.equal(readPidFile(f), null);
      assert.equal(writePidFile(f, 4242), true);
      assert.equal(readPidFile(f), 4242);
      removePidFileIfOwn(f, 1);
      assert.equal(readPidFile(f), 4242, 'a different pid does not remove it');
      removePidFileIfOwn(f, 4242);
      assert.equal(readPidFile(f), null);
      fs.writeFileSync(f, 'garbage');
      assert.equal(readPidFile(f), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registration and CLI', () => {
  test('restart_dashboard is a registered tool with an ifStale boolean', () => {
    const t = TOOLS.find((x) => x.name === 'restart_dashboard');
    assert.ok(t);
    assert.deepEqual(Object.keys(t.schema), ['ifStale']);
  });
  test('CLI parseArgs', () => {
    assert.deepEqual(parseArgs(['--if-stale']), { ifStale: true, help: false });
    assert.deepEqual(parseArgs([]), { ifStale: false, help: false });
  });
});
