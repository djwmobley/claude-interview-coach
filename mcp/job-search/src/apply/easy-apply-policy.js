// @ts-check
/**
 * Assisted LinkedIn Easy Apply: pacing and start-gate policy (spec G10, G11). Pure: every clock and
 * random source is passed in, so the window, spacing, and jitter rules are testable with a fake clock.
 *
 *   - Caps: linkedin.easyApplyDaily (default 5) is consumed at attempt start through src/core/budget.js's
 *     reserveBudget (see src/core/easy-apply-state.js); it is not decided here.
 *   - Morning runs (bin/auto-apply.js): only inside the 09:00-19:00 America/Chicago window, at least
 *     20 minutes after the previous attempt, with the loop itself sleeping a 20-40 minute jitter.
 *   - Dashboard clicks: no window, but at least 5 minutes after the previous attempt.
 *   - Breaker: an unexpired circuit breaker refuses every trigger.
 *   - Server-side action pacing: 1.5-4 s before every page action, 60-160 ms per typed character.
 */

/** Spec defaults; config/auto-apply.json's `linkedin` block overrides them (src/core/config.js). */
export const EASY_APPLY_DEFAULTS = Object.freeze({
  easyApplyDaily: 5,
  windowStartLocal: '09:00',
  windowEndLocal: '19:00',
  morningSpacingMinMinutes: 20,
  morningSpacingMaxMinutes: 40,
  dashboardSpacingMinutes: 5,
  breakerHours: 24,
  runTimeoutMinutes: 15,
  staleAwaitingHours: 24,
});

/** Closed trigger vocabulary. */
export const EASY_APPLY_TRIGGERS = Object.freeze(['morning', 'dashboard']);

/**
 * Wall-clock minutes since local midnight in `timezone`.
 * @param {Date} now
 * @param {string} timezone
 */
export function localMinutes(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 'NaN');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 'NaN');
  return hh * 60 + mm;
}

/** @param {string} hhmm */
function hhmmToMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

/**
 * Total start gate. First match wins: unknown trigger, breaker, window (morning only), spacing.
 * @param {{ trigger: string, now: Date, timezone: string, lastAttemptAt: Date|null, breakerUntil: Date|null, cfg: typeof EASY_APPLY_DEFAULTS }} input
 * @returns {{ ok: true } | { ok: false, reason: 'unknown_trigger'|'breaker'|'outside_window'|'spacing' }}
 */
export function checkStartGate(input) {
  const { trigger, now, timezone, lastAttemptAt, breakerUntil, cfg } = input;
  if (!EASY_APPLY_TRIGGERS.includes(trigger)) return { ok: false, reason: 'unknown_trigger' };
  if (breakerUntil && breakerUntil.getTime() > now.getTime()) return { ok: false, reason: 'breaker' };
  if (trigger === 'morning') {
    const mins = localMinutes(now, timezone);
    const start = hhmmToMinutes(cfg.windowStartLocal);
    const end = hhmmToMinutes(cfg.windowEndLocal);
    if (!(mins >= start && mins < end)) return { ok: false, reason: 'outside_window' };
  }
  const minGapMin = trigger === 'morning' ? cfg.morningSpacingMinMinutes : cfg.dashboardSpacingMinutes;
  if (lastAttemptAt && now.getTime() - lastAttemptAt.getTime() < minGapMin * 60000) return { ok: false, reason: 'spacing' };
  return { ok: true };
}

/**
 * @param {() => number} rand uniform [0, 1)
 * @param {typeof EASY_APPLY_DEFAULTS} [cfg]
 */
export function nextMorningSpacingMs(rand, cfg = EASY_APPLY_DEFAULTS) {
  const lo = cfg.morningSpacingMinMinutes * 60000;
  const hi = cfg.morningSpacingMaxMinutes * 60000;
  return lo + Math.floor(rand() * (hi - lo));
}

/** 1.5-4 s before every page action. @param {() => number} rand */
export function actionDelayMs(rand) {
  return 1500 + Math.floor(rand() * 2500);
}

/** 60-160 ms per typed character. @param {() => number} rand */
export function charDelayMs(rand) {
  return 60 + Math.floor(rand() * 100);
}
