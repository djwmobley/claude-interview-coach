// @ts-check
/**
 * Apply-target persistence (auto-apply PR B, docs/auto-apply-spec.md): the OPPORTUNISTIC half of
 * apply-target resolution, invoked from src/core/scan-run.js whenever an adapter's fetchDetail already
 * returned an apply-target hint (externalApplyUrl/easyApplyOnly/applyProbe -- src/adapters/base.js's
 * widened FetchDetailResult). This is the cheap, already-in-flight case: the page was already fetched for
 * its description, so resolving (or attempting to resolve) its apply target here saves bin/auto-apply.js's
 * own "prepare" phase from doing it again later. It is NOT the only place apply targets get resolved --
 * most scanned listings never trigger a detail fetch at all (spec R4's prescore gate), so bin/
 * auto-apply.js's prepare phase remains the PRIMARY resolution path for those; this module only covers
 * what a scan can resolve for free while it already has the page open.
 *
 * Budget discipline (spec): the CALLER (scan-run.js) enforces a per-source PER-RUN cap
 * (config/auto-apply.json's probeCapPerSource, default 10) by counting this module's 'resolved'/
 * 'unresolved' outcomes -- this module itself has no notion of "this run" or "this source", it only
 * decides, for ONE listing, whether an attempt is worth making at all: a re-probe cooldown
 * (reprobeAfterHours) skipping a listing whose apply_probed_at is too recent, and a LIFETIME cap
 * (LIFETIME_PROBE_ATTEMPTS) on probe_attempts, after which a listing is left alone permanently rather
 * than retried forever. Never writes in a dry run (spec: "dry-run: zero DB writes").
 */
import { resolveApplyTarget, INTERMEDIARY_HOSTS } from '../apply/apply-target.js';
import { buildProbeRegistryFromAtsApply } from '../apply/probe-registry.js';

/** Lifetime cap on probe_attempts (mirrors src/core/applications.js's own `attempt` column convention of
 * an application-layer cap rather than a database CHECK constraint). */
export const LIFETIME_PROBE_ATTEMPTS = 3;

/**
 * Build the production probe registry from a LoadedConfig. This is the ONE place src/core/scan-run.js
 * (a scan-path module that test/apply-lint.test.js's own lint forbids from importing src/apply/* directly)
 * reaches this construction from -- scan-run.js imports only this core-side wrapper, never
 * src/apply/probe-registry.js or src/apply/apply-target.js itself.
 * @param {import('./config.js').LoadedConfig} config
 * @returns {import('../apply/probe-registry.js').ProbeRegistry}
 */
export function buildScanProbeRegistry(config) {
  return buildProbeRegistryFromAtsApply(config.atsApply, INTERMEDIARY_HOSTS);
}

/**
 * @typedef {Object} ApplyDetail
 * @property {string|null} [externalApplyUrl]
 * @property {boolean} [easyApplyOnly]
 * @property {{ applicantTrackingSystemName?: string|null, companyName?: string|null }|null} [applyProbe]
 */

/**
 * @typedef {Object} ListingProbeState
 * @property {number} id
 * @property {string|null} url
 * @property {string|null} url_normalized
 * @property {string|Date|null} apply_probed_at
 * @property {number} probe_attempts
 */

/**
 * One listing's persistence attempt. Total classification of the outcome:
 *   - 'skipped_dry_run' / 'skipped_lifetime_cap' / 'skipped_cooldown' / 'skipped_no_candidate': no write
 *     happened and no real attempt was made -- these never count against a per-run probe budget.
 *   - 'resolved' / 'unresolved': a real attempt was made and the row was written -- these DO count.
 * @param {import('pg').ClientBase} client
 * @param {ListingProbeState} listing
 * @param {ApplyDetail|null|undefined} applyDetail
 * @param {{ probeRegistry: import('../apply/probe-registry.js').ProbeRegistry, reprobeAfterHours: number, now: Date, dryRun: boolean, fetch?: typeof fetch, lookup?: import('./urlguard.js').Lookup, manualOrigin?: string }} opts
 *   manualOrigin: manual_apply_origin for an unresolved external href ('linkedin_href'|'linkedin_click'|
 *   'detail_external', default 'detail_external'; a chase that landed on another host is 'redirect_final')
 * @returns {Promise<{ outcome: string }>}
 */
