// @ts-check
/**
 * Timing rules shared by the target stages of the daily scan (plan 17.3 and 19.2). Pure; imports nothing, so the
 * draft stage can use them without pulling in the runner and its source adapters.
 *
 * The stage deadline is the smaller of a stage maximum and (the scan's own deadline minus a 5-minute report
 * reserve), computed from the scan's start time and its configured wall-clock cap. At or below zero the stage
 * skips with reason no_time; a zero or negative number never reaches a timer.
 */

export const STAGE_MAX_MS = 8 * 60_000;
export const STAGE_RESERVE_MS = 5 * 60_000;
export const STAGE_GRACE_MS = 10_000;

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

/** True under node --test or bin/run-tests.js: a stage then refuses to use the real network or a real model. */
export function underTestRunner() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.JOBSEARCH_TEST_GUARD === '1';
}
