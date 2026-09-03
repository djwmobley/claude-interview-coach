// @ts-check
/**
 * Self-healing scan Chrome launch (spec: "scan-never-skip" PR, SPEC 9).
 *
 * The dedicated scan Chrome (chrome-scan-profile, SCAN_CDP_URL) is always supposed to be available -- the
 * scan launches its own profile rather than depending on the operator's daily driver -- so a launch
 * failure must never silently degrade browser sources for the whole run. This module proves readiness
 * with a real DevTools protocol round trip over the CDP websocket (Browser.getVersion), never by the
 * plain HTTP GET /json/version probe alone: a zombie chrome-scan-profile process can keep answering that
 * HTTP endpoint while its DevTools websocket hangs or refuses, which is exactly the failure mode that
 * caused a lost scan day. The HTTP call is still used, but only to discover the webSocketDebuggerUrl to
 * dial -- it never by itself decides readiness.
 *
 * When the protocol probe fails, every chrome-scan-profile process is killed by its WHOLE process tree,
 * matched ONLY by command line containing the configured scan profile directory -- never by process name
 * alone (chrome.exe is also the daily-driver Chrome and every other user Chrome window), and never
 * touching a process whose command line does not contain that path. The launcher then relaunches and
 * re-probes, up to two retries (three attempts total). Exhausting every attempt is not a run-ending
 * failure: the caller records a warning and proceeds, so a wedged scan Chrome degrades browser sources
 * for that one run (src/core/scan-run.js already does this via BROWSER_UNAVAILABLE) instead of losing the
 * whole day's scan.
 */
import { execFile as defaultExecFile } from 'node:child_process';

export const PROTOCOL_PROBE_TIMEOUT_MS = 5000;
export const MAX_LAUNCH_ATTEMPTS = 3; // 1 initial + 2 retries
export const KILL_SETTLE_MS = 1500;

/**
 * HTTP discovery step only: resolves the CDP websocket URL to dial. NEVER used alone to decide readiness
 * -- a zombie Chrome can answer this while its DevTools protocol itself is wedged.
 * @param {string} cdpUrl
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export async function fetchWebSocketDebuggerUrl(cdpUrl, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const res = await fetchImpl(new URL('/json/version', cdpUrl).toString(), { signal: AbortSignal.timeout(opts.timeoutMs ?? PROTOCOL_PROBE_TIMEOUT_MS) });
  if (!res.ok) return null;
  const body = await res.json();
  return body && typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : null;
}

/**
 * The only thing that counts as readiness: a real DevTools protocol round trip (Browser.getVersion) over
 * the CDP websocket, bounded by a timeout. Resolves false on any failure -- unreachable HTTP endpoint, no
 * webSocketDebuggerUrl, a websocket that never opens, or one that opens but never answers within the
 * timeout.
 * @param {string} cdpUrl
 * @param {{ fetch?: typeof fetch, WebSocket?: typeof WebSocket, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function probeDevToolsProtocol(cdpUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PROTOCOL_PROBE_TIMEOUT_MS;
  const WS = opts.WebSocket ?? WebSocket;
  let wsUrl;
  try {
    wsUrl = await fetchWebSocketDebuggerUrl(cdpUrl, opts);
  } catch {
    return false;
  }
  if (!wsUrl) return false;
  return new Promise((resolve) => {
    let settled = false;
    /** @type {WebSocket} */
    let ws;
    const finish = (/** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WS(wsUrl);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
      } catch {
        finish(false);
      }
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(/** @type {any} */ (ev).data));
      } catch {
        return;
      }
      if (msg && msg.id === 1) finish(Boolean(msg.result));
    });
    ws.addEventListener('error', () => finish(false));
    ws.addEventListener('close', () => finish(false));
  });
}

/**
 * List PIDs of chrome-scan-profile processes: matched ONLY by command line containing `profileDir`, never
 * by process name/image alone. This is a total classification of every Windows process by command-line
 * substring, not a name-based heuristic, so it never touches the daily-driver Chrome, another user
 * Chrome window, or any unrelated process that merely shares the `chrome.exe` image name. Windows-only
 * (this project runs on Windows Task Scheduler); uses PowerShell's Win32_Process rather than `wmic`,
 * which is deprecated/absent on current Windows builds.
 * @param {string} profileDir
 * @param {{ execFile?: typeof defaultExecFile }} [opts]
 * @returns {Promise<number[]>}
 */
