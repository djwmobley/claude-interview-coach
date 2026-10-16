// @ts-check
/**
 * The target finder stage of the daily scan (plan 17.3 and 17.5). Called by src/core/scan-run.js after the
 * triage block. It NEVER throws and never touches the scan's own status or exit code: whatever happens
 * (a throw, a hang, a timeout, no time left, a lost lock) is returned as a small closed-code object that the
 * caller merges into stats.targets. The daily report is built separately from the database, so it is built
 * and sent regardless.
 *
 * Timing (D2). The stage deadline is the smaller of 8 minutes and (the scan's own deadline minus a 5-minute
 * report reserve), computed from the scan's start time and its configured wall-clock cap. At or below zero
 * the stage skips with reason no_time; a zero or negative number never reaches a timer. The runner stops at
 * the deadline (the EDGAR client refuses further requests); a hard timeout fires STAGE_GRACE_MS later.
 */
import { runTargets } from './runner.js';
import { closedReason } from './coverage.js';
import { isEtWeekday } from './dates.js';

import { STAGE_MAX_MS, STAGE_RESERVE_MS, STAGE_GRACE_MS, computeStageTimeout, underTestRunner, stageConnect, connectBounded, STAGE_CONNECT_TIMEOUT_MS } from './stage-time.js';
export { STAGE_MAX_MS, STAGE_RESERVE_MS, STAGE_GRACE_MS, computeStageTimeout, underTestRunner };
const FLAG_WHITELIST = Object.freeze(['config_reset', 'suspicious_empty_released', 'day_overflow']);

/**
 * @param {any} r a runTargets result
 * @returns {Record<string, unknown>}
 */
export function toStageStats(r) {
  if (!r || typeof r !== 'object') return { ran: false, error: 'stage_failed' };
  if (r.status === 'skipped') return { ran: false, skipped: closedReason(r.skipped), run_id: r.run_id ?? null };
  const c = r.counts ?? {};
  /** @type {Record<string, unknown>} */
  const sources = {};
  for (const [k, v] of Object.entries(r.sources ?? {})) {
    const s = /** @type {any} */ (v);
    sources[k] = { status: s.status, reason: s.reason ? closedReason(s.reason) : null, backlog_days: s.backlog_days ?? null };
  }
  const flags = [...new Set((r.flags ?? []).map((/** @type {string} */ f) => String(f).replace(/^[a-z0-9_]+:/, '')).filter((/** @type {string} */ f) => FLAG_WHITELIST.includes(f)))];
  return {
    ran: true,
    status: r.status,
    run_id: r.run_id ?? null,
    ...(r.error ? { error: closedReason(r.error) } : {}),
    new_targets: c.new_targets ?? 0,
    new_needs_review: c.new_needs_review ?? 0,
    not_target_week: c.not_target_week ?? 0,
    sources,
    flags,
    attention: Boolean(r.attention),
  };
}