export async function persistApplyTargetForListing(client, listing, applyDetail, opts) {
  if (opts.dryRun) return { outcome: 'skipped_dry_run' };
  if ((listing.probe_attempts ?? 0) >= LIFETIME_PROBE_ATTEMPTS) return { outcome: 'skipped_lifetime_cap' };
  if (listing.apply_probed_at) {
    const ageMs = opts.now.getTime() - new Date(listing.apply_probed_at).getTime();
    if (Number.isFinite(ageMs) && ageMs < opts.reprobeAfterHours * 3600000) return { outcome: 'skipped_cooldown' };
  }

  const external = (applyDetail && applyDetail.externalApplyUrl) || null;

  // Easy-apply-only is checked BEFORE any listing-URL fallback (spec v1 F1.3): the old order let a
  // LinkedIn listing's own URL become the "candidate", so the easy-apply hint was never persisted. Stale
  // target fields are cleared (spec v2 B6) so a previously resolved external target cannot shadow it.
  if (applyDetail && applyDetail.easyApplyOnly && !external) {
    await client.query(
      `UPDATE ic_job_listings SET apply_easy_only = true, apply_url = NULL, apply_ats = NULL, apply_ats_confidence = NULL,
         apply_ats_hint = NULL, apply_probed_at = $2, probe_attempts = probe_attempts + 1, ${CLEAR_MANUAL} WHERE id = $1`,
      [listing.id, opts.now],
    );
    return { outcome: 'resolved' };
  }

  // The listing's own URL is a fallback candidate only off LinkedIn: a LinkedIn job page is never itself an
  // apply target, and resolving it could only ever report 'unresolved' while burning a lifetime attempt.
  const listingUrl = listing.url_normalized || listing.url || null;
  const candidate = external || (listingUrl && !isLinkedInListingUrl(listingUrl) ? listingUrl : null);
  const hasHintOnly = Boolean(applyDetail && applyDetail.applyProbe && !candidate);
  if (!candidate && !hasHintOnly) return { outcome: 'skipped_no_candidate' };

  const hint = applyDetail && applyDetail.applyProbe ? JSON.stringify(applyDetail.applyProbe) : null;
  const result = candidate
    ? await resolveApplyTarget(candidate, opts.probeRegistry, { fetch: opts.fetch, lookup: opts.lookup })
    : { resolved: false, reason: 'no_candidate' };
  // An external candidate or an external-apply hint means this listing is not Easy-Apply-only (spec v2 B6:
  // every non-easy outcome writes apply_easy_only = false). A plain listing-URL re-probe leaves it alone.
  const easyOnlyFalse = external || hint ? ', apply_easy_only = false' : '';

  if (result.resolved) {
    await client.query(
      `UPDATE ic_job_listings SET apply_url = $2, apply_ats = $3, apply_ats_confidence = $4,
         apply_ats_hint = coalesce($5::jsonb, apply_ats_hint), apply_probed_at = $6, probe_attempts = probe_attempts + 1${easyOnlyFalse}, ${CLEAR_MANUAL}
       WHERE id = $1`,
      [listing.id, result.url, result.ats, result.confidence, hint, opts.now],
    );
    return { outcome: 'resolved' };
  }
  // Ready to apply list R1 (spec 7.2): an EXTERNAL candidate that did not resolve to an exact ATS target is
  // kept in manual_apply_* (never apply_url, which every submit path reads as the resolved target) so the
  // Ready list can show it. A listing-URL fallback candidate, invalid_url, and no_candidate write nothing new.
  const manual = external && result.reason === 'apply_target_unresolved' ? manualApplyFields(result, external, opts.manualOrigin) : null;
  if (manual) {
    await client.query(
      `UPDATE ic_job_listings SET apply_ats_hint = coalesce($2::jsonb, apply_ats_hint), apply_probed_at = $3, probe_attempts = probe_attempts + 1${easyOnlyFalse},
         manual_apply_url = $4, manual_apply_host = $5, manual_apply_origin = $6, manual_apply_seen_at = $3
       WHERE id = $1`,
      [listing.id, hint, opts.now, manual.url, manual.host, manual.origin],
    );
    return { outcome: 'unresolved' };
  }
  await client.query(
    `UPDATE ic_job_listings SET apply_ats_hint = coalesce($2::jsonb, apply_ats_hint), apply_probed_at = $3, probe_attempts = probe_attempts + 1${easyOnlyFalse}
     WHERE id = $1`,
    [listing.id, hint, opts.now],
  );
  return { outcome: 'unresolved' };
}

/** SET fragment clearing every manual_apply_* column (a stale manual link must never shadow a real target). */
const CLEAR_MANUAL = 'manual_apply_url = NULL, manual_apply_host = NULL, manual_apply_origin = NULL, manual_apply_seen_at = NULL';

/** The manual_apply_origin vocabulary (sql/022 CHECK). */
export const MANUAL_APPLY_ORIGINS = Object.freeze(['linkedin_href', 'linkedin_click', 'detail_external', 'redirect_final']);

/**
 * @param {{ manualUrl?: string|null, host?: string|null }} result
 * @param {string} external the candidate href as given
 * @param {string|undefined} origin caller's origin; 'detail_external' when absent
 * @returns {{ url: string, host: string|null, origin: string }|null}
 */
function manualApplyFields(result, external, origin) {
  const url = typeof result.manualUrl === 'string' && result.manualUrl ? result.manualUrl : external;
  /** @type {string|null} */
  let host = null;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const base = origin && MANUAL_APPLY_ORIGINS.includes(origin) ? origin : 'detail_external';
  // A chase that ended somewhere other than the decoded candidate's own host is a redirect_final link.
  let candidateHost = null;
  try {
    candidateHost = new URL(external).hostname.toLowerCase();
  } catch {
    candidateHost = null;
  }
  const chased = candidateHost !== null && host !== candidateHost && !/linkedin\.com$/.test(candidateHost);
  return { url, host, origin: chased ? 'redirect_final' : base };
}

/**
 * True for a URL on linkedin.com (or a subdomain). Unparseable input is not LinkedIn.
 * @param {string} u
 */
function isLinkedInListingUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}
