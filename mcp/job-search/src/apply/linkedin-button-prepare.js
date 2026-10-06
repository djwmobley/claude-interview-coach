// @ts-check
/**
 * LinkedIn apply-state probe, integration layer (auto-apply GAP 1, docs/auto-apply-spec.md section 9; spec
 * v1 F1.3/F1.4, v2 addendum B1/B5/B6/B7/B8/B12). The ONE piece of bin/auto-apply.js's prepare phase that
 * drives the scan Chrome browser -- everything else in src/core/apply-target-persist.js is URL-only.
 *
 * prepareLinkedInListing() loads the job page through the existing safe, read-only Capability (goto/readHtml,
 * src/browser/capability.js), classifies the page with src/apply/linkedin-apply-state.js's pure classifier,
 * and persists FROM THE BRANCH. It clicks only when the branch is 'external' with a button control and no
 * href, and then only that identified control (src/apply/linkedin-button-probe.js re-checks its live name
 * first). It never clicks Easy Apply: the old shared `button.jobs-apply-button` selector, which also matched
 * Easy Apply and opened the dialog, is gone.
 *
 * Persistence by branch (persistLinkedInApplyState below):
 *   easy_apply       apply_easy_only=true; apply_url, apply_ats_hint cleared; apply_ats='linkedin_easy' with
 *                    confidence 'inferred' (never 'exact')                               attempt counted
 *   external         resolveApplyTarget on the href / new-tab URL (or the hint); apply_easy_only=false
 *                                                                                        attempt counted
 *   closed           apply_easy_only=false, expired_at=now (the same column every pool filters on)
 *                                                                                        attempt counted
 *   already_applied  apply_easy_only=false; listing status -> 'applied' when still pre-application (the
 *                    status vocabulary markSubmitted uses, actor 'apply')               attempt counted
 *   no_control       apply_easy_only=false                                               attempt counted
 *   unknown          apply_easy_only=false                                               attempt counted
 *   load_failure     apply_probed_at only (cooldown retry), NO attempt (spec v2 B7)
 *   challenge        nothing on the listing, NO attempt; trips the breaker
 *   auth_wall        nothing on the listing; trips the breaker
 *
 * Breaker (spec v2 B8): challenge and auth_wall trip the EXISTING persisted circuit breaker
 * (src/core/easy-apply-state.js's tripBreaker on ic_easy_apply_breaker, ats 'linkedin_easy', sql/018 + 019)
 * for 24 hours. That one row already blocks every Easy Apply attempt (the morning gate and the worker's start
 * gate read breakerStatus); bin/auto-apply.js's prepare phase and checkLinkedInListingLive below read it too,
 * so it blocks LinkedIn probes as well.
 *
 * Budget: the caller reserves one LinkedIn `details` unit per page load BEFORE calling prepareLinkedInListing
 * (bin/auto-apply.js's runPrepare, spec v1 F2.2 / v2 B9). checkLinkedInListingLive reserves its own.
 */
import { persistApplyTargetForListing, LIFETIME_PROBE_ATTEMPTS } from '../core/apply-target-persist.js';
import { reserveBudget as defaultReserveBudget } from '../core/budget.js';
import { withTransaction } from '../core/db.js';
import { STATUS_GROUPS } from '../core/statuses.js';
import { breakerStatus as defaultBreakerStatus, tripBreaker as defaultTripBreaker } from '../core/easy-apply-state.js';
import { applyMark } from '../tools/mark_jobs.js';
import { connectSession as defaultConnectSession, applyTargetMarkerPath } from '../browser/session.js';
import { makeCapability } from '../browser/capability.js';
import { buildRegistry } from '../core/urlguard.js';
import { errFields } from '../core/errors.js';
import { probeLinkedInButtonApply } from './linkedin-button-probe.js';
import { classifyLinkedInApplyState, observeLinkedInPage } from './linkedin-apply-state.js';

/** Hours a challenge or auth wall trips the LinkedIn breaker for (spec v2 B8). */
export const LINKEDIN_PROBE_BREAKER_HOURS = 24;
/** Branches that stop all LinkedIn probing for the run and trip the breaker. */
export const LIVE_CHECK_HALT_BRANCHES = Object.freeze(['challenge', 'auth_wall', 'breaker']);

