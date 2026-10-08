// @ts-check
/**
 * Assisted LinkedIn Easy Apply: the worker-side flow (spec B4). src/apply/worker.js calls
 * easyApplyStartGate() BEFORE claiming the application (a refusal leaves it 'approved') and
 * runAssistedEasyApply() after the claim, in place of an ordinary adapter run.
 *
 * runAssistedEasyApply opens ONE new tab in the scan Chrome over raw CDP (src/browser/cdp-target.js),
 * navigates it to the guardUrl-checked LinkedIn job URL, checks for a challenge page (G11) and an existing
 * Applied badge (G12: a retry stops here when LinkedIn already shows Applied), opens the Easy Apply dialog
 * through the driver, issues the lease, detaches, and runs the headless session
 * (src/apply/easy-apply-runner.js). Afterwards it reads the lease row and maps it to exactly one outcome:
 *
 *   finish_result.ok                                -> awaiting_submit (tab left open for Damian)
 *   stop uncertain_last_step and every field verified -> awaiting_submit (G2; tab left open)
 *   stop parked                                     -> needs_human kind 'question' (the field's text)
 *   stop unexpected_submit                          -> needs_human kind 'easy_apply_unexpected_submit',
 *                                                      error event; tab left open as evidence
 *   stop challenge                                  -> needs_human kind 'easy_apply_challenge'
 *   anything else (no finish, finish_failed, a refusal, a timeout, a crash) -> needs_human kind
 *                                                      'easy_apply_stopped'
 * The model's exit code never decides anything (G8). Every outcome except the two awaiting_submit ones
 * and unexpected_submit closes the tab it opened. The tab id is never written to the apply target marker
 * file, so no later reconcile can close it.
 */
import { breakerStatus, tripBreaker, lastAttemptAt, hasEasyApplyInFlight, reserveEasyApplyAttempt, refundEasyApplyAttempt, issueLease, getLease, closeLease, demoteAbandonedTabs } from '../core/easy-apply-state.js';
import { recordApplicationEvent } from '../core/applications.js';
import { buildRegistry, guardUrl } from '../core/urlguard.js';
import { checkStartGate, EASY_APPLY_DEFAULTS } from './easy-apply-policy.js';
import { createEasyApplyDriver } from './easy-apply-driver.js';
import { connectCdp } from '../browser/cdp-target.js';
import { writeApplicationScreenshot } from './screenshot.js';
import { pendingOptionFields } from './assisted/field-policy.js';
import { LINKEDIN_PROFILE } from './assisted/profiles/linkedin.js';

/**
 * @typedef {Object} EasyApplyDeps
 * @property {'morning'|'dashboard'} [trigger] default 'dashboard'
 * @property {() => Date} [now]
 * @property {typeof connectCdp} [connectCdp]
 * @property {(cdp: any, targetId: string) => any} [createDriver]
 * @property {{ run: (input: { applicationId: number, leaseToken: string }) => Promise<any> }} [runner]
 * @property {{ source?: string, dailyPages: number, dailyDetails: number }} [linkedinCaps]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/**
 * @param {any} config loaded config
 */
export function easyApplyConfig(config) {
  return { ...EASY_APPLY_DEFAULTS, ...(config?.autoApply?.linkedin ?? {}) };
}

/**
 * @typedef {{ now: Date, linkedinSource: string }} EasyApplyCharge what a successful gate reserved, so a
 *   refused claim can refund exactly that (refundEasyApplyCharge)
 */

/**
 * Start gate, total, first refusal wins: breaker, window/spacing (by trigger), in-flight slot, daily cap
 * (the cap reservation is the last step and the only one that consumes anything). On success it returns
 * the charge it made; the worker refunds it when the claim that follows is refused (no attempt ran).
 * @param {import('pg').ClientBase} client
 * @param {{ config: any, easyApply: EasyApplyDeps }} o
 * @returns {Promise<{ ok: true, charge: EasyApplyCharge } | { ok: false, reason: string }>}
 */
export async function easyApplyStartGate(client, o) {
  const cfg = easyApplyConfig(o.config);
  const now = (o.easyApply.now ?? (() => new Date()))();
  const trigger = o.easyApply.trigger ?? 'dashboard';
  const timezone = o.config?.adapters?.run?.timezone ?? 'America/Chicago';
  const breaker = await breakerStatus(client, now);
  const gate = checkStartGate({ trigger, now, timezone, lastAttemptAt: await lastAttemptAt(client), breakerUntil: breaker.tripped ? breaker.until : null, cfg });
  if (!gate.ok) return gate;
  if (await hasEasyApplyInFlight(client)) return { ok: false, reason: 'easy_apply_in_flight' };
  const li = o.config?.adapters?.adapters?.linkedin;
  const linkedinCaps = o.easyApply.linkedinCaps ?? { source: 'linkedin', dailyPages: li?.dailyPages ?? 0, dailyDetails: li?.dailyDetails ?? 0 };
  const reserved = await reserveEasyApplyAttempt(client, { easyApplyDaily: cfg.easyApplyDaily, linkedinCaps, now });
  if (!reserved.ok) return reserved;
  return { ok: true, charge: { now, linkedinSource: linkedinCaps.source ?? 'linkedin' } };
}

