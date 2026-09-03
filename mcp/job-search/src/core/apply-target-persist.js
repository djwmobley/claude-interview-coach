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
 * @param {{ probeRegistry: import('../apply/probe-registry.js').ProbeRegistry, reprobeAfterHours: number, now: Date, dryRun: boolean, fetch?: typeof fetch, lookup?: import('./urlguard.js').Lookup }} opts
 * @returns {Promise<{ outcome: string }>}
 */
export async function persistApplyTargetForListing(client, listing, applyDetail, opts) {
  if (opts.dryRun) return { outcome: 'skipped_dry_run' };
  if ((listing.probe_attempts ?? 0) >= LIFETIME_PROBE_ATTEMPTS) return { outcome: 'skipped_lifetime_cap' };
  if (listing.apply_probed_at) {
    const ageMs = opts.now.getTime() - new Date(listing.apply_probed_at).getTime();
    if (Number.isFinite(ageMs) && ageMs < opts.reprobeAfterHours * 3600000) return { outcome: 'skipped_cooldown' };
  }

  const candidate = (applyDetail && applyDetail.externalApplyUrl) || listing.url_normalized || listing.url || null;
  const hasHintOnly = Boolean(applyDetail && (applyDetail.easyApplyOnly || applyDetail.applyProbe) && !candidate);
  if (!candidate && !hasHintOnly) return { outcome: 'skipped_no_candidate' };

  if (applyDetail && applyDetail.easyApplyOnly && !candidate) {
    await client.query(
      `UPDATE ic_job_listings SET apply_easy_only = true, apply_probed_at = $2, probe_attempts = probe_attempts + 1 WHERE id = $1`,
      [listing.id, opts.now],
    );
    return { outcome: 'resolved' };
  }

  const hint = applyDetail && applyDetail.applyProbe ? JSON.stringify(applyDetail.applyProbe) : null;
  const result = candidate
    ? await resolveApplyTarget(candidate, opts.probeRegistry, { fetch: opts.fetch, lookup: opts.lookup })
    : { resolved: false, reason: 'no_candidate' };

  if (result.resolved) {
    await client.query(
      `UPDATE ic_job_listings SET apply_url = $2, apply_ats = $3, apply_ats_confidence = $4,
         apply_ats_hint = coalesce($5::jsonb, apply_ats_hint), apply_probed_at = $6, probe_attempts = probe_attempts + 1
       WHERE id = $1`,
      [listing.id, result.url, result.ats, result.confidence, hint, opts.now],
    );
    return { outcome: 'resolved' };
  }
  await client.query(
    `UPDATE ic_job_listings SET apply_ats_hint = coalesce($2::jsonb, apply_ats_hint), apply_probed_at = $3, probe_attempts = probe_attempts + 1
     WHERE id = $1`,
    [listing.id, hint, opts.now],
  );
  return { outcome: 'unresolved' };
}