/**
 * Adapt a raw Playwright Page (as returned by src/browser/session.js's attachPage) to
 * src/apply/linkedin-button-probe.js's minimal ButtonProbePage/ButtonProbeSession interface.
 * @param {any} page a Playwright Page
 * @returns {{ page: import('./linkedin-button-probe.js').ButtonProbePage, session: import('./linkedin-button-probe.js').ButtonProbeSession }}
 */
export function adaptPlaywrightPage(page) {
  return {
    page: {
      url: async () => page.url(),
      inspect: async (selector) => {
        const loc = page.locator(selector);
        const count = await loc.count();
        if (count < 1) return { count, name: '' };
        const first = loc.first();
        const aria = await first.getAttribute('aria-label');
        const name = aria && aria.trim() ? aria : await first.innerText();
        return { count, name: String(name ?? '') };
      },
      click: async (selector) => { await page.locator(selector).click({ timeout: 5000 }); },
    },
    session: {
      listTargets: async () => page.context().pages().map((/** @type {any} */ p) => ({ id: p, url: p.url() })),
      closeTarget: async (id) => { await /** @type {any} */ (id).close(); },
    },
  };
}

/**
 * Default "mark applied" for already_applied (spec v2 B4): status 'applied' only when the listing is still
 * pre-application (untriaged or the triage group), the same rule markSubmitted uses, so a later status the
 * operator set is never regressed.
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {Date} now
 */
export async function markListingAppliedByHand(client, listingId, now) {
  await withTransaction(client, async (c) => {
    const cur = await c.query('SELECT status FROM ic_job_listings WHERE id = $1 FOR UPDATE', [listingId]);
    if (cur.rowCount === 0) return;
    const status = cur.rows[0].status ?? null;
    if (status !== null && !STATUS_GROUPS.triage.includes(status)) return;
    await applyMark(c, { id: listingId, status: 'applied', statusNote: 'LinkedIn page shows this job was already applied to' }, { now, explicit: true, actor: /** @type {any} */ ('apply') });
  });
}

/**
 * Persist one classified LinkedIn page. Never resolves a target for the listing's own LinkedIn URL.
 * @param {import('pg').ClientBase} client
 * @param {{ id: number, url: string|null, url_normalized: string|null, apply_probed_at: string|Date|null, probe_attempts: number }} listing
 * @param {{ branch: string, reason?: string, applyDetail?: import('../core/apply-target-persist.js').ApplyDetail|null }} state
 * @param {{ now: Date, countAttempt: boolean, resolveExternal: boolean, probeRegistry?: any, reprobeAfterHours?: number, fetch?: typeof fetch, lookup?: any,
 *   tripBreaker?: typeof defaultTripBreaker, markListingApplied?: (c: import('pg').ClientBase, id: number, now: Date) => Promise<void> }} opts
 * @returns {Promise<{ outcome: string, branch: string }>}
 */
