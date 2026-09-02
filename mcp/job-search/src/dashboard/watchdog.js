// @ts-check
/**
 * Dashboard self-healing watchdog (self-healing watchdog + logging feature). bin/watchdog.js is the thin
 * CLI wrapper the "job-search dashboard" scheduled task runs every 5 minutes; this module holds the
 * total-classification probe/restart/kill-guard logic, following the same src/dashboard split as
 * scan-runner.js and apply-runner.js.
 *
 * Total classification of a probe outcome (every run maps to exactly one branch, no silent default):
 *   (a) HEALTHY: HTTP 200, service === 'job-search-dashboard', db_ok === true -> log heartbeat, write
 *       state 'ok', exit 0.
 *   (b) NOT LISTENING (connection refused / nothing bound): start the dashboard, wait ~6s, re-probe.
 *       Healthy afterwards -> state 'restarted', exit 0. Still dead -> state 'down', exit 1.
 *   (c) LISTENING BUT UNHEALTHY (timeout, non-200, wrong service, or db_ok false): identify the pid
 *       owning the LISTENING socket; kill it ONLY IF it is node.exe running dashboard.js, then proceed as
 *       (b). A guard mismatch (including "could not identify the owner at all") never kills anything ->
 *       state 'stuck_foreign_process', exit 1.
 *   (d) UNEXPECTED EXCEPTION: log verbatim -> state 'error', exit 1.
 *
 * CRITICAL health semantics: server.js's /api/health returns HTTP 200 with `ok:true` hardcoded even when
 * `db_ok`/`config_lock_ok` are false. HEALTHY here requires HTTP 200 AND service match AND db_ok===true;
 * a 200 with db_ok:false is branch (c), not (a).
 *
 * Probe: node's own http module directly against 127.0.0.1, never fetch -- explicitly immune to
 * HTTP_PROXY/HTTPS_PROXY (fetch's proxy-honoring behavior is exactly what the spec for this feature rules
 * out). This is a NEW probe, not a reuse of bin/dashboard.js's probeExistingHealth(): that helper only
 * checks `service` (its purpose is EADDRINUSE same-instance detection, not health) and is itself built on
 * fetch, so it satisfies neither the db_ok check nor the proxy-immunity requirement this feature needs.
 * bin/dashboard.js's resolvePort() IS reused as-is (imported by bin/watchdog.js), since port resolution
 * has no such conflict.
 *
 * Known accepted limitation (spec, branch c): between findListeningPid() identifying a pid and
 * killProcessTree() killing it, that pid could in principle be reused by an unrelated process (a narrow
 * OS-level race). This is accepted, not defended against, here.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { errFields } from '../core/errors.js';
import { recordWatchdogRun } from '../core/watchdog-state.js';

export const HEALTH_PROBE_TIMEOUT_MS = 5000;
export const RESTART_WAIT_MS = 6000;
export const START_LOCK_STALE_MS = 30000;

/**
 * @typedef {Object} HealthProbeResult
 * @property {'healthy'|'unhealthy'|'not_listening'} outcome
 * @property {number|null} httpStatus
 * @property {boolean|null} dbOk
 * @property {string|null} service
 * @property {string|null} reason human-readable reason, null only when outcome is 'healthy'
 */

/**
 * GET /api/health via node:http directly (never fetch -- see module doc comment), hard ~5s timeout.
 * @param {number} port
 * @param {string} service expected SERVICE_NAME from bin/dashboard.js
 * @param {{ httpGet?: typeof http.get, timeoutMs?: number }} [opts]
 * @returns {Promise<HealthProbeResult>}
 */
export function probeDashboardHealth(port, service, opts = {}) {
  const httpGet = opts.httpGet ?? http.get;
  const timeoutMs = opts.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    /** @param {HealthProbeResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    /** @type {import('node:http').ClientRequest} */
    let req;
    try {
      req = httpGet({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            finish({ outcome: 'unhealthy', httpStatus: res.statusCode ?? null, dbOk: null, service: null, reason: `non-200 status ${res.statusCode}` });
            return;
          }
          /** @type {any} */
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            finish({ outcome: 'unhealthy', httpStatus: 200, dbOk: null, service: null, reason: 'response body is not JSON' });
            return;
          }
          const gotService = parsed && typeof parsed.service === 'string' ? parsed.service : null;
          const dbOk = parsed && typeof parsed.db_ok === 'boolean' ? parsed.db_ok : null;
          if (gotService !== service) {
            finish({ outcome: 'unhealthy', httpStatus: 200, dbOk, service: gotService, reason: 'a different service answered on this port' });
            return;
          }
          if (dbOk !== true) {
            finish({ outcome: 'unhealthy', httpStatus: 200, dbOk, service: gotService, reason: 'db_ok is false (server reports ok:true regardless; this is the semantics fix)' });
            return;
          }
          finish({ outcome: 'healthy', httpStatus: 200, dbOk, service: gotService, reason: null });
        });
      });
    } catch (err) {
      finish({ outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: errFields(err).err_message });
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      finish({ outcome: 'unhealthy', httpStatus: null, dbOk: null, service: null, reason: 'health probe timed out' });
    });
    req.on('error', (err) => {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        finish({ outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: 'connection refused' });
      } else {
        finish({ outcome: 'not_listening', httpStatus: null, dbOk: null, service: null, reason: errFields(err).err_message });
      }
    });
  });
}

