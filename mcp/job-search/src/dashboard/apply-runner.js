// @ts-check
/**
 * Apply runner (apply pipeline slice 5). Copies src/dashboard/scan-runner.js's shape exactly: a detached
 * spawn of `bin/apply.js --application <id> --run-marker <path>`, single-flight LOCKED (one application at
 * a time, globally -- matches the plan's "one application at a time"), marker-file correlation (never
 * spawn timestamps), and a cancel/hard-timeout backstop. Scans and applies additionally serialize on the
 * SAME advisory lock family (src/apply/worker.js's LOCK_KEY === src/core/scan-run.js's LOCK_KEY, both
 * 730193001) so they never share the scan Chrome concurrently -- that serialization happens inside the two
 * workers themselves (pg_try_advisory_lock), not here; this module's own single-flight only prevents two
 * apply runs from racing each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { JobSearchError, errFields } from '../core/errors.js';
import { log as defaultLog } from '../core/logger.js';
import { DashboardError } from './http.js';

export const MARKER_TIMEOUT_MS = 30000;
export const CANCEL_BACKSTOP_MS = 45000;
/** Worker's own internal AbortController fires at 6 minutes (src/apply/worker.js's APPLY_TIMEOUT_MS); this
 * backstop gives it a grace period to unwind cleanly before the runner force-kills the process tree. */
export const HARD_TIMEOUT_MS = 6 * 60 * 1000 + 60000;

/**
 * @typedef {Object} ApplyRunnerDeps
 * @property {import('../core/config.js').Env} env
 * @property {string} logDir absolute path; created if missing
 * @property {string} applyScript absolute path to bin/apply.js
 * @property {string} [node] defaults to process.execPath
 * @property {typeof import('node:child_process').spawn} [spawn]
 * @property {typeof execFile} [execFile]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 * @property {number} [markerTimeoutMs]
 * @property {number} [cancelBackstopMs]
 * @property {number} [hardTimeoutMs]
 */

/**
 * @param {ApplyRunnerDeps} deps
 */
export function createApplyRunner(deps) {
  const node = deps.node ?? process.execPath;
  const say = deps.log ?? ((f) => defaultLog.info(f));
  const doExecFile = deps.execFile ?? execFile;
  const markerTimeoutMs = deps.markerTimeoutMs ?? MARKER_TIMEOUT_MS;
  const cancelBackstopMs = deps.cancelBackstopMs ?? CANCEL_BACKSTOP_MS;
  const hardTimeoutMs = deps.hardTimeoutMs ?? HARD_TIMEOUT_MS;

  /** @type {{ applicationId: number, pid: number|null, startedAt: Date, child: import('node:child_process').ChildProcess } | null} */
  let current = null;

  function markerFile(markerId) {
    return path.join(deps.logDir, `apply-${markerId}.json.marker`);
  }

  function status() {
    return {
      running: Boolean(current),
      applicationId: current ? current.applicationId : null,
      pid: current ? current.pid : null,
      startedAt: current ? current.startedAt.toISOString() : null,
    };
  }

  /**
   * @param {number} applicationId
   * @returns {Promise<{ applicationId: number, pid: number|null }>}
   */
  async function start(applicationId) {
    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      throw new JobSearchError('VALIDATION', 'apply-runner.start: applicationId must be a positive integer');
    }
    if (current) throw new JobSearchError('LOCKED', 'an apply run is already in progress');

    fs.mkdirSync(deps.logDir, { recursive: true });
    const markerId = `${process.pid}-${process.hrtime.bigint()}-${crypto.randomBytes(4).toString('hex')}`;
    const marker = markerFile(markerId);

    const cliArgs = [deps.applyScript, '--application', String(applicationId), '--run-marker', marker];

    const spawnFn = deps.spawn;
    const child = spawnFn(node, cliArgs, {
      cwd: path.dirname(path.dirname(deps.applyScript)),
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

    const entry = { applicationId, pid: child.pid ?? null, startedAt: new Date(), child };
    current = entry;

    // Hard-timeout backstop: force-kills the process tree if it is still THIS entry after hardTimeoutMs,
    // regardless of whether a cancel was ever requested -- the worker's own internal abort should have
    // already unwound by then; this is the "hard 6-minute abort" the amended spec asks for as a floor, not
    // a replacement for the worker's own graceful abort.
    const hardTimer = setTimeout(() => {
      if (current && current.applicationId === applicationId && current.pid === entry.pid) {
        doExecFile('taskkill', ['/pid', String(entry.pid), '/T', '/F'], (err) => {
          say({ evt: 'apply_hard_timeout_kill', application_id: applicationId, pid: entry.pid, ok: !err });
          if (current === entry) current = null;
        });
      }
    }, hardTimeoutMs);
    hardTimer.unref?.();

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
        if (!parsed || typeof parsed.application_id !== 'number') return;
        say({ evt: 'dashboard_apply_started', application_id: parsed.application_id, pid: entry.pid });
        finishStart(() => resolve({ applicationId: parsed.application_id, pid: entry.pid }));
      }, 250);

      timeout = setTimeout(() => {
        finishStart(() => {
          if (current === entry) current = null;
          clearTimeout(hardTimer);
          reject(new DashboardError(500, 'APPLY_START_TIMEOUT', 'apply run did not report starting within 30 s'));
        });
      }, markerTimeoutMs);

      child.on('error', (err) => {
        finishStart(() => {
          if (current === entry) current = null;
          clearTimeout(hardTimer);
          reject(new DashboardError(500, 'APPLY_START_FAILED', `failed to spawn apply process: ${errFields(err).err_message}`));
        });
      });

      child.on('exit', (code) => {
        if (!settled) {
          finishStart(() => {
            if (current === entry) current = null;
            clearTimeout(hardTimer);
            if (code === 2) {
              reject(new JobSearchError('LOCKED', 'another scan or apply run holds the run lock'));
            } else {
              reject(new DashboardError(500, 'APPLY_START_FAILED', `apply process exited before reporting a start (code ${code})`, { details: { exit_code: code, stderr_tail: stderrTail.slice(-300) } }));
            }
          });
          return;
        }
        if (current === entry) current = null;
      });
    });
  }

  /**
   * Cancel backstop, mirroring scan-runner's armCancelBackstop exactly: a DB-side flip (the caller does
   * that separately, e.g. via applications.transition to 'failed'/'withdrawn') plus, when THIS dashboard
   * process spawned the run and it is still not finished cancelBackstopMs later, a taskkill tree.
   * @param {number} applicationId
   */
  function armCancelBackstop(applicationId) {
    const forcedKillAvailable = Boolean(current && current.applicationId === applicationId && current.pid);
    if (forcedKillAvailable) {
      const pid = /** @type {number} */ (current.pid);
      const t = setTimeout(() => {
        if (current && current.applicationId === applicationId && current.pid === pid) {
          doExecFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
            say({ evt: 'dashboard_apply_cancel_backstop', application_id: applicationId, pid, ok: !err });
          });
        }
      }, cancelBackstopMs);
      t.unref?.();
    }
    return { forced_kill_available: forcedKillAvailable };
  }

  return { start, status, armCancelBackstop };
}
