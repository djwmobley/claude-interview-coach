// @ts-check
/**
 * The draft stage of the daily scan (plan 19.2). Called by src/core/scan-run.js right after the targets stage.
 * Like that stage it NEVER throws and never touches the scan's status or exit code: whatever happens (facts file
 * missing, no time, a throw, a hang) comes back as a small closed-code object that the caller merges into
 * stats.targets.drafts. Warn and proceed: the scan, its report and the targets stage are unaffected.
 *
 * Deadline. The stage may run 6 minutes, never past (the scan's own deadline minus the report reserve). A hard
 * timeout fires STAGE_GRACE_MS after that. Under a test runner without an injected model the stage skips
 * (test_guard): a test can never start a real `claude` process through it.
 */
import { isEtWeekday } from './dates.js';
import { computeStageTimeout, underTestRunner, STAGE_GRACE_MS } from './stage-time.js';
import { runDraftPipeline } from './drafts.js';
import { DRAFT_SCHEMA } from './draft-prompt.js';
import { makeClaudeCaller } from '../core/claude-spawn.js';

export const DRAFT_STAGE_MAX_MS = 6 * 60_000;

/**
 * Numbers and closed codes only.
 * @param {any} r
 * @returns {Record<string, unknown>}
 */
export function toDraftStats(r) {
  if (!r || typeof r !== 'object') return { ran: false, error: 'stage_failed' };
  if (r.ran !== true) return { ran: false, ...(typeof r.skipped === 'string' ? { skipped: r.skipped } : {}), ...(typeof r.error === 'string' ? { error: r.error } : {}) };
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    ran: true,
    claimed: n(r.claimed), awaiting: n(r.awaiting), parked: n(r.parked),
    awaiting_approval: n(r.awaiting_approval), gate_failed: n(r.gate_failed), review_failed: n(r.review_failed),
    discarded: n(r.discarded), regenerated: n(r.regenerated), reaped: n(r.reaped),
    ...(typeof r.stopped === 'string' ? { stopped: r.stopped === 'deadline' || r.stopped === 'aborted' ? r.stopped : 'error' } : {}),
  };
}

/**
 * @param {Object} p
 * @param {() => Promise<import('pg').ClientBase & { end?: () => Promise<void> }>} p.connect
 * @param {Date} p.now
 * @param {number} p.scanStartMs
 * @param {number} p.scanTimeoutMs
 * @param {string} p.configDir
 * @param {Parameters<typeof runDraftPipeline>[0]['callModel']} [p.callModel] explicit model caller; without it the stage refuses to run under a test runner
 * @param {(f: Record<string, unknown>) => void} [p.log]
 * @param {number} [p.nowMs]
 * @param {number} [p.maxStageMs]
 * @param {number} [p.reserveMs]
 * @param {number} [p.graceMs]
 * @param {number} [p.cap]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runDraftStage(p) {
  const log = p.log ?? (() => {});
  /** @type {(import('pg').ClientBase & { end?: () => Promise<void> })|null} */
  let client = null;
  try {
    if (!isEtWeekday(p.now)) return { ran: false, skipped: 'weekend' };
    if (underTestRunner() && !p.callModel) return { ran: false, skipped: 'test_guard' };
    const nowMs = p.nowMs ?? Date.now();
    const t = computeStageTimeout({ scanStartMs: p.scanStartMs, scanTimeoutMs: p.scanTimeoutMs, nowMs, maxMs: p.maxStageMs ?? DRAFT_STAGE_MAX_MS, reserveMs: p.reserveMs });
    if (!t.ok) return { ran: false, skipped: 'no_time' };
    try {
      client = await p.connect();
    } catch {
      return { ran: false, error: 'stage_failed' };
    }
    const callModel = p.callModel ?? makeClaudeCaller({ configDir: p.configDir, schemaJson: JSON.stringify(DRAFT_SCHEMA) });
    const ac = new AbortController();
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const hard = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), t.timeoutMs + (p.graceMs ?? STAGE_GRACE_MS)); });
    const work = Promise.resolve()
      .then(() => runDraftPipeline({ client: /** @type {any} */ (client), now: p.now, configDir: p.configDir, callModel, deadlineAt: nowMs + t.timeoutMs, signal: ac.signal, log, cap: p.cap }))
      .then((v) => v, (e) => ({ __error: e }));
    const r = /** @type {any} */ (await Promise.race([work, hard]));
    if (timer) clearTimeout(timer);
    if (r && r.__timeout) {
      ac.abort();
      log({ evt: 'target_draft_stage_timeout' });
      return { ran: false, error: 'stage_timeout' };
    }
    if (r && r.__error) {
      log({ evt: 'target_draft_stage_failed', err: r.__error instanceof Error ? r.__error.message.slice(0, 120) : 'error' });
      return { ran: false, error: 'stage_failed' };
    }
    return toDraftStats(r);
  } catch (err) {
    log({ evt: 'target_draft_stage_failed', err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    return { ran: false, error: 'stage_failed' };
  } finally {
    if (client && typeof client.end === 'function') await client.end().catch(() => {});
  }
}
