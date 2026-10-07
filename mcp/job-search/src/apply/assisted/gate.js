// @ts-check
/**
 * Start gate for an assisted run whose profile is not LinkedIn (Workday; spec v1 clauses 8-9). Called by
 * src/apply/worker.js BEFORE the claim, so every refusal leaves the application 'approved'. Total, first
 * refusal wins: submit mode, this ATS's breaker, this ATS's in-flight slot, this ATS's daily cap (the cap
 * reservation is last and the only step that consumes anything; a refused claim refunds it).
 * LinkedIn keeps its own gate (src/apply/easy-apply-flow.js easyApplyStartGate: window, spacing, and the
 * LinkedIn budget).
 */
import { breakerStatus, hasAssistedInFlight, reserveWorkdayAttempt, refundWorkdayAttempt } from '../../core/easy-apply-state.js';

export const WORKDAY_ASSISTED_DEFAULTS = Object.freeze({ submitMode: 'assisted', assistedDaily: 5, breakerHours: 24, runTimeoutMinutes: 15 });

/** @param {any} config loaded config */
export function workdayAssistedConfig(config) {
  return { ...WORKDAY_ASSISTED_DEFAULTS, ...(config?.autoApply?.workday ?? {}) };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ config: any, now: Date }} o
 * @returns {Promise<{ ok: true, charge: { kind: 'workday', now: Date, day: string } } | { ok: false, reason: string }>}
 */
export async function workdayStartGate(client, o) {
  const cfg = workdayAssistedConfig(o.config);
  // Total: the two known modes run (the model fills either way; 'unattended' only changes what the worker
  // does AFTER a verified finish, behind src/apply/submit-gate.js); anything else is refused.
  if (cfg.submitMode !== 'assisted' && cfg.submitMode !== 'unattended') return { ok: false, reason: 'submit_mode_unsupported' };
  const breaker = await breakerStatus(client, o.now, 'workday');
  if (breaker.tripped) return { ok: false, reason: 'breaker' };
  if (await hasAssistedInFlight(client, 'workday')) return { ok: false, reason: 'assisted_in_flight' };
  const reserved = await reserveWorkdayAttempt(client, { daily: cfg.assistedDaily, now: o.now });
  if (!reserved.ok) return reserved;
  // A7: the charge carries the America/Chicago day it was made on; the refund goes back to that day.
  return { ok: true, charge: { kind: 'workday', now: o.now, day: reserved.day } };
}

/**
 * Refund what workdayStartGate reserved (the claim after it was refused; no attempt ran), against the
 * stored charge day (A7).
 * @param {import('pg').ClientBase} client
 * @param {{ kind: 'workday', now: Date, day?: string }} charge
 */
export async function refundWorkdayCharge(client, charge) {
  await refundWorkdayAttempt(client, { day: charge.day, now: charge.now });
}
