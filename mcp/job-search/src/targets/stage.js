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

export const STAGE_MAX_MS = 8 * 60_000;
export const STAGE_RESERVE_MS = 5 * 60_000;
export const STAGE_GRACE_MS = 10_000;
const FLAG_WHITELIST = Object.freeze(['config_reset', 'suspicious_empty_released', 'day_overflow']);

/**
 * @param {{ scanStartMs: number, scanTimeoutMs: number, nowMs: number, maxMs?: number, reserveMs?: number }} o
 * @returns {{ ok: true, timeoutMs: number } | { ok: false, reason: 'no_time' }}
 */
export function computeStageTimeout({ scanStartMs, scanTimeoutMs, nowMs, maxMs = STAGE_MAX_MS, reserveMs = STAGE_RESERVE_MS }) {
  const left = scanStartMs + scanTimeoutMs - reserveMs - nowMs;
  const t = Math.min(maxMs, left);
  if (!Number.isFinite(t) || Math.floor(t) < 1) return { ok: false, reason: 'no_time' };
  return { ok: true, timeoutMs: Math.floor(t) };
}

/** True under node --test or bin/run-tests.js: the stage then refuses to use the real network. */
export function underTestRunner() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.JOBSEARCH_TEST_GUARD === '1';
}

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
  try {
    if (!isEtWeekday(p.now)) return { ran: false, skipped: 'weekend' };
    if (underTestRunner() && !p.fetch) return { ran: false, skipped: 'test_guard' };
    const nowMs = p.nowMs ?? Date.now();
    try {
      client = await p.connect();
    } catch {
      return { ran: false, error: 'stage_failed' };
    }
    const t = computeStageTimeout({ scanStartMs: p.scanStartMs, scanTimeoutMs: p.scanTimeoutMs, nowMs, maxMs: p.maxStageMs, reserveMs: p.reserveMs });
    if (!t.ok) {
      const skip = { ran: false, skipped: 'no_time' };
      await write(skip);
      return skip;
    }
    await write({ ran: false, state: 'started' });
    const ac = new AbortController();
    const deadlineAt = nowMs + t.timeoutMs;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const hard = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), t.timeoutMs + (p.graceMs ?? STAGE_GRACE_MS)); });
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