/**
 * Refund what easyApplyStartGate reserved. Called only when the claim after the gate is refused.
 * @param {import('pg').ClientBase} client
 * @param {EasyApplyCharge} charge
 */
export async function refundEasyApplyCharge(client, charge) {
  await refundEasyApplyAttempt(client, { linkedinSource: charge.linkedinSource, now: charge.now });
}

/**
 * @param {{ client: import('pg').ClientBase, app: any, config: any, env: any, outputRoot: string, lookup?: any, log: (f: any) => void, easyApply: EasyApplyDeps }} p
 * @returns {Promise<{ outcome: 'awaiting_submit', targetId: string, ledger: any[], screenshotRelPath: string|null, reason: string } | { outcome: 'needs_human', pendingQuestion: any }>}
 */
export async function runAssistedEasyApply(p) {
  const { client, app, config, env, log } = p;
  const cfg = easyApplyConfig(config);
  const ea = p.easyApply;
  const now = ea.now ?? (() => new Date());
  const sleep = ea.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  const pageUrl = app.apply_url ?? null;
  /** @param {string} kind @param {string} label @param {Record<string, unknown>} [extra] */
  const park = (kind, label, extra = {}) => ({ outcome: /** @type {const} */ ('needs_human'), pendingQuestion: { kind, label, page_url: pageUrl, ...extra } });

  if (typeof app.apply_url !== 'string' || !app.apply_url) return park('easy_apply_stopped', 'This application has no LinkedIn job URL on record; apply by hand.');
  const guarded = await guardUrl(app.apply_url, buildRegistry(config), { source: 'linkedin', lookup: p.lookup });

  const cdp = await (ea.connectCdp ?? connectCdp)({ cdpHttpUrl: env.SCAN_CDP_URL });
  /** @type {string|null} */
  let targetId = null;
  let keepTab = false;
  let driver = null;
  try {
    // Housekeeping: any awaiting_submit row whose tab is gone is demoted before this run opens its own.
    try {
      const live = new Set((await cdp.listPageTargets()).map((t) => t.targetId));
      await demoteAbandonedTabs(client, { aliveTargetIds: live, reason: 'tab_missing_at_easy_apply_start' });
    } catch {
      /* best effort: never blocks this run */
    }
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = String(created.targetId);
    driver = (ea.createDriver ?? ((c, t) => createEasyApplyDriver({ cdp: c, targetId: t })))(cdp, targetId);
    await driver.attach();
    await driver.navigate(guarded.url.toString());

    const jobSnap = await driver.snapshot();
    if (jobSnap.step.kind === 'challenge' || jobSnap.step.kind === 'sent') {
      await tripBreaker(client, { reason: jobSnap.step.kind === 'sent' ? 'unexpected_submit' : 'challenge', applicationId: app.id, hours: cfg.breakerHours, now: now() });
      return park('easy_apply_challenge', 'LinkedIn showed a security check, login wall, or rate limit. Easy Apply is paused for 24 hours.');
    }
    const badge = await driver.appliedBadge();
    if (badge.state === 'applied') {
      return park('applied_badge_present', `LinkedIn already shows this job as applied (${String(badge.evidence ?? 'Applied')}). If that was you, mark it applied.`);
    }
    const opened = await driver.openDialog();
    if (!opened.clicked) return park('easy_apply_stopped', `Could not open the Easy Apply dialog (${opened.reason}). Apply by hand.`);
    await sleep(2000);
    const dialogSnap = await driver.snapshot();
    if (dialogSnap.step.kind === 'challenge' || dialogSnap.step.kind === 'sent') {
      await tripBreaker(client, { reason: dialogSnap.step.kind === 'sent' ? 'unexpected_submit' : 'challenge', applicationId: app.id, hours: cfg.breakerHours, now: now() });
      return park('easy_apply_challenge', 'LinkedIn showed a security check after opening Easy Apply. Easy Apply is paused for 24 hours.');
    }

    const lease = await issueLease(client, { applicationId: app.id, trigger: ea.trigger ?? 'dashboard', targetId, ttlMs: cfg.runTimeoutMinutes * 60000, now: now() });
    await driver.detach();
    driver = null;
    log({ evt: 'easy_apply_lease_issued', application_id: app.id, lease_id: lease.leaseId });

    /** @type {any} */
    let runResult = null;
    try {
      runResult = await /** @type {any} */ (ea.runner).run({ applicationId: app.id, leaseToken: lease.token });
    } catch (err) {
      log({ evt: 'easy_apply_runner_threw', application_id: app.id, err_message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
    }
    await closeLease(client, lease.leaseId, { stopReason: 'no_finish' });
    const row = await getLease(client, lease.leaseId);
    await recordApplicationEvent(client, {
      applicationId: app.id, kind: 'progress', actor: 'apply', note: `easy apply session ended: ${row.stop_reason}`,
      meta: { exit_code: runResult?.exitCode ?? null, timed_out: runResult?.timedOut ?? null, cost_usd: runResult?.costUsd ?? null, turns: runResult?.turns ?? null },
    });
    const ledger = Array.isArray(row.ledger) ? row.ledger : [];
    const fr = row.finish_result ?? {};

    if (row.stop_reason === 'finished' && fr.ok === true) {
      keepTab = true;
      return { outcome: 'awaiting_submit', targetId, ledger, screenshotRelPath: typeof fr.screenshot_rel_path === 'string' ? fr.screenshot_rel_path : null, reason: 'finish_verified' };
    }
    if (row.stop_reason === 'uncertain_last_step' && row.state && row.state.allVerified === true) {
      keepTab = true;
      /** @type {string|null} */
      let shot = null;
      try {
        const d2 = (ea.createDriver ?? ((c, t) => createEasyApplyDriver({ cdp: c, targetId: t })))(cdp, targetId);
        await d2.attach();
        shot = writeApplicationScreenshot(p.outputRoot, app.id, await d2.screenshot()).relPath;
        await d2.detach();
      } catch {
        shot = null;
      }
      return { outcome: 'awaiting_submit', targetId, ledger, screenshotRelPath: shot, reason: 'uncertain_last_step' };
    }
    if (row.stop_reason === 'parked') {
      const pk = fr.park ?? {};
      // Total mapping: question text present -> question kind; absent -> the stopped kind. Never a question
      // kind without text (the card would render an answer box with nothing to answer, a dead end).
      const qText = typeof pk.question === 'string' ? pk.question.trim().slice(0, 500) : '';
      if (!qText) {
        const hint = typeof pk.label_hint === 'string' && pk.label_hint.trim() ? ` The assistant described it as: ${pk.label_hint.trim().slice(0, 200)}` : '';
        return park('easy_apply_stopped', `The assistant stopped on a field it could not name. Open the job and answer it there.${hint}`, { easy_apply_reason: pk.reason ?? null });
      }
      // Answer-fallback spec F4: a parked choice field's captured options (re-sanitized, F5).
      return park('question', qText, { easy_apply_reason: pk.reason ?? null, ...(typeof pk.bank_key === 'string' ? { suggestion: { key: pk.bank_key, value: null } } : {}), ...pendingOptionFields(pk, LINKEDIN_PROFILE) });
    }
    if (row.stop_reason === 'unexpected_submit') {
      keepTab = true;
      await recordApplicationEvent(client, { applicationId: app.id, kind: 'error', actor: 'apply', note: 'easy apply: an application-sent confirmation appeared during the automated fill; breaker tripped' });
      return park('easy_apply_unexpected_submit', 'LinkedIn showed an application-sent confirmation during the automated fill. Check LinkedIn; if it was sent, mark it applied. Easy Apply is paused for 24 hours.');
    }
    if (row.stop_reason === 'challenge') return park('easy_apply_challenge', 'LinkedIn showed a security check, login wall, or rate limit during the fill. Easy Apply is paused for 24 hours.');
    const why = row.stop_reason === 'finish_failed' && Array.isArray(fr.problems) ? `finish_failed (${fr.problems.join(', ').slice(0, 300)})` : String(row.stop_reason);
    return park('easy_apply_stopped', `Easy Apply stopped before LinkedIn's Review screen could be verified: ${why}. Retry, or apply by hand.`, { easy_apply_reason: row.stop_reason });
  } finally {
    if (driver) {
      try {
        await driver.detach();
      } catch {
        /* ignore */
      }
    }
    if (targetId && !keepTab) {
      try {
        await cdp.send('Target.closeTarget', { targetId });
      } catch {
        /* already gone */
      }
    }
    cdp.close();
  }
}