export async function listScanProfileProcesses(profileDir, opts = {}) {
  const execFileImpl = opts.execFile ?? defaultExecFile;
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  const stdout = await new Promise((resolve, reject) => {
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, out) => {
      if (err) reject(err);
      else resolve(String(out ?? ''));
    });
  });
  let parsed;
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const needle = profileDir.toLowerCase();
  return rows
    .filter((r) => r && typeof r.CommandLine === 'string' && r.CommandLine.toLowerCase().includes(needle))
    .map((r) => Number(r.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Kill one process's whole tree (mirrors src/dashboard/scan-runner.js's own cancel backstop: `taskkill
 * /pid <pid> /T /F`). Never throws; resolves false on failure so the caller can log and keep going.
 * @param {number} pid
 * @param {{ execFile?: typeof defaultExecFile }} [opts]
 * @returns {Promise<boolean>}
 */
export async function killProcessTree(pid, opts = {}) {
  const execFileImpl = opts.execFile ?? defaultExecFile;
  return new Promise((resolve) => {
    execFileImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * Orchestrates the kill-relaunch-probe cycle. `deps.probe` and `deps.spawnChrome` are the two real
 * side-effecting seams a caller injects; `deps.listProcesses`/`deps.killTree` default to the real Windows
 * implementations above. `deps.spawnChrome(attempt)` performs one launch attempt (mkdir the profile dir,
 * spawn the Chrome process, wait for at least the HTTP endpoint to answer) and may throw; a thrown error
 * here is logged and treated the same as a failed probe on the next loop iteration, not re-thrown.
 *
 * Returns `{ launched, healed, attempts, killedPids, warning }`. `warning` is present (severity:
 * 'warning') exactly when the caller should record it on the run: CHROME_RELAUNCHED after a successful
 * self-heal (attempt > 1), or CHROME_LAUNCH_FAILED after every attempt failed. `healed`/`launched` are
 * both false with no warning when the first probe already found Chrome healthy (nothing was killed or
 * spawned).
 * @param {{ cdpUrl: string, profileDir: string }} target
 * @param {{
 *   probe: (cdpUrl: string, opts?: any) => Promise<boolean>,
 *   spawnChrome: (attempt: number) => Promise<void>,
 *   listProcesses?: typeof listScanProfileProcesses,
 *   killTree?: typeof killProcessTree,
 *   log?: (fields: Record<string, string|number|boolean|null>) => void,
 *   maxAttempts?: number,
 *   killSettleMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export async function selfHealingLaunch(target, deps) {
  const log = deps.log ?? (() => {});
  const listProcesses = deps.listProcesses ?? listScanProfileProcesses;
  const killTree = deps.killTree ?? killProcessTree;
  const maxAttempts = deps.maxAttempts ?? MAX_LAUNCH_ATTEMPTS;
  const killSettleMs = deps.killSettleMs ?? KILL_SETTLE_MS;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** @type {number[]} */
  const killedPids = [];
  /** @type {string|null} */
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let healthy = false;
    try {
      healthy = await deps.probe(target.cdpUrl, { timeoutMs: PROTOCOL_PROBE_TIMEOUT_MS });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      healthy = false;
    }
    if (healthy) {
      if (attempt === 1) {
        log({ evt: 'chrome_already_running' });
        return { launched: false, healed: false, attempts: attempt, killedPids, warning: null };
      }
      log({ evt: 'chrome_self_healed', attempts: attempt, killed_pids: killedPids.join(',') || null });
      return {
        launched: true,
        healed: true,
        attempts: attempt,
        killedPids,
        warning: { code: 'CHROME_RELAUNCHED', severity: 'warning', attempts: attempt },
      };
    }

    // Not healthy: kill any zombie chrome-scan-profile processes (command-line matched only) before
    // relaunching -- covers both "nothing is listening yet" (empty list, kill is a no-op) and "something
    // is listening but the protocol is wedged" (the actual zombie-recovery case).
    let pids = [];
    try {
      pids = await listProcesses(target.profileDir);
    } catch (err) {
      log({ evt: 'chrome_process_list_failed', attempt, err_message: err instanceof Error ? err.message : String(err) });
    }
    for (const pid of pids) {
      const ok = await killTree(pid);
      killedPids.push(pid);
      log({ evt: 'chrome_scan_profile_killed', pid, ok, attempt, reason: 'devtools_protocol_unresponsive' });
    }
    if (pids.length) await sleep(killSettleMs);

    try {
      await deps.spawnChrome(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log({ evt: 'chrome_spawn_failed', attempt, err_message: lastError });
    }
  }

  log({ evt: 'chrome_launch_exhausted', attempts: maxAttempts, killed_pids: killedPids.join(',') || null, last_error: lastError });
  return {
    launched: false,
    healed: false,
    attempts: maxAttempts,
    killedPids,
    warning: {
      code: 'CHROME_LAUNCH_FAILED',
      severity: 'warning',
      attempts: maxAttempts,
      lastError: lastError ?? 'DevTools protocol never responded',
      remedy: 'kill the chrome-scan-profile process tree and rerun, or start Chrome on the scan CDP port',
    },
  };
}