export async function persistLinkedInApplyState(client, listing, state, opts) {
  const trip = opts.tripBreaker ?? defaultTripBreaker;
  const branch = state.branch;
  const attempt = opts.countAttempt ? ', apply_probed_at = $2, probe_attempts = probe_attempts + 1' : '';
  /** @param {string} sets */
  const update = (sets) => (opts.countAttempt || /\$2/.test(sets)
    ? client.query(`UPDATE ic_job_listings SET ${sets}${attempt} WHERE id = $1`, [listing.id, opts.now])
    : client.query(`UPDATE ic_job_listings SET ${sets} WHERE id = $1`, [listing.id]));

  switch (branch) {
    case 'challenge':
    case 'auth_wall':
      await trip(client, { reason: `linkedin_probe_${branch}`, applicationId: null, hours: LINKEDIN_PROBE_BREAKER_HOURS, ats: 'linkedin_easy', now: opts.now });
      return { outcome: `halted_${branch}`, branch };
    case 'load_failure':
      if (opts.countAttempt) await client.query('UPDATE ic_job_listings SET apply_probed_at = $2 WHERE id = $1', [listing.id, opts.now]);
      return { outcome: 'skipped_load_failure', branch };
    case 'easy_apply':
      await update(`apply_easy_only = true, apply_url = NULL, apply_ats = 'linkedin_easy', apply_ats_confidence = 'inferred', apply_ats_hint = NULL`);
      return { outcome: 'resolved', branch };
    case 'closed':
      await update('apply_easy_only = false, expired_at = coalesce(expired_at, $2)');
      return { outcome: 'resolved', branch };
    case 'already_applied':
      await update('apply_easy_only = false');
      await (opts.markListingApplied ?? markListingAppliedByHand)(client, listing.id, opts.now);
      return { outcome: 'resolved', branch };
    case 'external':
      if (opts.resolveExternal && state.applyDetail) {
        const r = await persistApplyTargetForListing(client, listing, state.applyDetail, {
          probeRegistry: opts.probeRegistry, reprobeAfterHours: opts.reprobeAfterHours ?? 0, now: opts.now, dryRun: false, fetch: opts.fetch, lookup: opts.lookup,
        });
        if (r.outcome === 'resolved' || r.outcome === 'unresolved') return { outcome: r.outcome, branch };
      }
      await update('apply_easy_only = false');
      return { outcome: opts.countAttempt ? 'unresolved' : 'checked', branch };
    default:
      // no_control, unknown, and anything unrecognized: never Easy Apply.
      await update('apply_easy_only = false');
      return { outcome: 'unresolved', branch: branch === 'no_control' ? 'no_control' : 'unknown' };
  }
}

/**
 * One listing's prepare-phase probe. Never throws for a page problem; the result's `branch` is the
 * classifier branch (after the click outcome is folded in), `outcome` the persistence outcome:
 * resolved | unresolved | skipped_* (no attempt) | halted_challenge | halted_auth_wall.
 * @param {import('pg').ClientBase} client
 * @param {{ id: number, url: string|null, url_normalized: string|null, apply_probed_at: string|Date|null, probe_attempts: number }} listing
 * @param {{
 *   cap: { goto: (url: string) => Promise<any>, readHtml: () => Promise<string> },
 *   probeSession: { page: import('./linkedin-button-probe.js').ButtonProbePage, session: import('./linkedin-button-probe.js').ButtonProbeSession }|null,
 *   probeRegistry: import('./probe-registry.js').ProbeRegistry,
 *   reprobeAfterHours: number,
 *   now: Date,
 *   dryRun: boolean,
 *   fetch?: typeof fetch,
 *   lookup?: import('../core/urlguard.js').Lookup,
 *   log: (f: Record<string, unknown>) => void,
 *   probeTimeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   tripBreaker?: typeof defaultTripBreaker,
 *   markListingApplied?: (c: import('pg').ClientBase, id: number, now: Date) => Promise<void>,
 * }} deps
 * @returns {Promise<{ outcome: string, branch: string|null, reason?: string }>}
 */
