// @ts-check
/**
 * Assisted apply handoff for a profile whose tab is opened by a scripted prelude (Workday; spec v1
 * clauses 6-7, v2 A8, A9, A11, A12). src/apply/worker.js runs the prelude (scripted entry, sign-in or
 * account creation, email verification: deterministic and model-blind, the model never sees a password),
 * which leaves exactly one tab on the wizard with Playwright's route policy still active, writes the target
 * marker, and hands back { targetId, release(keepTab) }. This module then:
 *
 *   1. issues the lease for that target id (the marker already lists the tab, so a crash before or after
 *      this point leaves a tab the next run closes and a 'submitting' row the stale reconciler handles);
 *   2. runs the headless session through the profile's runner (assisted_apply tool, Workday profile);
 *   3. closes the lease and maps its stop reason to exactly one outcome (outcomeForStop, a closed table:
 *      success ONLY from a verified finish, everything unrecognized parks needs_human);
 *   4. releases the tab: an awaiting_submit or evidence outcome keeps it, and the route policy is removed
 *      FIRST (release(true) unroutes); a failed unroute parks instead of reporting awaiting_submit (A9).
 *      The worker writes awaiting_submit and notifies only after this returns.
 * Unattended submit (spec item 2): between 3 and 4, and ONLY after a verified finish, the worker's own
 * scripted submitStep (never the model, never a tool verb) may click the single Submit control behind the
 * click-time gate (src/apply/unattended-submit.js). Its result replaces awaiting_submit and the tab is
 * closed; a null result (submitMode 'assisted', or a soft gate park) leaves step 4 exactly as before. The
 * lease is heartbeated while the session runs (spec v2 C9).
 * The model's exit code never decides anything.
 */
import { issueLease, getLease, closeLease, tripBreaker, updateLeaseState } from '../../core/easy-apply-state.js';
import { recordApplicationEvent, hasAssistedNextClickEver } from '../../core/applications.js';
import { pendingOptionFields } from './field-policy.js';

/**
 * The closed stop-reason table (A11). Every stop reason the assisted_apply tool or this handoff can record
 * maps to one outcome; any reason NOT listed (a typo, a future reason, a crash with no reason) takes the
 * default branch: needs_human 'assisted_stopped'.
 *   kind       pending_question.kind for needs_human
 *   keepTab    leave the tab open (evidence) instead of closing it
 *   trip       trip this ATS's breaker
 */
export const STOP_OUTCOMES = Object.freeze({
  finished: { kind: null, keepTab: true, trip: false },
  parked: { kind: 'question', keepTab: false, trip: false },
  fill_refused: { kind: 'question', keepTab: false, trip: false },
  unexpected_submit: { kind: 'assisted_unexpected_submit', keepTab: true, trip: true },
  challenge: { kind: 'assisted_challenge', keepTab: false, trip: true },
  auth_lost: { kind: 'assisted_auth_lost', keepTab: false, trip: false },
  session_timeout: { kind: 'assisted_auth_lost', keepTab: false, trip: false },
  password_field: { kind: 'assisted_auth_lost', keepTab: false, trip: false },
  already_applied: { kind: 'assisted_already_applied', keepTab: false, trip: false },
  uncertain_last_step: { kind: 'assisted_stopped', keepTab: false, trip: false },
  target_mismatch: { kind: 'assisted_stopped', keepTab: false, trip: false },
});

/** Labels for each needs_human kind (the ATS label is filled in). */
const KIND_LABELS = Object.freeze({
  assisted_unexpected_submit: (/** @type {string} */ ats) => `${ats} showed an application-submitted confirmation during the automated fill. Check the site; if it was sent, mark it applied. Assisted runs for ${ats} are paused for 24 hours.`,
  assisted_challenge: (/** @type {string} */ ats) => `${ats} showed a security check or rate limit during the fill. Assisted runs for ${ats} are paused for 24 hours.`,
  assisted_auth_lost: (/** @type {string} */ ats) => `${ats} signed the session out (sign-in page, session timeout, or a password prompt) during the fill. Sign in by hand and finish there, or retry.`,
  assisted_already_applied: (/** @type {string} */ ats) => `${ats} says this job was already applied to. If that was you, mark it applied.`,
  assisted_stopped: (/** @type {string} */ ats) => `The assisted ${ats} run stopped before a verified Review screen. Retry, or apply by hand.`,
});

/**
 * Map a closed lease row to exactly one outcome. Pure and total.
 * @param {{ stop_reason: string|null, finish_result: any, ledger: any }} row
 * @param {{ label: string }} profile
 * @param {string|null} pageUrl
 * @returns {{ outcome: 'awaiting_submit', reason: 'finish_verified', ledger: any[], screenshotRelPath: string|null, prefilledUnledgered: string[], keepTab: true }
 *   | { outcome: 'needs_human', pendingQuestion: any, keepTab: boolean, trip: boolean, stopReason: string }}
 */
