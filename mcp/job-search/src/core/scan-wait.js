// @ts-check
/**
 * Scan-state awareness for bin/auto-apply.js (fix for the 2026-09-04 race: the scan task's Task
 * Scheduler random delay pushed a scan start to 07:14, finishing 07:30, while auto-apply fired at its
 * fixed 06:55 and selected against stale/unresolved data -- select then reported 389 rows as below_fit
 * when the true blocker was that top-fit rows simply had no resolved apply target yet).
 *
 * One deadline-aware wait loop, two deadlines, both America/Chicago local times read from
 * config/auto-apply.json:
 *   - waitDeadlineLocal (soft, default "07:40"): the point past which a scan that never even started
 *     (or already failed) is no longer worth waiting on -- auto-apply self-heals Chrome and proceeds.
 *   - waitHardDeadlineLocal (hard, default "07:55"): the point past which a scan that IS actively running
 *     (or stalled -- heartbeat gone stale) is no longer worth waiting on either -- but since Chrome and the
 *     advisory lock belong to that scan, auto-apply never touches prepare/apply in this case; it runs
 *     select read-only for the report and stops.
 *
 * classifyScanState() is pure and total: every `{ row, now, timezone, staleMinutes }` input maps to
 * exactly one of finished_today / never_started / failed / running / stalled / unknown, never a silent
 * fifth case. waitForScan() is the only place that touches the database or the clock; it re-classifies on
 * every poll (so a state can migrate from the soft bucket to the hard bucket mid-wait, e.g. never_started
 * -> running, and the loop naturally starts honoring the later deadline) and returns as soon as a
 * classification resolves (finished_today) or its applicable deadline is reached -- including immediately,
 * with no polling at all, when that deadline has already passed on entry.
 */

import { startOfDayInTz } from './auto-apply-select.js';

/** States a scan-state classification can resolve to -- exhaustive, see classifyScanState's own doc. */
export const SCAN_STATES = Object.freeze(['finished_today', 'never_started', 'failed', 'running', 'stalled', 'unknown']);

/**
 * @typedef {Object} ScanRunRow
 * @property {number|string} id
 * @property {string} status one of ic_scan_runs.status's CHECK values ('running'|'ok'|'partial'|'failed'|'locked'), or
 *   any other string -- an unrecognized value is never assumed away, it maps to 'unknown' (see below).
 * @property {Date|string} started_at
 * @property {Date|string|null} [finished_at] present for completeness; classification here keys off `status`
 *   (authoritative, per the spec amendment: "status ok/partial (finished_at set OR NULL; status is authoritative)"),
 *   never off finished_at's mere presence.
 * @property {Date|string|null} [heartbeat_at]
 */

/**
 * @typedef {Object} ScanStateClassification
 * @property {typeof SCAN_STATES[number]} state
 * @property {{ runId: number|string|null, status: string|null }} detail
 */

/**
 * Total, pure classification of the latest ic_scan_runs row (or its absence) against `now`/`timezone`.
 * Never throws, never returns a state outside SCAN_STATES. A `row === null` (no scan row exists at all)
 * classifies as never_started, same as a row whose started_at falls before local midnight -- both mean
 * "no run since local midnight to wait on".
 * @param {ScanRunRow|null} row
 * @param {Date} now
 * @param {string} timezone IANA zone
 * @param {number} staleHeartbeatMinutes a 'running' row whose heartbeat_at is at least this many minutes
 *   old classifies as 'stalled' rather than 'running'.
 * @returns {ScanStateClassification}
 */
export function classifyScanState(row, now, timezone, staleHeartbeatMinutes) {
  if (!row) return { state: 'never_started', detail: { runId: null, status: null } };
  const runId = row.id ?? null;
  const status = typeof row.status === 'string' ? row.status : null;
  const midnight = startOfDayInTz(now, timezone);
  const startedAtMs = row.started_at ? new Date(row.started_at).getTime() : NaN;
  const startedToday = Number.isFinite(startedAtMs) && startedAtMs >= midnight.getTime();

  switch (status) {
    case 'ok':
    case 'partial':
      return { state: startedToday ? 'finished_today' : 'never_started', detail: { runId, status } };
    case 'failed':
    case 'locked':
      return { state: startedToday ? 'failed' : 'never_started', detail: { runId, status } };
    case 'running': {
      const heartbeatMs = row.heartbeat_at ? new Date(row.heartbeat_at).getTime() : NaN;
      const staleMs = Math.max(0, staleHeartbeatMinutes) * 60000;
      const stale = !Number.isFinite(heartbeatMs) || now.getTime() - heartbeatMs >= staleMs;
      return { state: stale ? 'stalled' : 'running', detail: { runId, status } };
    }
    default:
      // A status this classification has never seen a shape for (including null/non-string) is never
      // silently treated as any other bucket -- friction over silent escape, same ethos as
      // auto-apply-select.js's isUsLocation.
      return { state: 'unknown', detail: { runId, status } };
  }
}