export async function prepareLinkedInListing(client, listing, deps) {
  const url = listing.url_normalized ?? listing.url;
  if (!url) return { outcome: 'skipped_no_candidate', branch: null };
  if (deps.dryRun) return { outcome: 'skipped_dry_run', branch: null };
  if ((listing.probe_attempts ?? 0) >= LIFETIME_PROBE_ATTEMPTS) return { outcome: 'skipped_lifetime_cap', branch: null };
  if (listing.apply_probed_at) {
    const ageMs = deps.now.getTime() - new Date(listing.apply_probed_at).getTime();
    if (Number.isFinite(ageMs) && ageMs < deps.reprobeAfterHours * 3600000) return { outcome: 'skipped_cooldown', branch: null };
  }

  const obs = await observeLinkedInPage(deps.cap, deps.probeSession ? deps.probeSession.page : null, url);
  const verdict = classifyLinkedInApplyState(obs);
  let branch = /** @type {string} */ (verdict.branch);
  let reason = verdict.reason;
  /** @type {import('../core/apply-target-persist.js').ApplyDetail|null} */
  let applyDetail = null;

  if (branch === 'external' && verdict.control) {
    if (verdict.control.href) {
      applyDetail = { externalApplyUrl: verdict.control.href };
    } else if (!deps.probeSession) {
      branch = 'unknown';
      reason = 'external_button_no_probe_session';
    } else {
      const probe = await probeLinkedInButtonApply(deps.probeSession.page, deps.probeSession.session, {
        control: { path: verdict.control.path, name: verdict.control.name }, timeoutMs: deps.probeTimeoutMs ?? 15000, sleep: deps.sleep,
      });
      if (probe.outcome === 'new_target') applyDetail = { externalApplyUrl: probe.url };
      else if (probe.outcome === 'hint') applyDetail = { applyProbe: probe.hint };
      else {
        branch = 'unknown';
        reason = probe.outcome === 'aborted' ? `click_aborted_${probe.reason}` : `click_${probe.outcome}`;
      }
    }
  }
  deps.log({ evt: 'linkedin_apply_state', listing_id: listing.id, branch, reason });

  const persisted = await persistLinkedInApplyState(client, listing, { branch, reason, applyDetail }, {
    now: deps.now, countAttempt: true, resolveExternal: true, probeRegistry: deps.probeRegistry, reprobeAfterHours: deps.reprobeAfterHours,
    fetch: deps.fetch, lookup: deps.lookup, tripBreaker: deps.tripBreaker, markListingApplied: deps.markListingApplied,
  });
  return { ...persisted, reason };
}

/**
 * The live page-state check run right before an Easy Apply application is created or its worker runs
 * (spec v1 F1.4, v2 B1), and by the dashboard's create routes. Reads the breaker, reserves one LinkedIn
 * detail, loads and classifies the page, and persists what it learned WITHOUT counting a probe attempt
 * (this is a verification, not a prepare-phase probe). Never clicks. Returns one of the classifier
 * branches, or a gate: 'breaker' (tripped, no page load) | 'budget_exhausted' (no page load) |
 * 'no_url'.
 * @param {import('pg').ClientBase} client
 * @param {{ id: number, url: string|null, url_normalized: string|null, apply_probed_at?: string|Date|null, probe_attempts?: number }} listing
 * @param {{
 *   cap: { goto: (url: string) => Promise<any>, readHtml: () => Promise<string> },
 *   page: { url: () => Promise<string> }|null,
 *   adapterCfg: { dailyPages: number, dailyDetails: number },
 *   now: Date,
 *   log: (f: Record<string, unknown>) => void,
 *   breakerStatus?: (c: import('pg').ClientBase, now?: Date) => Promise<{ tripped: boolean }>,
 *   reserveBudget?: typeof defaultReserveBudget,
 *   tripBreaker?: typeof defaultTripBreaker,
 *   markListingApplied?: (c: import('pg').ClientBase, id: number, now: Date) => Promise<void>,
 * }} deps
 * @returns {Promise<{ branch: string, reason: string }>}
 */
export async function checkLinkedInListingLive(client, listing, deps) {
  const url = listing.url_normalized ?? listing.url;
  if (!url) return { branch: 'no_url', reason: 'listing_has_no_url' };
  const breaker = await (deps.breakerStatus ?? defaultBreakerStatus)(client, deps.now);
  if (breaker.tripped) return { branch: 'breaker', reason: 'linkedin_breaker_tripped' };
  const reserved = await (deps.reserveBudget ?? defaultReserveBudget)(client, 'linkedin', { details: 1 }, deps.adapterCfg, deps.now);
  if (!reserved.ok) return { branch: 'budget_exhausted', reason: 'linkedin_daily_details_exhausted' };
  const verdict = classifyLinkedInApplyState(await observeLinkedInPage(deps.cap, deps.page, url));
  deps.log({ evt: 'linkedin_apply_live_check', listing_id: listing.id, branch: verdict.branch, reason: verdict.reason });
  const full = { apply_probed_at: null, probe_attempts: 0, ...listing };
  await persistLinkedInApplyState(client, full, { branch: verdict.branch, reason: verdict.reason }, {
    now: deps.now, countAttempt: false, resolveExternal: false, tripBreaker: deps.tripBreaker, markListingApplied: deps.markListingApplied,
  });
  return { branch: verdict.branch, reason: verdict.reason };
}