export function outcomeForStop(row, profile, pageUrl) {
  const stopReason = typeof row?.stop_reason === 'string' && row.stop_reason ? row.stop_reason : 'no_finish';
  const fr = row?.finish_result && typeof row.finish_result === 'object' ? row.finish_result : {};
  const ledger = Array.isArray(row?.ledger) ? row.ledger : [];
  const ats = profile && typeof profile.label === 'string' ? profile.label : 'ATS';
  const entry = Object.prototype.hasOwnProperty.call(STOP_OUTCOMES, stopReason) ? /** @type {any} */ (STOP_OUTCOMES)[stopReason] : null;
  if (stopReason === 'finished' && fr.ok === true) {
    return {
      outcome: 'awaiting_submit', reason: 'finish_verified', ledger, keepTab: true,
      screenshotRelPath: typeof fr.screenshot_rel_path === 'string' ? fr.screenshot_rel_path : null,
      prefilledUnledgered: Array.isArray(fr.prefilled_unledgered) ? fr.prefilled_unledgered.filter((/** @type {unknown} */ q) => typeof q === 'string') : [],
    };
  }
  if (entry && entry.kind === 'question') {
    const pk = fr.park && typeof fr.park === 'object' ? fr.park : {};
    const label = typeof pk.question === 'string' && pk.question.trim() ? pk.question.trim().slice(0, 500) : `${ats} needs an answer (${String(pk.reason ?? 'unknown')}).`;
    return {
      outcome: 'needs_human', keepTab: false, trip: false, stopReason,
      pendingQuestion: {
        kind: 'question', label, page_url: pageUrl, assisted_reason: pk.reason ?? stopReason,
        ...(typeof pk.bank_key === 'string' ? { suggestion: { key: pk.bank_key, value: null } } : {}),
        // Answer-fallback spec F4: a parked choice field's captured options (re-sanitized, F5).
        ...pendingOptionFields(pk, profile),
      },
    };
  }
  // 'finished' without a verified result, every listed stop, and every unlisted reason.
  const kind = entry && entry.kind ? entry.kind : 'assisted_stopped';
  const detail = stopReason === 'finish_failed' && Array.isArray(fr.problems) ? `finish_failed (${fr.problems.join(', ').slice(0, 300)})` : stopReason;
  return {
    outcome: 'needs_human', keepTab: Boolean(entry && entry.keepTab && stopReason !== 'finished'), trip: Boolean(entry && entry.trip), stopReason,
    pendingQuestion: { kind, label: /** @type {any} */ (KIND_LABELS)[kind](ats), page_url: pageUrl, assisted_reason: detail },
  };
}

/**
 * @typedef {{ ok: true, targetId: string, release: (keepTab: boolean) => Promise<{ ok: boolean }> }
 *   | { ok: false, result: { outcome: 'needs_human', pendingQuestion: any }, release: (keepTab: boolean) => Promise<{ ok: boolean }> }} PreludeResult
 */

/** Lease heartbeat while the headless session fills (unattended submit spec v2 C9). */
export const LEASE_HEARTBEAT_MS = 60000;

/**
 * @typedef {(m: { ledger: any[], prefilledUnledgered: string[] }) => Promise<null | { outcome: 'submitted', confirmationRef?: null } | { outcome: 'needs_human', pendingQuestion: any, clicked?: boolean }>} SubmitStep
 *   Unattended submit (spec item 2): the worker's SCRIPTED post-finish step, run only after a verified
 *   finish and BEFORE the tab is released (the route policy is still on). null keeps the assisted
 *   awaiting_submit hand-off (submitMode 'assisted', or a soft gate park such as the kill switch).
 */

/**
 * @param {{
 *   client: import('pg').ClientBase, app: any, profile: any, trigger?: 'morning'|'dashboard',
 *   prelude: () => Promise<PreludeResult>, runner: { run: (i: { applicationId: number, leaseToken: string }) => Promise<any> },
 *   ttlMs: number, breakerHours: number, now?: () => Date, log: (f: any) => void, submitStep?: SubmitStep, heartbeatMs?: number,
 * }} p
 * @returns {Promise<{ outcome: 'awaiting_submit', targetId: string, ledger: any[], screenshotRelPath: string|null, reason: string, prefilledUnledgered: string[] } | { outcome: 'needs_human', pendingQuestion: any } | { outcome: 'submitted', confirmationRef: null }>}
 */
