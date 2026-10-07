// @ts-check
/**
 * Reroute (unblock-auto-apply Item 2, amendments A1, A3, A8, A11): an application drafted for LinkedIn Easy
 * Apply whose LinkedIn page actually sends applicants to a company ATS ("Apply on company site") is moved to
 * that ATS, so the morning approved driver (src/apply/approved-driver.js) can submit it through the ordinary
 * worker and its click-time gate. It never clicks Easy Apply and never submits anything itself.
 *
 * rerouteApplication(id, readState, deps), per application:
 *   1. A1: the per-application advisory lock (APPLICATION_LOCK_NAMESPACE, the same key the worker holds
 *      for a whole run) on a dedicated connection, then a re-read: the row must still be in `readState`
 *      (what the caller saw: 'approved', or 'needs_human' for the app 9/13 parks). Lock taken elsewhere ->
 *      locked; state moved -> state_changed. A row carrying the submit marker or the A10 marker is never
 *      probed or rerouted (skipped marker_set; the driver's own safety rows park an approved one).
 *   2. Target: the listing's own exact external target when it was probed within reprobeAfterHours;
 *      otherwise one LinkedIn probe (src/apply/linkedin-button-prepare.js prepareLinkedInListing with
 *      reprobeAfterHours 0, a page from openLinkedInProbeBrowser with reconcile false). Before the probe:
 *      the per-run reroute cap, the lifetime probe cap (3), the LinkedIn breaker, then ONE reservation of
 *      two LinkedIn details (the job page plus a possible click-probe tab; A8) against the same caps the
 *      prepare-phase probes use, including the pre-scan floor that leaves the scan's per-run share
 *      untouched. The unused click detail is refunded when no click happened; both are refunded when no
 *      browser could be opened.
 *   3. Classification of the probe result (total; first match wins):
 *        external, exact, ATS allowed (fresh atsAllow and UNATTENDED_ATS), tenant matches the listing
 *          company (A3; a confidential listing never matches), exclusion gate eligible with the NEW url
 *          (A3, inside the same transaction as the write)
 *            unattended submit on for that ATS   rerouteAts (+ the listing target, same transaction); a
 *                                                needs_human row is resumed (resumeAutomatic) -> rerouted
 *            unattended submit off               rerouteAts, then park reroute_submit_disabled
 *        external, ATS not allowed               park reroute_ats_not_allowed
 *        external, tenant mismatch/confidential  park reroute_company_mismatch; the listing target is demoted
 *                                                to 'inferred' so nothing auto-applies through it later
 *        external, exclusion not eligible        park reroute_exclusion
 *        external, unresolved or not exact       park reroute_unresolved
 *        easy_apply                              approved: back on the Easy Apply path (easy_apply);
 *                                                needs_human: note only (A11), the attempt already counted
 *        closed / already_applied                park reroute_listing_closed / reroute_already_applied
 *        challenge / auth_wall                   halted (the probe tripped the breaker; stop rerouting)
 *        breaker / budget / no browser / load    deferred (nothing parks; retried on a later run)
 *        failure / lifetime cap / per-run cap
 *        anything else                           park reroute_unknown_page
 *      "park" on an approved row is approved -> needs_human with expectedFromState 'approved' (A1). A row
 *      that is already needs_human has no self-transition: it gets a note event and keeps its existing park
 *      (outcome noted).
 */
import { getApplication, rerouteAtsUnwrapped, resumeAutomatic, parkApproved, recordApplicationEvent, hasSubmitRequestSentEver, hasAssistedNextClickEver, isStateChangedRefusal, APPLICATION_LOCK_NAMESPACE } from '../core/applications.js';
import { withTransaction } from '../core/db.js';
import { reserveBudget as defaultReserveBudget, refundBudget as defaultRefundBudget } from '../core/budget.js';
import { breakerStatus as defaultBreakerStatus } from '../core/easy-apply-state.js';
import { LIFETIME_PROBE_ATTEMPTS } from '../core/apply-target-persist.js';
import { errFields } from '../core/errors.js';
import { prepareLinkedInListing as defaultPrepareLinkedIn } from './linkedin-button-prepare.js';
import { classifyExclusion as defaultClassifyExclusion } from './exclusions.js';
import { classifyApplyUrl } from './ats-detect.js';
import { UNATTENDED_ATS, unattendedSubmitConfig } from './submit-gate.js';

