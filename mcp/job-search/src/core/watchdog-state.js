// @ts-check
/**
 * Watchdog state file: the shared contract between bin/watchdog.js (the only writer, via
 * recordWatchdogRun) and bin/remind.js's daily email banner (the only reader, via readWatchdogState /
 * ackWatchdogRestarts). Self-healing watchdog + logging feature.
 *
 * File location: <JOBSEARCH_LOG_DIR>/watchdog-state.json (defaultWatchdogStateFile), alongside the
 * dated dashboard-YYYY-MM-DD.log and watchdog-YYYY-MM-DD.log files -- already covered by the repo's
 * existing `mcp/job-search/logs/` gitignore entry, so this never needs its own ignore rule.
 *
 * Total classification of `status` (every watchdog run maps to exactly one, spec branches a-d):
 *   ok                    branch (a): healthy on the first probe.
 *   restarted             branch (b): was not listening, (re)started, and the re-probe came back healthy.
 *   down                  branch (b): still unhealthy/not listening after a restart attempt, or the
 *                          spawn itself failed.
 *   stuck_foreign_process branch (c): listening but unhealthy, and either the socket owner could not be
 *                          identified or it does not match the node.exe + dashboard.js kill guard.
 *   error                 branch (d): an unexpected exception during the run.
 *
 * `restarts_since_ack` is a running counter of 'restarted' outcomes that bin/remind.js has not yet
 * surfaced in an email; it is reset to 0 only by ackWatchdogRestarts(), called by bin/remind.js right
 * after a CONFIRMED send that included the count (mirrors report.js's stampReportSent: the marker only
 * advances after a send actually goes out, so a failed send leaves the count intact for tomorrow rather
 * than silently losing it). `consecutive_failures` counts consecutive down/stuck_foreign_process/error
 * runs and resets to 0 the moment a run comes back ok or restarted.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Total classification of a watchdog run's outcome (see module doc comment). */
export const WATCHDOG_STATUSES = Object.freeze(['ok', 'restarted', 'down', 'stuck_foreign_process', 'error']);

/**
 * @typedef {Object} WatchdogState
 * @property {string} ts ISO timestamp of the run that wrote this state
 * @property {'ok'|'restarted'|'down'|'stuck_foreign_process'|'error'} status
 * @property {number} consecutive_failures consecutive down/stuck_foreign_process/error runs; 0 after an ok or restarted run
 * @property {string|null} last_restart_at ISO timestamp of the most recent 'restarted' outcome, or null if none yet
 * @property {number} restarts_since_ack count of 'restarted' outcomes not yet surfaced by remind.js's banner
 * @property {string|null} detail short scalar detail (reason, guard-mismatch description, error message); never a token or object
 */

/**
 * @param {string} logDir JOBSEARCH_LOG_DIR
 */
export function defaultWatchdogStateFile(logDir) {
  return path.join(logDir, 'watchdog-state.json');
}

/**
 * Read the state file. Returns null on any failure (missing file, unreadable, not valid JSON, not an
 * object) -- a missing/corrupt state file means "no watchdog has ever successfully reported", which the
 * caller (report.js's dashboardHealthLineText) renders as "omit the line", never as a fabricated status.
 * @param {string} file
 * @returns {WatchdogState|null}
 */
export function readWatchdogState(file) {
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
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * @param {string} file
 * @param {WatchdogState} state
 */
export function writeWatchdogState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Record one watchdog run's outcome, carrying forward consecutive_failures / restarts_since_ack /
 * last_restart_at from the previous state (or their zero/null defaults when there is no previous state
 * at all, e.g. the very first run on a fresh machine). This is the ONLY function that increments
 * consecutive_failures or restarts_since_ack; ackWatchdogRestarts() only ever resets the latter to 0.
 * @param {string} file
 * @param {{ status: WatchdogState['status'], detail: string|null }} outcome
 * @param {Date} [now]
 * @returns {WatchdogState}
 */
export function recordWatchdogRun(file, outcome, now = new Date()) {
  const prev = readWatchdogState(file);
  const prevConsecutive = prev && typeof prev.consecutive_failures === 'number' ? prev.consecutive_failures : 0;
  const prevRestartsSinceAck = prev && typeof prev.restarts_since_ack === 'number' ? prev.restarts_since_ack : 0;
  const prevLastRestartAt = prev && typeof prev.last_restart_at === 'string' ? prev.last_restart_at : null;
  const isFailure = outcome.status === 'down' || outcome.status === 'stuck_foreign_process' || outcome.status === 'error';
  /** @type {WatchdogState} */
  const state = {
    ts: now.toISOString(),
    status: outcome.status,
    consecutive_failures: isFailure ? prevConsecutive + 1 : 0,
    last_restart_at: outcome.status === 'restarted' ? now.toISOString() : prevLastRestartAt,
    restarts_since_ack: outcome.status === 'restarted' ? prevRestartsSinceAck + 1 : prevRestartsSinceAck,
    detail: outcome.detail ?? null,
  };
  writeWatchdogState(file, state);
  return state;
}

/**
 * Acknowledge that bin/remind.js has surfaced the current restarts_since_ack count in a confirmed send:
 * resets it to 0 and leaves every other field untouched. A no-op (returns null) when there is no state
 * file to update. Never called for a failed send (see bin/remind.js: this runs alongside
 * stampReportSent, only after gmailSend succeeds), so a send failure leaves the count intact for the
 * next attempt, matching report.js's own marker-advance-only-on-confirmed-send rule.
 * @param {string} file
 * @param {Date} [now]
 * @returns {WatchdogState|null}
 */
export function ackWatchdogRestarts(file, now = new Date()) {
  const prev = readWatchdogState(file);
  if (!prev) return null;
  /** @type {WatchdogState} */
  const next = { ...prev, restarts_since_ack: 0 };
  writeWatchdogState(file, next);
  return next;
}