/**
 * `waitDeadlineLocal`/`waitHardDeadlineLocal` ("HH:MM") -> the Date for that local wall-clock time on
 * the calendar day `now` falls on, in `timezone`. Reuses auto-apply-select.js's own local-midnight
 * technique (no timezone-arithmetic library dependency) rather than a second implementation.
 * @param {Date} now
 * @param {string} timezone
 * @param {string} hhmm "HH:MM", 24-hour
 * @returns {Date}
 */
export function localDeadline(now, timezone, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  const hours = m ? Number(m[1]) : 0;
  const minutes = m ? Number(m[2]) : 0;
  const midnight = startOfDayInTz(now, timezone);
  return new Date(midnight.getTime() + hours * 3600000 + minutes * 60000);
}

/** Whether a classified state belongs to the "scan is actively in progress" bucket, which waits on the
 * HARD deadline (Chrome/lock belong to the scan) rather than the soft one. */
function isInProgressState(state) {
  return state === 'running' || state === 'stalled';
}

/**
 * @typedef {Object} WaitForScanResult
 * @property {typeof SCAN_STATES[number]} state the final classification observed
 * @property {{ runId: number|string|null, status: string|null }} detail
 * @property {'soft'|'hard'|null} deadlineHit which deadline stopped the wait, or null when the wait
 *   resolved because the scan finished (no deadline needed)
 * @property {number} polls how many times the scan-state query actually ran (>= 1)
 */

/**
 * Poll ic_scan_runs (via `opts.queryLatestScanRun`) until the scan finishes or the applicable deadline
 * passes. Re-classifies on every poll, so the applicable deadline (soft for
 * never_started/failed/unknown, hard for running/stalled) can change mid-wait as the scan's real state
 * changes. A deadline already past on entry is evaluated exactly once, with no sleep -- `queryLatestScanRun`
 * and classification both still run, satisfying "evaluate the same table once with no polling".
 * @param {import('pg').ClientBase} client
 * @param {{
 *   timezone: string, softDeadline: Date, hardDeadline: Date, pollSeconds: number,
 *   staleHeartbeatMinutes: number, log?: (f: any) => void, sleep?: (ms: number) => Promise<void>,
 *   clock?: () => Date, queryLatestScanRun?: (client: import('pg').ClientBase) => Promise<ScanRunRow|null>,
 * }} opts clock (default `() => new Date()`) is called fresh on every poll -- a test can pass one backed
 *   by a fake, independently-advanced clock (real time.Date.now() monkey-patching does not affect
 *   `new Date()`, so this seam is the only reliable way to make the deadline math deterministic in tests).
 * @returns {Promise<WaitForScanResult>}
 */
export async function waitForScan(client, opts) {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const queryLatestScanRun = opts.queryLatestScanRun ?? defaultQueryLatestScanRun;
  const clock = opts.clock ?? (() => new Date());
  let polls = 0;
  for (;;) {
    const nowTick = clock();
    polls++;
    /** @type {ScanRunRow|null} */
    let row = null;
    let queryFailed = false;
    try {
      row = await queryLatestScanRun(client);
    } catch (err) {
      queryFailed = true;
      void err;
    }
    const classified = queryFailed
      ? { state: /** @type {const} */ ('unknown'), detail: { runId: null, status: null } }
      : classifyScanState(row, nowTick, opts.timezone, opts.staleHeartbeatMinutes);

    if (classified.state === 'finished_today') {
      return { ...classified, deadlineHit: null, polls };
    }
    const deadlineKind = isInProgressState(classified.state) ? 'hard' : 'soft';
    const deadline = deadlineKind === 'hard' ? opts.hardDeadline : opts.softDeadline;
    if (nowTick.getTime() >= deadline.getTime()) {
      return { ...classified, deadlineHit: deadlineKind, polls };
    }
    log({ evt: 'auto_apply_wait_poll', state: classified.state, deadline_kind: deadlineKind, remaining_ms: deadline.getTime() - nowTick.getTime() });
    await sleep(opts.pollSeconds * 1000);
  }
}

/**
 * Default scan-state query (spec amendment A3): the latest ic_scan_runs row overall, no date filter --
 * classifyScanState() itself decides whether that row is "today" relative to `now`/`timezone`.
 * @param {import('pg').ClientBase} client
 * @returns {Promise<ScanRunRow|null>}
 */
export async function defaultQueryLatestScanRun(client) {
  const r = await client.query('SELECT id, status, started_at, finished_at, heartbeat_at FROM ic_scan_runs ORDER BY started_at DESC LIMIT 1');
  return r.rows[0] ?? null;
}