/** Every outcome rerouteApplication returns (closed). */
export const REROUTE_OUTCOMES = Object.freeze(['rerouted', 'parked', 'noted', 'easy_apply', 'deferred', 'halted', 'state_changed', 'locked', 'skipped']);

/** LinkedIn details reserved per reroute probe: the job page plus a possible click-probe tab (A8). */
export const REROUTE_DETAILS_PER_PROBE = 2;

/** Labels shown on the dashboard card for each park reason. */
const PARK_LABELS = Object.freeze({
  reroute_submit_disabled: 'This LinkedIn listing applies on the company site. The application was moved to that ATS, but unattended submit is switched off for it. Submit by hand, or switch it on and Resume.',
  reroute_ats_not_allowed: 'This LinkedIn listing applies on a company site whose ATS auto-apply does not submit through. Apply by hand or withdraw.',
  reroute_company_mismatch: 'This LinkedIn listing points to an apply page whose company does not match the listing (or the listing is confidential). Nothing was submitted. Check the posting and apply by hand.',
  reroute_exclusion: 'The company apply page for this listing failed the apply exclusion check. Nothing was submitted. Review before applying.',
  reroute_unresolved: 'This LinkedIn listing applies on a company site, but the exact apply page could not be resolved. Apply by hand or withdraw.',
  reroute_listing_closed: 'The LinkedIn listing is closed. Withdraw this application.',
  reroute_already_applied: 'LinkedIn shows this job as already applied. If that was you, mark it applied.',
  reroute_unknown_page: 'The LinkedIn job page did not show a recognizable apply control. Nothing was clicked or submitted. Check the posting.',
  reroute_listing_missing: 'The listing for this application no longer exists. Withdraw this application.',
  reroute_easy_apply: 'The LinkedIn job page now shows Easy Apply. Resume this application on the dashboard to send it through the assisted Easy Apply path.',
});

/** Company-name words that never identify a company on their own. */
const COMPANY_STOPWORDS = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|group|holdings|the|plc|lp|llp)\b/g;

