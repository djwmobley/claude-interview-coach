// @ts-check
/**
 * Unattended submit: the ONE place a final Submit control is clicked without Damian (spec v1 items 1-4,
 * spec v2 addendum C1, C3-C6, C11). Every adapter that submits (Greenhouse, Lever, SmartRecruiters, iCIMS,
 * Dayforce through ctx.submit in src/apply/worker.js; Workday through the worker's scripted post-finish
 * step) ends here, and every entry path (morning run, dashboard Apply now chain, Resume, Retry,
 * resumeAutomatic) reaches it through runApplyWorker, so the gate cannot be skipped by choosing a path.
 *
 * runGuardedSubmit(p), in order:
 *   1. takes the per-application advisory lock (re-entrant: the worker already holds it for the run; a
 *      second worker on the same application gets application_locked and never clicks);
 *   2. snapshots the page (the baseline for the confirmation check and the input to every check below);
 *   3. gathers, AT CLICK TIME: fresh config from disk (kill switch, per-ATS flag, atsAllow, Workday
 *      submitMode, dailySubmitCap), a fresh exclusion verdict excluding this application's own row, the
 *      resume file hash, the adapter's review check, the post-fill audit, the any-attempt submit marker, and
 *      today's submit count;
 *   4. classifyPreSubmit (src/apply/submit-gate.js): any park returns needs_human with no click;
 *   5. reserveSubmitMarker: the marker and the cap slot commit in ONE transaction BEFORE the click; only
 *      the caller whose insert won may click (sql/020 primary key);
 *   6. clicks through clickSingle (exactly one visible, enabled matching control, or nothing);
 *   7. polls for a confirmation signal, re-checks about 3 seconds later on a settled page, and classifies
 *      confirmed / error / unconfirmed. Only confirmed returns 'submitted'. Nothing here ever retries.
 */
import { withTransaction } from '../core/db.js';
import { errFields } from '../core/errors.js';
import {
  APPLICATION_LOCK_NAMESPACE, hasSubmitRequestSentEver, reserveSubmitMarker, submitMarkersToday, submitUnconfirmedQuestion,
} from '../core/applications.js';
import { classifyExclusion, walkDuplicateRoot } from './exclusions.js';
import { findManualLock } from '../core/manual-lock.js';
import {
  classifyPreSubmit, unattendedSubmitConfig, auditForm, auditReview, reviewSingleForm, reviewWorkday, confirmationSignal,
  classifyConfirmation, SUBMIT_GATE_KIND, SUBMIT_ERROR_KIND, WORKDAY_SUBMIT_TARGET, WORKDAY_STATE_REQUEST, PRE_SUBMIT_REASONS,
} from './submit-gate.js';

/**
 * The SAME value as src/apply/worker.js EXCLUSION_LOCK_NAMESPACE (the claim-time recheck's dedup-root
 * lock), so the click-time recheck serializes with it. Duplicated rather than imported because worker.js
 * imports this module; test/unattended-submit.test.js asserts the two are equal.
 */
export const EXCLUSION_LOCK_NAMESPACE = 907010001;

/** Poll cadence after the click (overridable by tests). */
export const CONFIRM_POLL_MS = 1000;
export const CONFIRM_MAX_POLLS = 20;
export const CONFIRM_SETTLE_MS = 3000;

/**
 * Click-time exclusion verdict (spec item 1, v2 C11): the FULL classifyExclusion with this application's
 * own row excluded (its own listing cannot carry a second active application: sql/012's partial unique
 * index), under the same dedup-root advisory lock the claim-time recheck uses, read-only (no transition).
 * @param {import('pg').ClientBase} client
 * @param {{ id: number, listing_id: number }} app
 * @param {import('./exclusions.js').ExclusionConfig} exclusionConfig
 * @returns {Promise<{ branch: string, reason?: string }>}
 */
export async function clickTimeExclusionCheck(client, app, exclusionConfig) {
  return withTransaction(client, async (c) => {
    const rootId = await walkDuplicateRoot(c, app.listing_id);
    await c.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [EXCLUSION_LOCK_NAMESPACE, rootId]);
    const r = await c.query(
      `SELECT id, company, company_norm, title, title_norm, apply_url, url, url_normalized, description FROM ic_job_listings WHERE id = $1`,
      [app.listing_id],
    );
    if (r.rowCount === 0) return { branch: 'unknown_company', reason: 'listing no longer found at the click-time recheck' };
    const l = r.rows[0];
    const verdict = await classifyExclusion(
      {
        id: Number(l.id), company: l.company ?? null, companyNorm: l.company_norm ?? null, title: l.title ?? null, titleNorm: l.title_norm ?? null,
        applyUrl: l.apply_url ?? null, sourceUrl: l.url_normalized ?? l.url ?? null, description: l.description ?? null,
      },
      { client: c, config: exclusionConfig, excludeApplicationId: app.id },
    );
    if (verdict.branch !== 'eligible') return verdict;
    // Ready to apply list R8: a listing shown to Damian on the Ready list is manual only until he hands it
    // back; the click-time gate parks it (any non-eligible branch parks in classifyPreSubmit).
    const lock = await findManualLock(c, app.listing_id);
    if (lock) return { branch: 'manual_only_lockout', reason: `shown on the Ready to apply list (lock on listing #${lock.listingId}); hand it back on the dashboard to allow unattended submit` };
    return verdict;
  });
}

