// @ts-check
/**
 * Self-healing scan Chrome launch (src/core/chrome-launch.js, scan-never-skip PR SPEC 9): the readiness
 * probe, the process-tree kill matched only by command line containing the scan profile directory, and
 * the orchestration loop's kill-relaunch-probe cycle -- all exercised with fakes, no real Chrome or real
 * OS process involved.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listScanProfileProcesses, selfHealingLaunch, MAX_LAUNCH_ATTEMPTS } from '../src/core/chrome-launch.js';

const PROFILE_DIR = 'C:\\Users\\zztest\\chrome-scan-profile';

describe('listScanProfileProcesses (command-line-only matching)', () => {
  test('matches only processes whose CommandLine contains the profile dir; never by process name alone', async () => {
    const rows = [
      { ProcessId: 111, CommandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=${PROFILE_DIR} --remote-debugging-port=9333` },
      // Same chrome.exe image, DIFFERENT profile (the daily-driver instance) -- must never be matched.
      { ProcessId: 222, CommandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\Users\\zztest\\chrome-daily-profile --remote-debugging-port=9222' },
      // An unrelated process that happens to share no substring with the profile dir.
      { ProcessId: 333, CommandLine: 'C:\\Windows\\System32\\notepad.exe' },
      // A second real scan-profile child process (e.g. a renderer) -- also matched.
      { ProcessId: 444, CommandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --user-data-dir=${PROFILE_DIR}` },
    ];
    const fakeExecFile = (cmd, args, opts, cb) => cb(null, JSON.stringify(rows));
    const pids = await listScanProfileProcesses(PROFILE_DIR, { execFile: fakeExecFile });
    assert.deepEqual(pids.sort((a, b) => a - b), [111, 444]);
  });

  test('a single-row PowerShell result (not wrapped in an array) is still handled', async () => {
    const row = { ProcessId: 555, CommandLine: `chrome.exe --user-data-dir=${PROFILE_DIR}` };
    const fakeExecFile = (cmd, args, opts, cb) => cb(null, JSON.stringify(row));
    const pids = await listScanProfileProcesses(PROFILE_DIR, { execFile: fakeExecFile });
    assert.deepEqual(pids, [555]);
  });

  test('malformed PowerShell output returns an empty list rather than throwing', async () => {
    const fakeExecFile = (cmd, args, opts, cb) => cb(null, 'not json');
    const pids = await listScanProfileProcesses(PROFILE_DIR, { execFile: fakeExecFile });
    assert.deepEqual(pids, []);
  });

  test('execFile itself failing rejects rather than silently returning an empty list (caller decides how to handle it)', async () => {
    const fakeExecFile = (cmd, args, opts, cb) => cb(new Error('powershell not found'));
    await assert.rejects(() => listScanProfileProcesses(PROFILE_DIR, { execFile: fakeExecFile }));
  });
});

describe('selfHealingLaunch (kill-relaunch-probe orchestration)', () => {
  const target = { cdpUrl: 'http://127.0.0.1:9333', profileDir: PROFILE_DIR };

  test('healthy first probe: no kill, no relaunch, no warning', async () => {
    let listCalls = 0;
    const spawnCalls = [];
    const result = await selfHealingLaunch(target, {
      probe: async () => true,
      spawnChrome: async (attempt) => spawnCalls.push(attempt),
      listProcesses: async () => {
        listCalls++;
        return [];
      },
      killTree: async () => true,
    });
    assert.equal(result.launched, false);
    assert.equal(result.healed, false);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.killedPids, []);
    assert.equal(result.warning, null);
    assert.equal(listCalls, 0, 'a healthy first probe must never even list processes');
    assert.deepEqual(spawnCalls, []);
  });

  test('zombie (protocol never answers): kill the found pids, relaunch, then healthy -> healed with CHROME_RELAUNCHED', async () => {
    let probeCall = 0;
    const killed = [];
    const spawnCalls = [];
    const result = await selfHealingLaunch(target, {
      probe: async () => {
        probeCall++;
        return probeCall > 1; // fails once, healthy from the second probe on
      },
      spawnChrome: async (attempt) => spawnCalls.push(attempt),
      listProcesses: async (dir) => {
        assert.equal(dir, PROFILE_DIR);
        return [999];
      },
      killTree: async (pid) => {
        killed.push(pid);
        return true;
      },
      sleep: async () => {},
    });
    assert.equal(result.launched, true);
    assert.equal(result.healed, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.killedPids, [999]);
    assert.deepEqual(spawnCalls, [1]);
    assert.deepEqual(result.warning, { code: 'CHROME_RELAUNCHED', severity: 'warning', attempts: 2 });
  });

  test('two failures then success on the third attempt', async () => {
    let probeCall = 0;
    const result = await selfHealingLaunch(target, {
      probe: async () => {
        probeCall++;
        return probeCall > 2;
      },
      spawnChrome: async () => {},
      listProcesses: async () => [],
      killTree: async () => true,
      sleep: async () => {},
    });
    assert.equal(result.healed, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.warning.code, 'CHROME_RELAUNCHED');
    assert.equal(result.warning.attempts, 3);
  });

  test('every attempt fails: records CHROME_LAUNCH_FAILED and returns without throwing (the caller proceeds into the run)', async () => {
    const killed = [];
    const result = await selfHealingLaunch(target, {
      probe: async () => false,
      spawnChrome: async () => {
        throw new Error('spawn ENOENT');
      },
      listProcesses: async () => [111, 222],
      killTree: async (pid) => {
        killed.push(pid);
        return true;
      },
      sleep: async () => {},
    });
    assert.equal(result.launched, false);
    assert.equal(result.healed, false);
    assert.equal(result.attempts, MAX_LAUNCH_ATTEMPTS);
    assert.equal(result.warning.code, 'CHROME_LAUNCH_FAILED');
    assert.equal(result.warning.severity, 'warning');
    assert.equal(result.warning.attempts, MAX_LAUNCH_ATTEMPTS);
    assert.match(result.warning.lastError, /ENOENT/);
    assert.ok(typeof result.warning.remedy === 'string' && result.warning.remedy.length > 0);
    // killTree was called once per attempt for each of the two listed pids.
    assert.equal(killed.length, MAX_LAUNCH_ATTEMPTS * 2);
  });

  test('a probe that throws is treated as unhealthy, not a crash', async () => {
    const result = await selfHealingLaunch(target, {
      probe: async () => {
        throw new Error('ECONNRESET');
      },
      spawnChrome: async () => {},
      listProcesses: async () => [],
      killTree: async () => true,
      sleep: async () => {},
    });
    assert.equal(result.warning.code, 'CHROME_LAUNCH_FAILED');
    assert.match(result.warning.lastError, /ECONNRESET/);
  });
});