/** @param {string} s */
function squash(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Tenant identifier of an apply URL: classifyApplyUrl's own tenant (Greenhouse, Lever, Workday, Dayforce),
 * else the iCIMS host label without its careers-/jobs- prefix, else the SmartRecruiters company path
 * segment. Null when none can be read.
 * @param {string} url
 */
function tenantOf(url) {
  const cls = classifyApplyUrl(url);
  if (cls.tenant) return cls.tenant;
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (cls.ats === 'icims') {
    const label = host.split('.')[0] ?? '';
    return label.replace(/^(careers|jobs)-/, '') || null;
  }
  if (cls.ats === 'smartrecruiters') {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? decodeURIComponent(seg) : null;
  }
  return null;
}

/**
 * A3 company check: does the resolved apply URL's tenant name the listing's company? Total: a confidential
 * or nameless listing, an unreadable tenant, or a tenant/company pair that neither equals nor contains the
 * other (both at least 4 characters once squashed) is not a match.
 * @param {{ company: string|null, companyNorm: string|null }} listing
 * @param {string} applyUrl
 * @returns {{ ok: boolean, reason: string, tenant: string|null }}
 */
export function companyMatchesTarget(listing, applyUrl) {
  const companyNorm = String(listing.companyNorm ?? '').toLowerCase();
  const company = String(listing.company ?? '');
  if (companyNorm.startsWith('confidential') || /^\s*(confidential|undisclosed)\b/i.test(company)) return { ok: false, reason: 'confidential_listing', tenant: null };
  const tenant = tenantOf(applyUrl);
  if (!tenant) return { ok: false, reason: 'tenant_unknown', tenant: null };
  const name = squash((companyNorm || company).replace(COMPANY_STOPWORDS, ' '));
  const t = squash(tenant).replace(/^(careers|jobs)/, '').replace(/(careers|jobs|inc)$/, '');
  if (!name || !t) return { ok: false, reason: 'company_unknown', tenant };
  if (name === t) return { ok: true, reason: 'equal', tenant };
  const shorter = name.length <= t.length ? name : t;
  if (shorter.length >= 4 && (name.includes(t) || t.includes(name))) return { ok: true, reason: 'contains', tenant };
  return { ok: false, reason: 'tenant_mismatch', tenant };
}

/**
 * @typedef {Object} RerouteDeps
 * @property {() => Promise<import('pg').Client>} connectDedicated
 * @property {any} config the run's loaded config (LinkedIn caps, reprobeAfterHours)
 * @property {() => any} freshConfig config read fresh from disk (atsAllow, unattendedSubmit)
 * @property {import('./exclusions.js').ExclusionConfig} exclusionConfig
 * @property {() => Date} now
 * @property {(f: Record<string, unknown>) => void} log
 * @property {{ used: number, max: number }} runBudget probes this run (shared with the morning Easy Apply phase)
 * @property {boolean} scanRanToday
 * @property {() => Promise<{ cap: any, probeSession: any, close: () => Promise<void> }|null>} openBrowser
 * @property {typeof defaultPrepareLinkedIn} [prepareLinkedIn]
 * @property {typeof defaultReserveBudget} [reserveBudget]
 * @property {typeof defaultRefundBudget} [refundBudget]
 * @property {typeof defaultBreakerStatus} [breakerStatus]
 * @property {typeof defaultClassifyExclusion} [classifyExclusion]
 * @property {any} [probeRegistry]
 * @property {typeof fetch} [fetch]
 * @property {any} [lookup]
 * @property {boolean} [dryRun] classify-only callers: never probes (deferred dry_run)
 */

/**
 * @param {number} applicationId
 * @param {'approved'|'needs_human'} readState the state the caller read the row in
 * @param {RerouteDeps} deps
 * @returns {Promise<{ applicationId: number, readState: string, outcome: string, reason: string|null, ats?: string|null }>}
 */
export async function rerouteApplication(applicationId, readState, deps) {
  const result = (/** @type {string} */ outcome, /** @type {string|null} */ reason = null, /** @type {any} */ extra = {}) => ({ applicationId, readState, outcome, reason, ...extra });
  const client = await deps.connectDedicated();
  let locked = false;
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [APPLICATION_LOCK_NAMESPACE, applicationId]);
    locked = Boolean(lockRes.rows[0].ok);
    if (!locked) return result('locked', 'application_lock_held');
    const app = await getApplication(client, applicationId);
    if (app.state !== readState) return result('state_changed', `state_${app.state}`);
    if (await hasSubmitRequestSentEver(client, applicationId) || await hasAssistedNextClickEver(client, applicationId)) return result('skipped', 'marker_set');

    /** Park (approved) or note (needs_human), total over the row's read state. */
    const park = async (/** @type {keyof typeof PARK_LABELS} */ reason, /** @type {any} */ extra = {}) => {
      const label = PARK_LABELS[reason];
      if (readState === 'needs_human') {
        await recordApplicationEvent(client, { applicationId, kind: 'note', actor: 'auto', note: `reroute: ${reason}; the existing park stays`, meta: { reroute_reason: reason, ...extra } });
        return result('noted', reason, extra);
      }
      try {
        await parkApproved(client, applicationId, { reason, label, note: `reroute parked: ${reason}`, extra });
      } catch (err) {
        if (isStateChangedRefusal(err)) return result('state_changed', 'park_refused');
        throw err;
      }
      return result('parked', reason, extra);
    };

    const listingOf = async () => (await client.query(
      `SELECT id, url, url_normalized, company, company_norm, title, title_norm, description, apply_url, apply_ats, apply_ats_confidence,
              apply_easy_only, apply_probed_at, probe_attempts, coalesce(url_normalized, url) AS source_url
         FROM ic_job_listings WHERE id = $1`,
      [app.listing_id],
    )).rows[0] ?? null;
    let listing = await listingOf();
    if (!listing) return await park('reroute_listing_missing');

    const now = deps.now();
    const reprobeMs = (deps.config?.autoApply?.reprobeAfterHours ?? 48) * 3600000;
    const exactTarget = (/** @type {any} */ l) => l.apply_ats_confidence === 'exact' && typeof l.apply_url === 'string' && l.apply_url
      && typeof l.apply_ats === 'string' && l.apply_ats !== 'linkedin_easy' && l.apply_easy_only === false;
    const fresh = listing.apply_probed_at && now.getTime() - new Date(listing.apply_probed_at).getTime() < reprobeMs;

    /** @type {string} */
    let branch;
    if (exactTarget(listing) && fresh) {
      branch = 'external';
    } else {
      if (deps.dryRun) return result('deferred', 'dry_run');
      if (deps.runBudget.used >= deps.runBudget.max) return result('deferred', 'reroute_cap');
      if (Number(listing.probe_attempts ?? 0) >= LIFETIME_PROBE_ATTEMPTS) return result('deferred', 'lifetime_cap');
      try {
        if ((await (deps.breakerStatus ?? defaultBreakerStatus)(client, now)).tripped) return result('deferred', 'breaker');
      } catch (err) {
        deps.log({ evt: 'reroute_breaker_check_failed', application_id: applicationId, ...errFields(err) });
        return result('deferred', 'breaker_check_failed');
      }
      const li = deps.config?.adapters?.adapters?.linkedin ?? null;
      const dailyDetails = li?.dailyDetails ?? 0;
      const scanShare = typeof li?.maxDetailsPerRun === 'number' ? li.maxDetailsPerRun : 0;
      // A8: the same pre-scan floor the prepare-phase probes obey (bin/auto-apply.js runPrepare).
      const caps = { dailyPages: li?.dailyPages ?? 0, dailyDetails: deps.scanRanToday ? dailyDetails : Math.max(0, dailyDetails - scanShare) };
      const reserved = await (deps.reserveBudget ?? defaultReserveBudget)(client, 'linkedin', { details: REROUTE_DETAILS_PER_PROBE }, caps, now);
      if (!reserved.ok) return result('deferred', 'budget_exhausted');
      deps.runBudget.used++;
      const refund = async (/** @type {number} */ n) => {
        try {
          await (deps.refundBudget ?? defaultRefundBudget)(client, 'linkedin', { details: n }, now);
        } catch (err) {
          deps.log({ evt: 'reroute_refund_failed', application_id: applicationId, ...errFields(err) });
        }
      };
      const browser = await deps.openBrowser();
      if (!browser) {
        await refund(REROUTE_DETAILS_PER_PROBE);
        return result('deferred', 'no_browser');
      }
      /** @type {{ outcome: string, branch: string|null, clicked?: boolean }} */
      let probed;
      try {
        probed = await (deps.prepareLinkedIn ?? defaultPrepareLinkedIn)(client, {
          id: Number(listing.id), url: listing.url, url_normalized: listing.url_normalized,
          apply_probed_at: listing.apply_probed_at, probe_attempts: Number(listing.probe_attempts ?? 0),
        }, {
          cap: browser.cap, probeSession: browser.probeSession, probeRegistry: deps.probeRegistry, reprobeAfterHours: 0, now, dryRun: false,
          fetch: deps.fetch, lookup: deps.lookup, log: deps.log,
        });
      } finally {
        await browser.close();
      }
      if (!probed.clicked) await refund(REROUTE_DETAILS_PER_PROBE - 1);
      deps.log({ evt: 'reroute_probe', application_id: applicationId, listing_id: Number(listing.id), outcome: probed.outcome, branch: probed.branch });
      if (probed.outcome === 'halted_challenge' || probed.outcome === 'halted_auth_wall') return result('halted', String(probed.branch));
      if (probed.outcome === 'skipped_load_failure') return result('deferred', 'load_failure');
      if (probed.outcome === 'skipped_lifetime_cap') return result('deferred', 'lifetime_cap');
      if (typeof probed.outcome === 'string' && probed.outcome.startsWith('skipped_')) return result('deferred', probed.outcome.slice('skipped_'.length));
      branch = String(probed.branch ?? 'unknown');
      listing = await listingOf();
      if (!listing) return await park('reroute_listing_missing');
    }

    if (branch === 'easy_apply') {
      // A11: a needs_human row whose page now shows Easy Apply gets a note only; the probe already counted.
      if (readState === 'needs_human') return await park('reroute_easy_apply');
      return result('easy_apply', 'easy_apply_path');
    }
    if (branch === 'closed') return await park('reroute_listing_closed');
    if (branch === 'already_applied') return await park('reroute_already_applied');
    if (branch !== 'external') return await park('reroute_unknown_page', { page_branch: branch });

    if (!exactTarget(listing)) return await park('reroute_unresolved');
    const ats = String(listing.apply_ats);
    const applyUrl = String(listing.apply_url);
    const freshCfg = deps.freshConfig();
    const usc = unattendedSubmitConfig(freshCfg);
    if (!UNATTENDED_ATS.includes(ats) || !usc.atsAllow.includes(ats)) return await park('reroute_ats_not_allowed', { ats });
    const match = companyMatchesTarget({ company: listing.company ?? null, companyNorm: listing.company_norm ?? null }, applyUrl);
    if (!match.ok) {
      // A3: a mismatched target must never be auto-applied through later, by this or any other path.
      await client.query(`UPDATE ic_job_listings SET apply_ats_confidence = 'inferred' WHERE id = $1 AND apply_url = $2`, [listing.id, applyUrl]);
      return await park('reroute_company_mismatch', { ats, tenant: match.tenant, match_reason: match.reason });
    }

    // A3: the exclusion gate with the NEW url and the write, in one transaction.
    /** @type {{ branch: string, reason?: string }} */
    let verdict = { branch: 'eligible' };
    try {
      verdict = await withTransaction(client, async (c) => {
        const v = await (deps.classifyExclusion ?? defaultClassifyExclusion)({
          id: Number(listing.id), company: listing.company ?? null, companyNorm: listing.company_norm ?? null,
          title: listing.title ?? null, titleNorm: listing.title_norm ?? null, applyUrl, sourceUrl: listing.source_url ?? null, description: listing.description ?? null,
        }, { client: c, config: deps.exclusionConfig, excludeApplicationId: applicationId });
        if (v.branch !== 'eligible') return v;
        await rerouteAtsUnwrapped(c, applicationId, {
          atsType: ats, applyUrl, actor: 'auto', note: `rerouted from LinkedIn Easy Apply to ${ats} (company site)`,
          expectedFromState: readState, listingTarget: { applyUrl, applyAts: ats },
        });
        return v;
      });
    } catch (err) {
      if (isStateChangedRefusal(err)) return result('state_changed', 'reroute_refused');
      const reason = /** @type {any} */ (err)?.details?.reason;
      if (reason === 'submit_request_sent' || reason === 'requires_human_retry') return result('skipped', 'marker_set');
      throw err;
    }
    if (verdict.branch !== 'eligible') return await park('reroute_exclusion', { ats, exclusion_branch: verdict.branch });

    if (!(usc.enabled && usc.ats[ats] === true)) return await park('reroute_submit_disabled', { ats });
    if (readState === 'needs_human') {
      try {
        await resumeAutomatic(client, applicationId, { actor: 'auto', note: `rerouted to ${ats}; resumed for the morning driver` });
      } catch (err) {
        if (isStateChangedRefusal(err)) return result('state_changed', 'resume_refused');
        const reason = /** @type {any} */ (err)?.details?.reason;
        if (reason === 'requires_human_retry' || reason === 'submit_request_sent') return result('skipped', 'marker_set');
        throw err;
      }
    }
    return result('rerouted', null, { ats });
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, applicationId]);
      } catch {
        /* connection gone: the lock dies with it */
      }
    }
    await client.end().catch(() => {});
  }
}

