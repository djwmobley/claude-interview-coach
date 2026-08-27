// @ts-check
/**
 * Scan runner (dashboard PR 2, pr2-spec-decisions.md "Scan runner"). Spawns `bin/scan.js --trigger
 * dashboard --run-marker <path> --json <file>` as a DETACHED child; a dashboard restart never kills a
 * scan (the plan's own constraint) because nothing here holds a reference the OS needs to keep the child
 * alive, and bin/dashboard.js's shutdown handler never touches this child.
 *
 * Correlation is by marker file, never by spawn timestamps (decision 2): `scan.js` writes
 * `{"run_id": N}` to the marker path immediately after its `ic_scan_runs` INSERT returns. This module
 * races three outcomes with a hard 30 s bound:
 *   - marker file appears with a numeric run_id -> start() resolves {runId, pid}
 *   - the child exits with the "locked" exit code (2) BEFORE the marker exists -> LOCKED (a locked run
 *     never reaches the INSERT, so a pre-marker exit(2) can only mean the advisory lock was held)
 *   - the child exits with any other code before the marker -> SCAN_START_FAILED (exit code + stderr tail)
 *   - neither happens within 30 s -> SCAN_START_TIMEOUT
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { checkConfigLock } from '../core/config.js';
import { JobSearchError, errFields } from '../core/errors.js';
import { log as defaultLog } from '../core/logger.js';
import { DashboardError } from './http.js';

export const MARKER_TIMEOUT_MS = 30000;
export const CANCEL_BACKSTOP_MS = 45000;
/** bin/scan.js's exit code for both 'partial' and 'locked'; a pre-marker exit at this code can only be
 * 'locked' because a scan never reaches the ic_scan_runs INSERT (and so never writes the marker) unless
 * the advisory lock was acquired first -- see src/core/scan-run.js's order of operations. */
export const LOCKED_EXIT_CODE = 2;

/**
 * @typedef {Object} ScanRunnerDeps
 * @property {import('../core/config.js').Env} env
 * @property {string} logDir absolute path; created if missing
 * @property {string} scanScript absolute path to bin/scan.js
 * @property {string} [node] defaults to process.execPath
 * @property {typeof import('node:child_process').spawn} [spawn]
 * @property {typeof execFile} [execFile]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 * @property {number} [markerTimeoutMs] test seam; production default is MARKER_TIMEOUT_MS
 * @property {number} [cancelBackstopMs] test seam; production default is CANCEL_BACKSTOP_MS
 * @property {typeof checkConfigLock} [checkConfigLock] test seam; production default is the real one
 */

/**
 * @param {ScanRunnerDeps} deps
 */
