// @ts-check
/**
 * LinkedIn button-only Apply hint capture, integration layer (auto-apply GAP 1,
 * docs/auto-apply-spec.md section 9). The ONE piece of bin/auto-apply.js's prepare phase that actually
 * drives the scan Chrome browser -- everything else in src/core/apply-target-persist.js is URL-only.
 *
 * Uses the EXISTING safe, read-only Capability (goto/readJson, src/browser/capability.js) to navigate and
 * observe the page's own Apply affordance via the existing `linkedinApplyLink` extractor
 * (src/browser/extractors.js, already shipped for the scan-side adapter widening). Only when that reports
 * `buttonOnly: true` with no href does this reach for the raw Playwright page (never
 * src/apply/apply-capability.js's makeApplyCapability -- see src/apply/linkedin-button-probe.js's own doc
 * comment) to perform exactly one click and poll for the outcome.
 *
 * The click itself is billed as one `details` unit against config/adapters.json's `linkedin` entry (spec:
 * "Bill the click as one detail against dailyDetails") via src/core/budget.js's reserveBudget -- if the
 * daily detail budget is already exhausted, the click is never attempted at all (no probe_attempts
 * increment either: this is "no work attempted", not a real probe outcome, mirroring
 * apply-target-persist.js's own skipped_* branches).
 */
import { persistApplyTargetForListing } from '../core/apply-target-persist.js';
import { reserveBudget as defaultReserveBudget } from '../core/budget.js';
import { probeLinkedInButtonApply } from './linkedin-button-probe.js';

/**
 * Adapt a raw Playwright Page (as returned by src/browser/session.js's attachPage) to
 * src/apply/linkedin-button-probe.js's minimal ButtonProbePage/ButtonProbeSession interface. Exported so
 * a caller with a real Page never has to hand-roll this wiring twice.
 * @param {{ url: () => string, click: (selector: string, opts?: any) => Promise<void>, context: () => { pages: () => Array<{ url: () => string, close: () => Promise<void> }> } }} page
 * @returns {{ page: import('./linkedin-button-probe.js').ButtonProbePage, session: import('./linkedin-button-probe.js').ButtonProbeSession }}
 */
export function adaptPlaywrightPage(page) {
  return {
    page: {
      url: async () => page.url(),
      click: async (selector) => page.click(selector, { timeout: 5000 }),
    },
    session: {
      listTargets: async () => page.context().pages().map((p) => ({ id: p, url: p.url() })),
      closeTarget: async (id) => { await /** @type {any} */ (id).close(); },
    },
  };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ id: number, url: string|null, url_normalized: string|null, apply_probed_at: string|Date|null, probe_attempts: number }} listing
 * @param {{
 *   cap: { goto: (url: string) => Promise<any>, readJson: (name: string, arg?: unknown) => Promise<unknown> },
 *   probeSession: { page: import('./linkedin-button-probe.js').ButtonProbePage, session: import('./linkedin-button-probe.js').ButtonProbeSession }|null
 *     null when no browser page is available at all (session unreachable) -- a button-only listing then
 *     falls through to skipped_no_candidate, exactly as if it had no candidate href, never a thrown error.
 *   adapterCfg: { dailyPages: number, dailyDetails: number },
 *   probeRegistry: import('./probe-registry.js').ProbeRegistry,
 *   reprobeAfterHours: number,
 *   now: Date,
 *   dryRun: boolean,
 *   fetch?: typeof fetch,
 *   lookup?: import('../core/urlguard.js').Lookup,
 *   log: (f: Record<string, unknown>) => void,
 *   reserveBudget?: typeof defaultReserveBudget,
 *   probeTimeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {Promise<{ outcome: string }>}
 */
export async function prepareLinkedInListing(client, listing, deps) {
  const url = listing.url_normalized ?? listing.url;
  if (!url) return { outcome: 'skipped_no_candidate' };
  const reserve = deps.reserveBudget ?? defaultReserveBudget;

  /** @type {any} */
  let applyState = null;
  try {
    await deps.cap.goto(url);
    applyState = await deps.cap.readJson('linkedinApplyLink');
  } catch (err) {
    deps.log({ evt: 'linkedin_button_prepare_navigate_failed', listing_id: listing.id, err_message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
    return { outcome: 'skipped_no_candidate' };
  }

  /** @type {import('../core/apply-target-persist.js').ApplyDetail|null} */
  let applyDetail = null;

  if (applyState && typeof applyState.href === 'string' && applyState.href) {
    // An anchor-href posting: never clicked -- the href itself is the candidate (mirrors the scan-side
    // widening's own "anchor decoded, no click" rule).
    applyDetail = { externalApplyUrl: applyState.href };
  } else if (applyState && applyState.buttonOnly && !deps.dryRun) {
    if (!deps.probeSession) {
      deps.log({ evt: 'linkedin_button_probe_no_session', listing_id: listing.id });
      return { outcome: 'skipped_no_candidate' };
    }
    const reserved = await reserve(client, 'linkedin', { details: 1 }, deps.adapterCfg, deps.now);
    if (!reserved.ok) {
      deps.log({ evt: 'linkedin_button_probe_budget_exhausted', listing_id: listing.id });
      return { outcome: 'skipped_no_candidate' };
    }
    const probeResult = await probeLinkedInButtonApply(deps.probeSession.page, deps.probeSession.session, {
      timeoutMs: deps.probeTimeoutMs ?? 15000, sleep: deps.sleep,
    });
    if (probeResult.outcome === 'new_target') applyDetail = { externalApplyUrl: probeResult.url };
    else if (probeResult.outcome === 'hint') applyDetail = { applyProbe: probeResult.hint };
    // 'timeout' -> applyDetail stays null: persistApplyTargetForListing below falls back to the listing's
    // own url_normalized/url as the resolution candidate (never skipped_no_candidate, since that URL is
    // still non-null) and runs it through resolveApplyTarget, which correctly reports 'unresolved' since
    // the raw LinkedIn posting URL is not itself an ATS apply link. The attempt is still recorded
    // (apply_probed_at/probe_attempts), leaving apply_ats null.
  }

  return persistApplyTargetForListing(client, listing, applyDetail, {
    probeRegistry: deps.probeRegistry, reprobeAfterHours: deps.reprobeAfterHours, now: deps.now, dryRun: deps.dryRun, fetch: deps.fetch, lookup: deps.lookup,
  });
}