/**
 * Report summary of a run's reroute results (Item 2): every result in exactly one bucket. A noted
 * needs_human row counts as parked (its existing park stays, with the reason noted).
 * @param {Array<{ outcome: string, reason?: string|null, ats?: string|null }>} results
 */
export function summarizeReroute(results) {
  /** @type {Record<string, number>} */
  const byAts = {};
  /** @type {Record<string, number>} */
  const parkedReasons = {};
  /** @type {Record<string, number>} */
  const deferredReasons = {};
  /** @type {Record<string, number>} */
  const otherOutcomes = {};
  let rerouted = 0;
  let parked = 0;
  let deferred = 0;
  let other = 0;
  const bump = (/** @type {Record<string, number>} */ m, /** @type {string} */ k) => { m[k] = (m[k] ?? 0) + 1; };
  for (const r of results) {
    if (r.outcome === 'rerouted') {
      rerouted++;
      bump(byAts, String(r.ats ?? 'unknown'));
    } else if (r.outcome === 'parked' || r.outcome === 'noted') {
      parked++;
      bump(parkedReasons, String(r.reason ?? 'unknown'));
    } else if (r.outcome === 'deferred') {
      deferred++;
      bump(deferredReasons, String(r.reason ?? 'unknown'));
    } else {
      other++;
      bump(otherOutcomes, String(r.outcome));
    }
  }
  return {
    attempted: results.length, rerouted, by_ats: byAts, parked, parked_reasons: parkedReasons,
    deferred, deferred_reasons: deferredReasons, other, other_outcomes: otherOutcomes,
  };
}