/**
 * @typedef {Object} GuardedSubmitParams
 * @property {import('pg').ClientBase} client the worker's dedicated connection (holds the per-app lock)
 * @property {{ id: number, listing_id: number, apply_url: string|null, ats_type: string, resume_hash: string|null }} app
 * @property {any} cap the apply capability (pageState, clickSingle)
 * @property {'form'|'workday'} mode
 * @property {string} [submitSelector] form mode: the adapter's submit selector
 * @property {string} [scopeSelector] form mode: the adapter's form selector
 * @property {any[]} ledger form mode: { key, selector, label, value, source, bankKey?, fallbackUsed?, controlType };
 *   workday mode: the verified lease ledger
 * @property {string[]|null} [prefilledUnledgered] workday mode
 * @property {string|null} [expectedResume] workday mode: the uploaded resume's file name
 * @property {() => any} loadConfig a FRESH config read (never a cached one)
 * @property {(client: import('pg').ClientBase, app: any) => Promise<{ branch: string, reason?: string }>} exclusionCheck
 * @property {() => string|null} resumeHash the linked resume file's current sha256, or null
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(f: Record<string, unknown>) => void} log
 * @property {() => Date} [now]
 * @property {number} [pollMs]
 * @property {number} [maxPolls]
 * @property {number} [settleMs]
 */

/**
 * @param {GuardedSubmitParams} p
 * @returns {Promise<{ outcome: 'submitted', confirmationRef: null, clicked: true }
 *   | { outcome: 'needs_human', pendingQuestion: any, clicked: boolean, gate: { reason: string, soft: boolean }|null }>}
 */