/**
 * Find the pid with a LISTENING TCP socket on 127.0.0.1:port, via `netstat -ano`. Returns null when no
 * matching row is found, netstat is unavailable, or the output cannot be parsed -- "could not identify"
 * is a distinct, safe outcome the caller maps to the guard-mismatch branch, never a guess.
 * @param {number} port
 * @param {{ execFileImpl?: typeof nodeExecFile }} [opts]
 * @returns {Promise<number|null>}
 */
export function findListeningPid(port, opts = {}) {
  const run = opts.execFileImpl ?? nodeExecFile;
  return new Promise((resolve) => {
    run('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
      if (err || typeof stdout !== 'string') {
        resolve(null);
        return;
      }
      for (const rawLine of stdout.split(/\r?\n/)) {
        const cols = rawLine.trim().split(/\s+/);
        if (cols.length < 5) continue;
        const [proto, localAddr, , state, pidStr] = cols;
        if (proto.toUpperCase() !== 'TCP') continue;
        if (state !== 'LISTENING') continue;
        const portMatch = /:(\d+)$/.exec(localAddr);
        if (!portMatch || Number(portMatch[1]) !== port) continue;
        const pid = Number(pidStr);
        if (Number.isInteger(pid) && pid > 0) {
          resolve(pid);
          return;
        }
      }
      resolve(null);
    });
  });
}

/**
 * @typedef {Object} ProcessInfo
 * @property {string|null} name executable name (e.g. "node.exe")
 * @property {string|null} commandLine full command line
 */

/**
 * Executable name + full command line for a pid, via PowerShell CIM (works without the deprecated wmic).
 * Returns null when the process cannot be inspected (already exited, access denied, PowerShell
 * unavailable, unparseable output) -- the kill guard below treats "cannot verify" as "do not kill".
 * @param {number} pid
 * @param {{ execFileImpl?: typeof nodeExecFile }} [opts]
 * @returns {Promise<ProcessInfo|null>}
 */
export function getProcessInfo(pid, opts = {}) {
  const run = opts.execFileImpl ?? nodeExecFile;
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      if (err || typeof stdout !== 'string' || !stdout.trim()) {
        resolve(null);
        return;
      }
      /** @type {any} */
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolve(null);
        return;
      }
      const row = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!row || typeof row !== 'object') {
        resolve(null);
        return;
      }
      resolve({
        name: typeof row.Name === 'string' ? row.Name : null,
        commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : null,
      });
    });
  });
}

/**
 * Kill guard (spec branch c): true ONLY when the executable is node(.exe) AND the command line contains
 * "dashboard.js". `info` being null (could not verify) is always false -- fail safe, never a guess in the
 * kill direction.
 * @param {ProcessInfo|null} info
 */
export function matchesKillGuard(info) {
  if (!info || typeof info.name !== 'string' || typeof info.commandLine !== 'string') return false;
  return /^node(\.exe)?$/i.test(info.name) && info.commandLine.includes('dashboard.js');
}

/**
 * `taskkill /pid <pid> /T /F` (mirrors scan-runner.js's own cancel backstop). Returns true on success,
 * false on any error (already exited counts as "not there to kill", not a failure worth surfacing loudly).
 * @param {number} pid
 * @param {{ execFileImpl?: typeof nodeExecFile }} [opts]
 * @returns {Promise<boolean>}
 */
