// @ts-check
/**
 * Dashboard restart (shared by the restart_dashboard MCP tool and bin/restart-dashboard.js).
 *
 * How the dashboard process is identified (total classification; every input maps to one branch):
 *   Candidates are the UNION of three independent sources, each verified before it counts:
 *     (1) the pid in logs/dashboard.pid (written by bin/dashboard.js after it binds the port),
 *     (2) the pid owning the LISTENING socket on the configured port,
 *     (3) every node.exe whose command line contains the absolute path of this repo's bin/dashboard.js.
 *   A candidate is VERIFIED only when the process name is node(.exe) AND its normalized command line
 *   contains the normalized absolute path of bin/dashboard.js. A pidfile pid that fails verification is a
 *   stale file (ignored). A listener pid that fails verification is a FOREIGN process on our port: refuse.
 *   - 0 verified, no foreign listener -> nothing to stop; only start the scheduled task.
 *   - exactly 1 verified              -> stop that pid (taskkill /PID <pid> /T /F), then start the task.
 *   - 2+ verified distinct pids       -> refuse (AMBIGUOUS). Never guess which one to kill.
 *   - foreign listener on the port    -> refuse (FOREIGN_LISTENER). Never kill it.
 * No other process is ever signalled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as nodeExecFile } from 'node:child_process';
import { probeDashboardHealth, findListeningPid, killProcessTree } from '../dashboard/watchdog.js';
import { DASHBOARD_TASK_NAME } from '../dashboard/task-names.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Must equal SERVICE_NAME in bin/dashboard.js (test/dashboard-restart.test.js asserts it). */
export const DASHBOARD_SERVICE_NAME = 'job-search-dashboard';
export const HEALTH_TIMEOUT_MS = 30000;
export const HEALTH_POLL_MS = 1000;
export const EXIT_WAIT_MS = 5000;

/** @param {string} logDir */
export function dashboardPidFile(logDir) {
  return path.join(logDir, 'dashboard.pid');
}

/**
 * Written by bin/dashboard.js after listen succeeds. Best effort: a failure never stops the dashboard.
 * @param {string} file
 * @param {number} pid
 */