export async function runAssistedHandoff(p) {
  const { client, app, profile, log } = p;
  const now = p.now ?? (() => new Date());
  const pageUrl = app.apply_url ?? null;
  const pre = await p.prelude();
  if (!pre.ok) {
    await pre.release(false);
    return pre.result;
  }
  let released = false;
  try {
    const lease = await issueLease(client, { applicationId: app.id, trigger: p.trigger ?? 'dashboard', targetId: pre.targetId, ttlMs: p.ttlMs, now: now(), ats: profile.ats });
    log({ evt: 'assisted_lease_issued', application_id: app.id, lease_id: lease.leaseId, ats: profile.ats });
    /** @type {any} */
    let runResult = null;
    // C9: heartbeat the lease while the session runs, so reconcileStale never mistakes a live fill for a
    // crashed one. Best-effort: a failed heartbeat is logged, never fatal.
    const heartbeat = setInterval(() => {
      updateLeaseState(client, lease.leaseId, { lastActionAt: now() }).catch((/** @type {unknown} */ err) => {
        log({ evt: 'assisted_lease_heartbeat_failed', application_id: app.id, err_message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
      });
    }, p.heartbeatMs ?? LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      runResult = await p.runner.run({ applicationId: app.id, leaseToken: lease.token });
    } catch (err) {
      log({ evt: 'assisted_runner_threw', application_id: app.id, err_message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
    } finally {
      clearInterval(heartbeat);
    }
    await closeLease(client, lease.leaseId, { stopReason: 'no_finish' });
    const row = await getLease(client, lease.leaseId);
    await recordApplicationEvent(client, {
      applicationId: app.id, kind: 'progress', actor: 'apply', note: `assisted ${profile.ats} session ended: ${row.stop_reason}`,
      meta: { exit_code: runResult?.exitCode ?? null, timed_out: runResult?.timedOut ?? null, cost_usd: runResult?.costUsd ?? null, turns: runResult?.turns ?? null },
    });
    const mapped = outcomeForStop(row, profile, pageUrl);
    if (mapped.outcome === 'needs_human' && mapped.trip) {
      await tripBreaker(client, { reason: mapped.stopReason, applicationId: app.id, hours: p.breakerHours, now: now(), ats: profile.breakerKey });
    }
    // Unattended submit (spec item 2): after a VERIFIED finish only, and while the route policy is still
    // on, the worker's scripted step may click the single Submit control behind the click-time gate. Any
    // result it returns closes the tab; null keeps the assisted hand-off below exactly as before.
    if (mapped.outcome === 'awaiting_submit' && typeof p.submitStep === 'function') {
      const sub = await p.submitStep({ ledger: mapped.ledger, prefilledUnledgered: mapped.prefilledUnledgered });
      if (sub) {
        released = true;
        await pre.release(false);
        if (sub.outcome === 'submitted') return { outcome: 'submitted', confirmationRef: null };
        const pq = sub.pendingQuestion;
        if (sub.clicked !== true && await hasAssistedNextClickEver(client, app.id)) {
          return { outcome: 'needs_human', pendingQuestion: { ...pq, next_clicked: true, requires_human_retry: true } };
        }
        return { outcome: 'needs_human', pendingQuestion: pq };
      }
    }
    // A9: the route policy comes off BEFORE the caller writes awaiting_submit; a failed unroute parks.
    released = true;
    const rel = await pre.release(mapped.keepTab);
    if (mapped.outcome === 'awaiting_submit') {
      if (!rel.ok) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'assisted_stopped', label: `The ${profile.label} form verified, but the browser route policy could not be removed from its tab, so it was closed. Apply by hand.`, page_url: pageUrl, assisted_reason: 'unroute_failed' } };
      }
      return { outcome: 'awaiting_submit', targetId: pre.targetId, ledger: mapped.ledger, screenshotRelPath: mapped.screenshotRelPath, reason: mapped.reason, prefilledUnledgered: mapped.prefilledUnledgered };
    }
    // A10: once a Next was clicked the site may hold a draft; every parked outcome says so, and a retry is
    // a human's call (nothing retries a needs_human row automatically). Resume gate R3: the durable
    // marker (a Next click on any attempt) decides, and every automatic resume path refuses it.
    const pq = mapped.pendingQuestion;
    if (await hasAssistedNextClickEver(client, app.id)) {
      return { outcome: 'needs_human', pendingQuestion: { ...pq, next_clicked: true, requires_human_retry: true } };
    }
    return { outcome: 'needs_human', pendingQuestion: pq };
  } finally {
    if (!released) {
      try {
        await pre.release(false);
      } catch {
        /* the worker's own finally closes the session either way */
      }
    }
  }
}
