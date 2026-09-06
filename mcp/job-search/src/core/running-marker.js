// @ts-check
/**
 * Running marker files (activity pill spec item 2): a tiny, dedicated `<name>-running.json` file at
 * `<JOBSEARCH_LOG_DIR>/<name>-running.json` that a long-running unattended CLI (bin/auto-apply.js,
 * bin/confirm.js) writes at process start and removes on every exit path, so GET /api/activity
 * (routes/activity.js) can classify "is this background job running right now" without parsing either
 * script's own multi-purpose summary file (auto-apply-latest.json already gets rewritten at every phase
 * change for a different purpose -- bin/remind.js's digest -- and bin/confirm.js has no interim status
 * file at all today).
 *
 * Location: always derived from `env.JOBSEARCH_LOG_DIR`, itself resolved by src/core/config.js's
 * `resolveFromRoot()`/`repoRoot()` against `CLAUDE_PROJECT_DIR` or this FILE's own on-disk location --
 * never `process.cwd()`. A Task Scheduler launch's working directory is not something this codebase
 * controls (see bin/register-*.ps1), so any path built from `process.cwd()` here would silently land
 * somewhere unrelated when run unattended.
 *
 * Staleness (spec item 2): a marker is treated as gone -- ignored AND deleted -- when its `started_at` is
 * older than STALE_MARKER_MS (3 hours; both auto-apply and confirm are short daily jobs, so 3 hours is
 * already a generous multiple of a normal run) OR its `pid` is not alive. A process that dies hard enough
 * to skip its own `finally` block (SIGKILL, a host power loss) would otherwise leave this file behind
 * forever, permanently misreporting "still running" to every future GET /api/activity call.
 */
import fs from 'node:fs';
import path from 'node:path';

export const STALE_MARKER_MS = 3 * 60 * 60 * 1000;

/**
 * @param {string} logDir
 * @param {string} name e.g. 'auto-apply', 'confirm'
 * @returns {string}
 */
export function runningMarkerPath(logDir, name) {
  return path.join(logDir, `${name}-running.json`);
}

/**
 * Best-effort write: a failure here (e.g. an unwritable log directory) is logged by the caller, never
 * fatal to the job itself -- the marker is an activity-pill nicety, not a correctness requirement for
 * auto-apply/confirm's own work.
 * @param {string} file
 * @param {{ pid: number, startedAt: Date, runId?: string|number|null }} info
 */
export function writeRunningMarker(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: info.pid, started_at: info.startedAt.toISOString(), run_id: info.runId ?? null }, null, 2) + '\n');
}

/** Best-effort delete; never throws. Called from a `finally` on every exit path (including a thrown
 * error), so it must not itself be able to turn a clean shutdown into a crash. */
export function deleteRunningMarker(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, or never existed -- both are the desired end state */
  }
}

/**
 * Liveness check via `process.kill(pid, 0)`: signal 0 sends no actual signal, it only asks the OS whether
 * a process with this pid could be signaled. On Windows, Node implements this via `OpenProcess` under the
 * hood -- a pid with no such process throws with `code === 'ESRCH'` exactly as on POSIX, so the same
 * ESRCH check works unmodified on both platforms. `EPERM` (the process exists but this process lacks
 * permission to signal it) is treated as ALIVE, not dead -- the only other error this call can realistically
 * throw. The one accepted blind spot (documented, not closed by this function): a fast pid-reuse race,
 * where the original process has already died and the OS has already handed the exact same pid to a
 * brand-new, unrelated process before this check runs -- vanishingly unlikely within the 3-hour staleness
 * window this module actually cares about, and not something a pid-only liveness check can ever fully
 * close on any OS.
 * @param {number} pid
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * Read and classify one marker file. Returns `null` when the file is missing, unreadable, not valid JSON,
 * missing required fields, OR stale (see module doc) -- and in every "stale or malformed" case (never the
 * plain "missing" case, which has nothing to remove) deletes the file so the next call sees a clean slate.
 * @param {string} file
 * @param {Date} now
 * @returns {{ pid: number, started_at: string, run_id: string|number|null } | null}
 */
export function readLiveMarker(file, now) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    deleteRunningMarker(file);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.pid !== 'number' || typeof parsed.started_at !== 'string') {
    deleteRunningMarker(file);
    return null;
  }
  const startedAtMs = Date.parse(parsed.started_at);
  if (!Number.isFinite(startedAtMs)) {
    deleteRunningMarker(file);
    return null;
  }
  const ageMs = now.getTime() - startedAtMs;
  if (ageMs > STALE_MARKER_MS || !isPidAlive(parsed.pid)) {
    deleteRunningMarker(file);
    return null;
  }
  return { pid: parsed.pid, started_at: parsed.started_at, run_id: parsed.run_id ?? null };
}