export function killProcessTree(pid, opts = {}) {
  const run = opts.execFileImpl ?? nodeExecFile;
  return new Promise((resolve) => {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * @typedef {Object} StartLock
 * @property {boolean} fresh true when a lock exists and is younger than staleMs
 * @property {number|null} pid pid recorded in the lock, if any
 * @property {string|null} ts ISO timestamp recorded in the lock, if any
 */

/**
 * Startup race lock (spec): Task Scheduler's own MultipleInstances=IgnoreNew does not cover this window,
 * because the watchdog process itself exits within milliseconds of spawning the dashboard while the
 * child is still initializing -- a second watchdog invocation 5 minutes (or, on RestartOnFailure, 1
 * minute) later would otherwise see "not listening" again and spawn a second dashboard on top of one
 * still starting up. A corrupt or unparseable lock file is treated as absent/stale, never as
 * indefinitely fresh (a lock that can never be proven stale would wedge every future run).
 * @param {string} lockFile
 * @param {Date} now
 * @param {number} staleMs
 * @returns {StartLock}
 */
export function readStartLock(lockFile, now, staleMs) {
  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch {
    return { fresh: false, pid: null, ts: null };
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fresh: false, pid: null, ts: null };
  }
  const ts = typeof parsed?.ts === 'string' ? parsed.ts : null;
  const parsedTime = ts ? Date.parse(ts) : NaN;
  const age = Number.isFinite(parsedTime) ? now.getTime() - parsedTime : Infinity;
  const fresh = Number.isFinite(age) && age >= 0 && age < staleMs;
  return { fresh, pid: typeof parsed?.pid === 'number' ? parsed.pid : null, ts };
}

/**
 * @param {string} lockFile
 * @param {Date} now
 */
export function writeStartLock(lockFile, now) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: now.toISOString() }));
}

/**
 * Spawn dashboard.js detached with full log capture. NEVER 'pipe' for a child that outlives the
 * watchdog: scan-runner.js's own 'pipe' usage (stdio: ['ignore','ignore','pipe']) is safe only because
 * that caller (the long-lived dashboard process) stays alive to keep draining the pipe; this watchdog
 * exits within ms of spawning, so an inherited 'pipe' here would have nothing draining it and would
 * eventually deadlock the child once its stdout/stderr buffer fills. `fd = fs.openSync(logFile, 'a')` is
 * opened, handed to both stdout and stderr slots, and closed in the PARENT immediately after spawn (the
 * child keeps its own independent OS handle to the same file via dup(), unaffected by the parent closing
 * its copy); the child is then unref()'d so this process can exit without waiting on it.
 * @param {{ dashboardScript: string, logFile: string, env: NodeJS.ProcessEnv, spawnImpl?: typeof nodeSpawn }} opts
 * @returns {number|null} the spawned pid, or null if the child process object reports none
 */