/**
 * @param {Object} p
 * @param {() => Promise<import('pg').ClientBase & { end?: () => Promise<void> }>} p.connect dedicated connection factory
 * @param {Date} p.now
 * @param {number} p.runId the ic_scan_runs row to write stats.targets into
 * @param {number} p.scanStartMs when the scan run started (epoch ms)
 * @param {number} p.scanTimeoutMs the scan's configured wall-clock cap in ms
 * @param {string} [p.configDir]
 * @param {typeof fetch} [p.fetch] explicit fetch; without it the stage refuses to run under a test runner
 * @param {string|null} [p.tokenFile]
 * @param {(f: Record<string, unknown>) => void} [p.log]
 * @param {typeof runTargets} [p.runTargetsImpl] test seam
 * @param {number} [p.nowMs] test seam (defaults to Date.now())
 * @param {number} [p.maxStageMs]
 * @param {number} [p.reserveMs]
 * @param {number} [p.graceMs]
 * @param {number} [p.connectTimeoutMs] bound on each connect (default 10 s); a hung connect is connect_timeout
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runTargetsStage(p) {
  const log = p.log ?? (() => {});
  /** @type {(import('pg').ClientBase & { end?: () => Promise<void> })|null} */
  let client = null;
  /** @param {Record<string, unknown>} stats */
  const write = async (stats) => {
    if (!client) return;
    try {
      await client.query('UPDATE ic_scan_runs SET stats = stats || $2::jsonb WHERE id = $1', [p.runId, JSON.stringify({ targets: stats })]);
    } catch (err) {
      log({ evt: 'targets_stats_write_failed', run_id: p.runId, err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    }
  };
  /**
   * Persist an early return (plan 18.7, A8). With no stage connection yet (test_guard) a short-lived one is
   * opened just for this write. A connect failure cannot be written by anyone; its returned object still lands
   * in the scan's own finalize write. Best effort, never throws.
   * @param {Record<string, unknown>} stats
   * @returns {Promise<Record<string, unknown>>}
   */
  const persistEarly = async (stats) => {
    if (client) {
      await write(stats);
      return stats;
    }
    /** @type {(import('pg').ClientBase & { end?: () => Promise<void> })|null} */
    let tmp = null;
    try {
      tmp = await connectBounded(p.connect, p.connectTimeoutMs ?? STAGE_CONNECT_TIMEOUT_MS);
      await tmp.query('UPDATE ic_scan_runs SET stats = stats || $2::jsonb WHERE id = $1', [p.runId, JSON.stringify({ targets: stats })]);
    } catch (err) {
      log({ evt: 'targets_stats_write_failed', run_id: p.runId, err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    } finally {
      if (tmp && typeof tmp.end === 'function') await tmp.end().catch(() => {});
    }
    return stats;
  };
  try {
    if (!isEtWeekday(p.now)) return { ran: false, skipped: 'weekend' };
    if (underTestRunner() && !p.fetch) return persistEarly({ ran: false, skipped: 'test_guard' });
    const nowMs = p.nowMs ?? Date.now();
    const t = computeStageTimeout({ scanStartMs: p.scanStartMs, scanTimeoutMs: p.scanTimeoutMs, nowMs, maxMs: p.maxStageMs, reserveMs: p.reserveMs });
    // The hard deadline starts BEFORE the connect (fix 1), and the connect carries its own bound inside it.
    // With no time left there is no deadline to start; the connect (only to record no_time) keeps its own bound.
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const hard = new Promise((resolve) => {
      if (t.ok) timer = setTimeout(() => resolve({ __timeout: true }), t.timeoutMs + (p.graceMs ?? STAGE_GRACE_MS));
    });
    const connectMs = p.connectTimeoutMs ?? STAGE_CONNECT_TIMEOUT_MS;
    const conn = /** @type {any} */ (await Promise.race([stageConnect(p.connect, connectMs), hard.then(() => ({ ok: false, error: 'stage_timeout' }))]));
    if (!conn.ok) {
      if (timer) clearTimeout(timer);
      log({ evt: 'targets_stage_connect_failed', run_id: p.runId, code: conn.error });
      return { ran: false, error: conn.error };
    }
    client = conn.client;
    if (!t.ok) {
      const skip = { ran: false, skipped: 'no_time' };
      await write(skip);
      return skip;
    }
    await write({ ran: false, state: 'started' });
    const ac = new AbortController();
    const deadlineAt = nowMs + t.timeoutMs;
    const impl = p.runTargetsImpl ?? runTargets;
    const work = Promise.resolve()
      .then(() => impl({ client: /** @type {any} */ (client), now: p.now, configDir: p.configDir, fetch: p.fetch, deadlineAt, signal: ac.signal, tokenFile: p.tokenFile, log }, { trigger: 'scan' }))
      .then((v) => v, (e) => ({ __error: e }));
    const r = /** @type {any} */ (await Promise.race([work, hard]));
    if (timer) clearTimeout(timer);
    /** @type {Record<string, unknown>} */
    let stats;
    if (r && r.__timeout) {
      ac.abort();
      log({ evt: 'targets_stage_timeout', run_id: p.runId });
      stats = { ran: false, error: 'stage_timeout' };
    } else if (r && r.__error) {
      log({ evt: 'targets_stage_failed', run_id: p.runId, err: r.__error instanceof Error ? r.__error.message.slice(0, 120) : 'error' });
      stats = { ran: false, error: 'stage_failed' };
    } else {
      stats = toStageStats(r);
    }
    await write(stats);
    return stats;
  } catch (err) {
    log({ evt: 'targets_stage_failed', run_id: p.runId, err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    return { ran: false, error: 'stage_failed' };
  } finally {
    if (client && typeof client.end === 'function') await client.end().catch(() => {});
  }
}