export function writePidFile(file, pid) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(pid), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the pidfile only when it still names this pid (a newer dashboard's file is never removed).
 * @param {string} file
 * @param {number} pid
 */
export function removePidFileIfOwn(file, pid) {
  try {
    if (readPidFile(file) === pid) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** @param {string} file @returns {number|null} */
export function readPidFile(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** @param {string} p */
export function normalizeForMatch(p) {
  return p.replace(/["']/g, '').replace(/\\/g, '/').toLowerCase();
}

/**
 * True only for node(.exe) whose command line contains the dashboard entry script's absolute path.
 * @param {{ name: string|null, commandLine: string|null }|null} info
 * @param {string} script absolute path to bin/dashboard.js
 */
export function isDashboardProcess(info, script) {
  if (!info || typeof info.name !== 'string' || typeof info.commandLine !== 'string') return false;
  return /^node(\.exe)?$/i.test(info.name) && normalizeForMatch(info.commandLine).includes(normalizeForMatch(script));
}

/**
 * @typedef {Object} ProcInfo
 * @property {string|null} name
 * @property {string|null} commandLine
 * @property {string|null} startedAt ISO start time, null when unknown
 */

/**
 * @typedef {Object} RestartLayers
 * @property {() => number|null} readPid
 * @property {() => Promise<number|null>} listenerPid
 * @property {(pid: number) => Promise<ProcInfo|null>} processInfo
 * @property {() => Promise<number[]>} findByScript pids of node processes whose command line holds the script
 * @property {(pid: number) => Promise<boolean>} kill
 * @property {() => Promise<boolean>} runTask start the scheduled task; true when schtasks accepted it
 * @property {() => Promise<{ outcome: string, httpStatus: number|null, reason: string|null }>} probe
 * @property {() => Promise<{ sha: string, time: string|null }>} head
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now epoch ms
 */

/** @param {string} cmd @param {string[]} args @returns {Promise<string|null>} */
function run(cmd, args) {
  return new Promise((resolve) => {
    nodeExecFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** @param {string} s @returns {any[]} */
function jsonRows(s) {
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : p ? [p] : [];
  } catch {
    return [];
  }
}

/**
 * Real process/schtasks/http/git layers.
 * @param {{ port: number, script: string, pidFile: string, repoRoot: string, taskName?: string }} o
 * @returns {RestartLayers}
 */
export function realLayers(o) {
  return {
    readPid: () => readPidFile(o.pidFile),
    listenerPid: () => findListeningPid(o.port),
    async processInfo(pid) {
      const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { [pscustomobject]@{ Name = $p.Name; CommandLine = $p.CommandLine; Started = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
      const out = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps]);
      const row = out ? jsonRows(out)[0] : null;
      if (!row) return null;
      return {
        name: typeof row.Name === 'string' ? row.Name : null,
        commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : null,
        startedAt: typeof row.Started === 'string' ? row.Started : null,
      };
    },
    async findByScript() {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { [pscustomobject]@{ Pid = $_.ProcessId; CommandLine = $_.CommandLine } } | ConvertTo-Json -Compress`;
      const out = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps]);
      if (!out) return [];
      return jsonRows(out)
        .filter((r) => r && Number.isInteger(r.Pid) && typeof r.CommandLine === 'string' && normalizeForMatch(r.CommandLine).includes(normalizeForMatch(o.script)))
        .map((r) => r.Pid);
    },
    kill: (pid) => killProcessTree(pid),
    async runTask() {
      return (await run('schtasks', ['/run', '/tn', o.taskName ?? DASHBOARD_TASK_NAME])) !== null;
    },
    probe: () => probeDashboardHealth(o.port, DASHBOARD_SERVICE_NAME),
    async head() {
      const sha = ((await run('git', ['-C', o.repoRoot, 'rev-parse', 'HEAD'])) ?? '').trim();
      const time = ((await run('git', ['-C', o.repoRoot, 'log', '-1', '--format=%cI', 'HEAD'])) ?? '').trim();
      return { sha, time: time || null };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/**
 * @param {{ script: string, ifStale?: boolean, healthTimeoutMs?: number, pollMs?: number, exitWaitMs?: number, layers: RestartLayers }} opts
 * @returns {Promise<Record<string, any>>} {ok:true,...} or {ok:false, code, message, ...}; never throws for a classified outcome
 */
export async function restartDashboard(opts) {
  const L = opts.layers;
  const healthTimeoutMs = opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? HEALTH_POLL_MS;
  const exitWaitMs = opts.exitWaitMs ?? EXIT_WAIT_MS;

  const fromPidfile = L.readPid();
  const fromListener = await L.listenerPid();
  const fromScan = await L.findByScript();

  /** @type {Map<number, ProcInfo>} */
  const verified = new Map();
  /** @param {number|null} pid */
  const consider = async (pid) => {
    if (pid === null || verified.has(pid)) return false;
    const info = await L.processInfo(pid);
    if (isDashboardProcess(info, opts.script)) {
      verified.set(pid, /** @type {ProcInfo} */ (info));
      return true;
    }
    return false;
  };
  await consider(fromPidfile); // a stale/foreign pidfile pid simply fails verification and is ignored
  const listenerOk = await consider(fromListener);
  for (const pid of fromScan) await consider(pid);

  if (fromListener !== null && !listenerOk && !verified.has(fromListener)) {
    return { ok: false, code: 'FOREIGN_LISTENER', message: `pid ${fromListener} is listening on the dashboard port but is not the dashboard (bin/dashboard.js under node); refusing to touch it`, listener_pid: fromListener };
  }
  if (verified.size > 1) {
    return { ok: false, code: 'AMBIGUOUS', message: `${verified.size} dashboard processes match (${[...verified.keys()].join(', ')}); refusing to guess which to stop`, pids: [...verified.keys()] };
  }

  const head = await L.head();
  /** @type {number|null} */
  const oldPid = verified.size === 1 ? [...verified.keys()][0] : null;
  const oldInfo = oldPid === null ? null : /** @type {ProcInfo} */ (verified.get(oldPid));

  if (opts.ifStale && oldInfo) {
    const started = oldInfo.startedAt ? Date.parse(oldInfo.startedAt) : NaN;
    const headMs = head.time ? Date.parse(head.time) : NaN;
    if (Number.isNaN(started) || Number.isNaN(headMs)) {
      return { ok: true, restarted: false, reason: 'staleness_unknown', old_pid: oldPid, started_at: oldInfo.startedAt, served_commit: head.sha, head_commit_time: head.time };
    }
    if (started >= headMs) {
      return { ok: true, restarted: false, reason: 'not_stale', old_pid: oldPid, started_at: oldInfo.startedAt, served_commit: head.sha, head_commit_time: head.time };
    }
  }

  if (oldPid !== null) {
    await L.kill(oldPid);
    const deadline = L.now() + exitWaitMs;
    while (L.now() < deadline) {
      if (!isDashboardProcess(await L.processInfo(oldPid), opts.script)) break;
      await L.sleep(250);
    }
    if (isDashboardProcess(await L.processInfo(oldPid), opts.script)) {
      return { ok: false, code: 'KILL_FAILED', message: `pid ${oldPid} did not exit after taskkill`, old_pid: oldPid };
    }
  }

  if (!(await L.runTask())) {
    return { ok: false, code: 'TASK_START_FAILED', message: 'schtasks /run failed for the dashboard task', old_pid: oldPid, stopped: oldPid !== null };
  }

  const deadline = L.now() + healthTimeoutMs;
  let last = await L.probe();
  for (;;) {
    if (last.outcome === 'healthy') {
      const cand = L.readPid() ?? (await L.listenerPid());
      if (cand !== null && cand !== oldPid) {
        const info = await L.processInfo(cand);
        if (isDashboardProcess(info, opts.script)) {
          return { ok: true, restarted: true, old_pid: oldPid, new_pid: cand, started_at: info?.startedAt ?? new Date(L.now()).toISOString(), http_status: last.httpStatus, served_commit: head.sha };
        }
      }
    }
    if (L.now() >= deadline) break;
    await L.sleep(pollMs);
    last = await L.probe();
  }
  return { ok: false, code: 'HEALTH_TIMEOUT', message: `dashboard not healthy within ${healthTimeoutMs} ms of starting the task (${last.reason ?? last.outcome})`, old_pid: oldPid, http_status: last.httpStatus, served_commit: head.sha };
}

/**
 * Same rule as resolvePort() in bin/dashboard.js (integer 1024-65535, else 7311). Duplicated on purpose:
 * this module is reachable from the model-facing MCP server, and bin/dashboard.js imports credentials
 * (test/easy-apply-lint.test.js forbids that edge). test/dashboard-restart.test.js asserts parity.
 * @param {string|undefined} envValue
 */
export function dashboardPort(envValue) {
  const raw = envValue !== undefined && envValue.trim() ? Number(envValue) : undefined;
  return raw !== undefined && Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : 7311;
}

/**
 * Resolve real layers + port from the environment and run. Shared by the tool and the CLI.
 * @param {{ ifStale?: boolean }} args
 * @param {{ env: { JOBSEARCH_LOG_DIR: string, DASHBOARD_PORT?: string }, repoRoot: string }} ctx
 */
export async function restartDashboardReal(args, ctx) {
  const port = dashboardPort(ctx.env.DASHBOARD_PORT);
  const script = path.join(PACKAGE_ROOT, 'bin', 'dashboard.js');
  const pidFile = dashboardPidFile(ctx.env.JOBSEARCH_LOG_DIR);
  return restartDashboard({ script, ifStale: args.ifStale === true, layers: realLayers({ port, script, pidFile, repoRoot: ctx.repoRoot }) });
}