export function startDashboard(opts) {
  const doSpawn = opts.spawnImpl ?? nodeSpawn;
  const fd = fs.openSync(opts.logFile, 'a');
  try {
    const child = doSpawn(process.execPath, [opts.dashboardScript], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: opts.env,
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @typedef {Object} WatchdogDeps
 * @property {number} port
 * @property {string} service SERVICE_NAME
 * @property {string} dashboardScript absolute path to bin/dashboard.js
 * @property {string} dashboardLogFile dated dashboard-YYYY-MM-DD.log path (same file dashboard.js's own logger writes to)
 * @property {string} lockFile
 * @property {string} stateFile
 * @property {NodeJS.ProcessEnv} env env to pass to the spawned dashboard
 * @property {Date} [now]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} log
 * @property {(port: number, service: string, opts?: any) => Promise<HealthProbeResult>} [probeHealth] test seam; default probeDashboardHealth
 * @property {(opts: { dashboardScript: string, logFile: string, env: NodeJS.ProcessEnv }) => number|null} [spawnDashboard] test seam; default startDashboard
 * @property {(port: number) => Promise<number|null>} [findListeningPid] test seam
 * @property {(pid: number) => Promise<ProcessInfo|null>} [getProcessInfo] test seam
 * @property {(pid: number) => Promise<boolean>} [killProcessTree] test seam
 * @property {(ms: number) => Promise<void>} [sleep] test seam
 * @property {number} [restartWaitMs]
 * @property {number} [lockStaleMs]
 */

/**
 * @typedef {Object} WatchdogResult
 * @property {number} code 0 or 1 (see module doc comment)
 * @property {'ok'|'restarted'|'down'|'stuck_foreign_process'|'error'|'start_in_progress'} status
 * @property {string|null} detail
 * @property {import('../core/watchdog-state.js').WatchdogState|null} state null only for start_in_progress, which writes nothing (a fresh lock means another run already owns this cycle's state write)
 */

/**
 * One watchdog cycle: probe, classify, act, record state. See module doc comment for the total
 * classification this implements.
 * @param {WatchdogDeps} deps
 * @returns {Promise<WatchdogResult>}
 */
export async function runWatchdog(deps) {
  const now = deps.now ?? new Date();
  const probeHealth = deps.probeHealth ?? probeDashboardHealth;
  const spawnDashboard = deps.spawnDashboard ?? startDashboard;
  const findPid = deps.findListeningPid ?? findListeningPid;
  const getInfo = deps.getProcessInfo ?? getProcessInfo;
  const kill = deps.killProcessTree ?? killProcessTree;
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const restartWaitMs = deps.restartWaitMs ?? RESTART_WAIT_MS;
  const lockStaleMs = deps.lockStaleMs ?? START_LOCK_STALE_MS;
  const log = deps.log;

  /**
   * @param {WatchdogResult['status']} status
   * @param {number} code
   * @param {string|null} detail
   * @returns {WatchdogResult}
   */
  function finalize(status, code, detail) {
    const state = recordWatchdogRun(deps.stateFile, { status, detail }, now);
    return { code, status, detail, state };
  }

  /** Branch (b): take the start-race lock, spawn, wait, re-probe. */
  async function startAndReprobe() {
    const lock = readStartLock(deps.lockFile, now, lockStaleMs);
    if (lock.fresh) {
      log({ evt: 'watchdog_start_in_progress', lock_pid: lock.pid, lock_ts: lock.ts });
      return { code: 0, status: /** @type {const} */ ('start_in_progress'), detail: 'a start was already in progress (fresh lock)', state: null };
    }
    writeStartLock(deps.lockFile, now);

    let pid = null;
    try {
      pid = await spawnDashboard({ dashboardScript: deps.dashboardScript, logFile: deps.dashboardLogFile, env: deps.env });
    } catch (err) {
      const f = errFields(err);
      log({ evt: 'watchdog_spawn_failed', ...f });
      return finalize('down', 1, `failed to spawn dashboard: ${f.err_message}`);
    }
    log({ evt: 'watchdog_dashboard_spawned', pid, port: deps.port });

    await sleep(restartWaitMs);
    const reprobe = await probeHealth(deps.port, deps.service);
    if (reprobe.outcome === 'healthy') {
      log({ evt: 'watchdog_restarted', pid, port: deps.port });
      return finalize('restarted', 0, null);
    }
    log({ evt: 'watchdog_restart_failed', pid, outcome: reprobe.outcome, reason: reprobe.reason });
    return finalize('down', 1, `dashboard did not become healthy after restart: ${reprobe.reason ?? reprobe.outcome}`);
  }

  try {
    const probe = await probeHealth(deps.port, deps.service);

    if (probe.outcome === 'healthy') {
      log({ evt: 'watchdog_healthy', port: deps.port });
      return finalize('ok', 0, null);
    }

    if (probe.outcome === 'not_listening') {
      log({ evt: 'watchdog_not_listening', port: deps.port, reason: probe.reason });
      return await startAndReprobe();
    }

    // probe.outcome === 'unhealthy': listening but unhealthy (branch c).
    log({ evt: 'watchdog_unhealthy', port: deps.port, reason: probe.reason, http_status: probe.httpStatus, db_ok: probe.dbOk, service: probe.service });
    const pid = await findPid(deps.port);
    if (pid === null) {
      log({ evt: 'watchdog_owner_unknown', port: deps.port });
      return finalize('stuck_foreign_process', 1, 'could not identify the process listening on the port; refusing to guess, nothing killed');
    }
    const info = await getInfo(pid);
    if (!matchesKillGuard(info)) {
      log({ evt: 'watchdog_guard_mismatch', pid, name: info?.name ?? null, command_line: info?.commandLine ? info.commandLine.slice(0, 200) : null });
      return finalize('stuck_foreign_process', 1, `pid ${pid} (${info?.name ?? 'unknown executable'}) does not match the dashboard.js node.exe guard; not killed`);
    }

    // Guard matched: kill and proceed as (b). Residual pid-reuse race between findPid()/getInfo() above
    // and the kill below is accepted, not defended against (see module doc comment).
    const killed = await kill(pid);
    log({ evt: 'watchdog_killed_stuck_process', pid, ok: killed });
    return await startAndReprobe();
  } catch (err) {
    const f = errFields(err);
    log({ evt: 'watchdog_unexpected_error', ...f });
    return finalize('error', 1, f.err_message);
  }
}