export async function runGuardedSubmit(p) {
  const { client, app, cap, mode, log } = p;
  const now = p.now ?? (() => new Date());
  const pageUrl = app.apply_url ?? null;
  const ats = String(app.ats_type);
  /** @param {{ reason: string, soft: boolean, label: string, detail: string|null }} v */
  const gatePark = (v) => ({
    outcome: /** @type {const} */ ('needs_human'), clicked: false, gate: { reason: v.reason, soft: v.soft },
    pendingQuestion: { kind: SUBMIT_GATE_KIND, label: `${v.label}${v.detail ? ` (${v.detail})` : ''} Nothing was submitted.`, page_url: pageUrl, gate_reason: v.reason, gate_detail: v.detail },
  });

  const lockRes = await client.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [APPLICATION_LOCK_NAMESPACE, app.id]);
  if (!lockRes.rows[0].ok) {
    log({ evt: 'submit_gate_park', application_id: app.id, reason: 'application_locked' });
    return gatePark({ reason: 'application_locked', soft: false, label: PRE_SUBMIT_REASONS.application_locked.label, detail: null });
  }
  try {
    const stateReq = mode === 'workday'
      ? { ...WORKDAY_STATE_REQUEST }
      : { scopeSelector: p.scopeSelector, submitSelector: p.submitSelector, probes: (p.ledger ?? []).map((e) => ({ key: e.key, selector: e.selector })) };

    /** @type {any} */
    let baseline = null;
    try {
      baseline = await cap.pageState(stateReq);
    } catch (err) {
      log({ evt: 'submit_gate_snapshot_failed', application_id: app.id, ...errFields(err) });
    }

    /** @type {any} */
    let config = null;
    try {
      config = p.loadConfig();
    } catch (err) {
      log({ evt: 'submit_gate_config_failed', application_id: app.id, ...errFields(err) });
    }
    /** @type {{ branch: string, reason?: string }} */
    let exclusion;
    try {
      exclusion = await p.exclusionCheck(client, app);
    } catch (err) {
      exclusion = { branch: 'check_failed', reason: errFields(err).err_message };
    }
    /** @type {string|null} */
    let actualHash = null;
    try {
      actualHash = p.resumeHash();
    } catch {
      actualHash = null;
    }
    const usc = config ? unattendedSubmitConfig(config) : null;
    const review = !baseline ? { ok: false, reason: 'snapshot_failed' }
      : mode === 'workday' ? reviewWorkday(baseline, { expectedResume: p.expectedResume ?? null }) : reviewSingleForm(baseline);
    const audit = !baseline ? { ok: false, problems: ['snapshot_failed'] }
      : mode === 'workday' ? auditReview(baseline, p.ledger) : auditForm(baseline, p.ledger);
    const verdict = classifyPreSubmit(!usc ? null : {
      ats,
      config: usc,
      markerEver: await hasSubmitRequestSentEver(client, app.id),
      exclusion,
      resume: { expected: app.resume_hash ?? null, actual: actualHash },
      prefilledUnledgered: mode === 'workday' ? (p.prefilledUnledgered ?? null) : null,
      review,
      audit,
      count: { used: await submitMarkersToday(client, now()), cap: usc.dailySubmitCap },
    });
    if (verdict.action === 'park') {
      log({ evt: 'submit_gate_park', application_id: app.id, reason: verdict.reason, soft: verdict.soft, detail: verdict.detail ? verdict.detail.slice(0, 300) : null });
      return gatePark(verdict);
    }

    // C1 + C3: the marker and the cap slot commit together, before the click, or nothing is clicked.
    const reserved = await reserveSubmitMarker(client, { applicationId: app.id, dailyCap: usc?.dailySubmitCap, now: now() });
    if (!reserved.ok) {
      // Total: the three refusals map to their own park reasons; nothing was clicked.
      const reason = reserved.reason === 'marker_exists' ? 'marker_exists' : reserved.reason === 'cap_exhausted' ? 'cap_exhausted' : 'cap_invalid';
      const meta = PRE_SUBMIT_REASONS[reason];
      log({ evt: 'submit_gate_park', application_id: app.id, reason, soft: meta.soft });
      return gatePark({ reason, soft: meta.soft, label: meta.label, detail: null });
    }
    log({ evt: 'apply_submit_request_sent', application_id: app.id, cap_used: reserved.used });

    const target = mode === 'workday' ? WORKDAY_SUBMIT_TARGET : { selector: String(p.submitSelector), names: null };
    /** @type {{ clicked: boolean, count: number }} */
    let click;
    try {
      click = await cap.clickSingle(target.selector, { names: target.names });
    } catch (err) {
      log({ evt: 'submit_click_threw', application_id: app.id, ...errFields(err) });
      return { outcome: 'needs_human', clicked: true, gate: null, pendingQuestion: submitUnconfirmedQuestion(pageUrl, 'the click itself failed after the submit marker; it may or may not have reached the site') };
    }
    if (!click.clicked) {
      log({ evt: 'submit_click_refused', application_id: app.id, count: click.count });
      return { outcome: 'needs_human', clicked: false, gate: null, pendingQuestion: submitUnconfirmedQuestion(pageUrl, `the submit control changed between the check and the click (${click.count} matches); nothing was clicked, but the marker is permanent`) };
    }
    log({ evt: 'submit_clicked', application_id: app.id, ats });

    const pollMs = p.pollMs ?? CONFIRM_POLL_MS;
    const maxPolls = p.maxPolls ?? CONFIRM_MAX_POLLS;
    const settleMs = p.settleMs ?? CONFIRM_SETTLE_MS;
    const snapNow = async () => {
      try {
        return await cap.pageState(stateReq);
      } catch {
        return null;
      }
    };
    /** @type {any} */
    let after = null;
    for (let i = 0; i < maxPolls; i++) {
      await p.sleep(pollMs);
      const s = await snapNow();
      if (s && confirmationSignal(ats, baseline, s) !== 'none') {
        after = s;
        break;
      }
    }
    if (!after) {
      log({ evt: 'submit_unconfirmed', application_id: app.id, why: 'no_signal' });
      return { outcome: 'needs_human', clicked: true, gate: null, pendingQuestion: submitUnconfirmedQuestion(pageUrl, 'no confirmation text or thanks page appeared after the click') };
    }
    await p.sleep(settleMs);
    const settled = await snapNow();
    const final = classifyConfirmation({ ats, baseline, after, settled });
    log({ evt: 'submit_confirmation', application_id: app.id, verdict: final });
    if (final === 'confirmed') return { outcome: 'submitted', confirmationRef: null, clicked: true };
    if (final === 'error') {
      const errs = [...(Array.isArray(after?.errors) ? after.errors : []), ...(Array.isArray(settled?.errors) ? settled.errors : [])];
      return {
        outcome: 'needs_human', clicked: true, gate: null,
        pendingQuestion: {
          kind: SUBMIT_ERROR_KIND, page_url: pageUrl,
          label: `The final Submit was clicked and the site then showed an error (${String(errs[0] ?? 'validation error').slice(0, 200)}). It is never retried automatically; check the site before doing anything else.`,
        },
      };
    }
    return { outcome: 'needs_human', clicked: true, gate: null, pendingQuestion: submitUnconfirmedQuestion(pageUrl, 'the confirmation signal did not hold on a settled page') };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, app.id]);
    } catch {
      /* connection gone: the lock dies with it */
    }
  }
}