/**
 * Best-effort scan-Chrome page for LinkedIn probes: connects, reconciles the shared apply-target marker,
 * attaches ONE page scoped to the 'linkedin' scan source, and returns the read-only Capability plus the
 * raw-page probe adapter. Returns null on ANY failure (logged), never throws.
 *
 * `reconcile` (default true) closes stale pages from earlier runs (the apply-target marker and the scan's
 * own page marker). Only the prepare phase, which holds the shared advisory lock, may do that: the live
 * check (createLinkedInLiveCheck) runs WITHOUT the lock, so it passes false and never closes another
 * process's live page (a running apply worker records its page in the same marker file).
 * @param {typeof defaultConnectSession} connectSession
 * @param {import('../core/config.js').Env} env
 * @param {import('../core/config.js').LoadedConfig} config
 * @param {(f: any) => void} log
 * @param {{ reconcile?: boolean }} [opts]
 * @returns {Promise<{ cap: any, probeSession: any, close: () => Promise<void> } | null>}
 */
export async function openLinkedInProbeBrowser(connectSession, env, config, log, opts = {}) {
  try {
    const session = await connectSession({ cdpUrl: env.SCAN_CDP_URL });
    try {
      if (opts.reconcile !== false) {
        await session.reconcileTargets(applyTargetMarkerPath(env.JOBSEARCH_LOG_DIR));
        await session.reconcile();
      }
      const signal = new AbortController().signal;
      const page = await session.attachPage({ signal });
      const cap = makeCapability(page, { registry: buildRegistry(config), source: 'linkedin', signal });
      const { page: probePage, session: probeSessionAdapter } = adaptPlaywrightPage(page);
      return {
        cap, probeSession: { page: probePage, session: probeSessionAdapter },
        close: async () => { await session.closeAll().catch(() => {}); },
      };
    } catch (err) {
      await session.closeAll().catch(() => {});
      throw err;
    }
  } catch (err) {
    log({ evt: 'linkedin_probe_session_unavailable', ...errFields(err) });
    return null;
  }
}

/**
 * Production wiring for checkLinkedInListingLive: (listingId) => branch. Loads the listing row, opens a
 * scan-Chrome page for the one check, and always closes it. 'no_browser' when the session is unreachable,
 * 'not_found' for a missing listing.
 * @param {{ env: import('../core/config.js').Env, config: import('../core/config.js').LoadedConfig, log: (f: any) => void,
 *   withClient: <T>(fn: (c: import('pg').PoolClient) => Promise<T>) => Promise<T>, connectSession?: typeof defaultConnectSession }} o
 * @returns {(listingId: number) => Promise<{ branch: string, reason: string }>}
 */
export function createLinkedInLiveCheck(o) {
  return async (listingId) => {
    const r = await o.withClient((c) => c.query('SELECT id, url, url_normalized, apply_probed_at, probe_attempts FROM ic_job_listings WHERE id = $1', [listingId]));
    if (r.rowCount === 0) return { branch: 'not_found', reason: 'listing_not_found' };
    const listing = r.rows[0];
    const browser = await openLinkedInProbeBrowser(o.connectSession ?? defaultConnectSession, o.env, o.config, o.log, { reconcile: false });
    if (!browser) return { branch: 'no_browser', reason: 'scan_chrome_unreachable' };
    try {
      const li = o.config.adapters.adapters.linkedin;
      return await o.withClient((c) => checkLinkedInListingLive(c, { ...listing, id: Number(listing.id) }, {
        cap: browser.cap, page: browser.probeSession.page, now: new Date(), log: o.log,
        adapterCfg: { dailyPages: li?.dailyPages ?? 0, dailyDetails: li?.dailyDetails ?? 0 },
      }));
    } finally {
      await browser.close();
    }
  };
}