export function createScanRunner(deps) {
  const node = deps.node ?? process.execPath;
  const say = deps.log ?? ((f) => defaultLog.info(f));
  const doExecFile = deps.execFile ?? execFile;
  const doCheckConfigLock = deps.checkConfigLock ?? checkConfigLock;
  const markerTimeoutMs = deps.markerTimeoutMs ?? MARKER_TIMEOUT_MS;
  const cancelBackstopMs = deps.cancelBackstopMs ?? CANCEL_BACKSTOP_MS;

  /** @type {{ runId: number|null, pid: number|null, startedAt: Date, child: import('node:child_process').ChildProcess } | null} */
  let current = null;

  function markerFile(markerId) {
    return path.join(deps.logDir, `scan-${markerId}.json.marker`);
  }
  function jsonOutFile(markerId) {
    return path.join(deps.logDir, `scan-${markerId}.json`);
  }
  function finalJsonFile(runId) {
    return path.join(deps.logDir, `scan-run-${runId}.json`);
  }

  function status() {
    return {
      running: Boolean(current),
      runId: current ? current.runId : null,
      pid: current ? current.pid : null,
      startedAt: current ? current.startedAt.toISOString() : null,
    };
  }

  /**
   * @param {{ profile?: string, sources?: string[], dryRun?: boolean, days?: number, maxPages?: number, minPrescore?: number }} args
   * @returns {Promise<{ runId: number, pid: number|null }>}
   */
  async function start(args = {}) {
    const lock = doCheckConfigLock();
    if (!lock.ok) {
      throw new JobSearchError('CONFIG_LOCK_MISMATCH', 'config/*.json differs from config.lock.json', { details: { expected: lock.expected, actual: lock.actual } });
    }
    if (current) throw new JobSearchError('LOCKED', 'a scan started from this dashboard is already running');

    fs.mkdirSync(deps.logDir, { recursive: true });
    const markerId = `${process.pid}-${process.hrtime.bigint()}-${crypto.randomBytes(4).toString('hex')}`;
    const marker = markerFile(markerId);
    const jsonOut = jsonOutFile(markerId);

    const cliArgs = [deps.scanScript, '--trigger', 'dashboard', '--run-marker', marker, '--json', jsonOut];
    if (args.profile) cliArgs.push('--profile', String(args.profile));
    if (args.sources && args.sources.length) cliArgs.push('--sources', args.sources.join(','));
    if (args.dryRun) cliArgs.push('--dry-run');
    if (typeof args.days === 'number') cliArgs.push('--days', String(args.days));
    if (typeof args.maxPages === 'number') cliArgs.push('--max-pages', String(args.maxPages));
    if (typeof args.minPrescore === 'number') cliArgs.push('--min-prescore', String(args.minPrescore));

    const spawnFn = deps.spawn;
    const child = spawnFn(node, cliArgs, {
      cwd: path.dirname(path.dirname(deps.scanScript)),
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...deps.env },
    });
    child.unref();

    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    const entry = { runId: /** @type {number|null} */ (null), pid: child.pid ?? null, startedAt: new Date(), child };
    current = entry;

    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {NodeJS.Timeout} */
      let poll;
      /** @type {NodeJS.Timeout} */
      let timeout;

      const finishStart = (/** @type {() => void} */ fn) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        fn();
      };

      poll = setInterval(() => {
        let raw;
        try {
          raw = fs.readFileSync(marker, 'utf8');
        } catch {
          return; // marker not written yet
        }
        /** @type {any} */
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return; // partially written; try again next tick
        }
        if (!parsed || typeof parsed.run_id !== 'number') return;
        entry.runId = parsed.run_id;
        try {
          if (fs.existsSync(jsonOut)) fs.renameSync(jsonOut, finalJsonFile(parsed.run_id));
        } catch {
          /* best effort rename; the temp name still exists on disk if this fails */
        }
        say({ evt: 'dashboard_scan_started', run_id: parsed.run_id, pid: entry.pid });
        finishStart(() => resolve({ runId: parsed.run_id, pid: entry.pid }));
      }, 250);

      timeout = setTimeout(() => {
        finishStart(() => {
          current = null;
          reject(new DashboardError(500, 'SCAN_START_TIMEOUT', 'scan did not report a run id within 30 s'));
        });
      }, markerTimeoutMs);

      child.on('error', (err) => {
        finishStart(() => {
          current = null;
          reject(new DashboardError(500, 'SCAN_START_FAILED', `failed to spawn scan process: ${errFields(err).err_message}`));
        });
      });

      child.on('exit', (code) => {
        if (!settled) {
          finishStart(() => {
            current = null;
            if (code === LOCKED_EXIT_CODE) {
              reject(new JobSearchError('LOCKED', 'another scan holds the run lock'));
            } else {
              reject(new DashboardError(500, 'SCAN_START_FAILED', `scan process exited before reporting a run id (code ${code})`, { details: { exit_code: code, stderr_tail: stderrTail.slice(-300) } }));
            }
          });
          return;
        }
        // The process finished normally after start() already resolved: clear tracking so status()/cancel
        // reflect reality instead of claiming a finished run is still live.
        if (current === entry) current = null;
      });
    });
  }

  /**
   * Cancel: the DB flip (caller does this via the existing `scans` cancel SQL) plus, when THIS dashboard
   * process spawned the run and it is still not finished 45 s later, a taskkill tree backstop (decision 4).
   * A run this process did not spawn (trigger cli/mcp, or a dashboard restart lost the pid) gets DB-flip
   * only; forced_kill_available tells the caller which copy applies.
   * @param {number} runId
   */
  function armCancelBackstop(runId) {
    const forcedKillAvailable = Boolean(current && current.runId === runId && current.pid);
    if (forcedKillAvailable) {
      const pid = /** @type {number} */ (current.pid);
      const t = setTimeout(() => {
        if (current && current.runId === runId && current.pid === pid) {
          doExecFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
            say({ evt: 'dashboard_cancel_backstop', run_id: runId, pid, ok: !err });
          });
        }
      }, cancelBackstopMs);
      t.unref?.();
    }
    return { forced_kill_available: forcedKillAvailable };
  }

  return { start, status, armCancelBackstop };
}
