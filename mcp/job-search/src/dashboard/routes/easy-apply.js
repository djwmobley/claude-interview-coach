// @ts-check
/**
 * Dashboard routes for assisted LinkedIn Easy Apply (spec B6). An application parked at needs_human kind
 * 'awaiting_submit' has a filled Easy Apply form open on LinkedIn's Review screen in the scan Chrome; these
 * routes are Damian's controls for it. None of them clicks anything on the page.
 *
 *   GET  /api/easy-apply/status                         breaker state + awaiting_submit applications
 *   POST /api/applications/:id/focus-tab                Target.activateTarget on the stored tab; a tab that
 *                                                       no longer exists demotes the card to abandoned_tab
 *   POST /api/applications/:id/easy-apply/submitted     "I submitted": reads LinkedIn's Applied badge in
 *                                                       that tab (read-only). Badge present -> submitted
 *                                                       (markAppliedByHand). Absent or unknown -> stays
 *                                                       needs_human with a message; body
 *                                                       { confirm_anyway: true } is Damian's explicit
 *                                                       override and marks it submitted.
 *   POST /api/applications/:id/easy-apply/abandon       withdraws the application and closes its tab
 *
 * Assisted-apply rename (spec v2 A14): each /easy-apply/ route is also registered at the same path with
 * /assisted-apply/ (same handler). The /easy-apply/ paths stay as aliases for one release; the dashboard
 * client still calls them.
 */
import { JobSearchError } from '../../core/errors.js';
import { getApplication, markAppliedByHand, transition, recordApplicationEvent } from '../../core/applications.js';
import { breakerStatus, listAwaitingTargets, demoteAbandonedTabs, AWAITING_SUBMIT_KIND } from '../../core/easy-apply-state.js';
import { connectCdp } from '../../browser/cdp-target.js';
import { createAssistedDriver } from '../../apply/easy-apply-driver.js';
import { profileForAts } from '../../apply/assisted/profiles/index.js';
import { sendJson } from '../http.js';

/** The ATS breakers the status route reports. */
const ASSISTED_BREAKER_KEYS = Object.freeze(['linkedin_easy', 'workday']);

/**
 * @param {any} deps
 */
function tabDeps(deps) {
  const seam = deps.easyApplyTab ?? {};
  return {
    connect: seam.connect ?? (() => connectCdp({ cdpHttpUrl: deps.env.SCAN_CDP_URL, timeoutMs: 10000 })),
    // Clause 10: "I submitted" reads the application's OWN profile's applied evidence (read-only).
    createDriver: seam.createDriver ?? ((/** @type {any} */ cdp, /** @type {string} */ targetId, /** @type {any} */ profile) => createAssistedDriver({ cdp, targetId, pacing: false, profile })),
  };
}

/** @param {unknown} raw */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
  return id;
}

/**
 * @param {any} deps
 * @param {number} id
 * @returns {Promise<{ app: any, targetId: string } | null>}
 */
async function loadAwaiting(deps, id) {
  const app = await deps.withClient((/** @type {any} */ c) => getApplication(c, id));
  const pq = app.pending_question;
  if (app.state !== 'needs_human' || !pq || pq.kind !== AWAITING_SUBMIT_KIND || typeof pq.target_id !== 'string' || !pq.target_id) return null;
  return { app, targetId: pq.target_id };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {any} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  const notify = () => streamHub?.notifyChanged('events');
  /**
   * Register a route and, when its path has an /easy-apply/ segment, the same handler at /assisted-apply/.
   * @param {string} method @param {string} routePath @param {any} handler
   */
  const registerWithAlias = (method, routePath, handler) => {
    router.register(method, routePath, handler);
    const renamed = routePath.replace('/easy-apply/', '/assisted-apply/');
    if (renamed !== routePath) router.register(method, renamed, handler);
  };

  registerWithAlias('GET', '/api/easy-apply/status', async (ctx) => {
    const out = await deps.withClient(async (/** @type {any} */ c) => {
      /** @type {Record<string, any>} */
      const breakers = {};
      for (const k of ASSISTED_BREAKER_KEYS) breakers[k] = await breakerStatus(c, new Date(), k);
      return { breakers, awaiting: await listAwaitingTargets(c) };
    });
    const shape = (/** @type {any} */ b) => ({ tripped: b.tripped, until: b.until ? b.until.toISOString() : null, reason: b.reason });
    sendJson(ctx.res, 200, {
      ok: true,
      // `breaker` stays LinkedIn's (the card client reads it); `breakers` has every assisted ATS.
      breaker: shape(out.breakers.linkedin_easy),
      breakers: Object.fromEntries(Object.entries(out.breakers).map(([k, b]) => [k, shape(b)])),
      awaiting: out.awaiting.map((/** @type {any} */ a) => ({ application_id: a.applicationId, ats: a.ats })),
    });
  });

  router.register('POST', '/api/applications/:id/focus-tab', async (ctx) => {
    const id = parseId(ctx.params.id);
    const found = await loadAwaiting(deps, id);
    if (!found) return sendJson(ctx.res, 409, { ok: false, code: 'NOT_AWAITING_SUBMIT', message: `application ${id} is not waiting on an Easy Apply Review tab` });
    const t = tabDeps(deps);
    const cdp = await t.connect();
    try {
      const live = new Set((await cdp.listPageTargets()).map((x) => x.targetId));
      if (!live.has(found.targetId)) {
        await deps.withClient((/** @type {any} */ c) => demoteAbandonedTabs(c, { aliveTargetIds: live, reason: 'tab_missing_on_focus' }));
        notify();
        return sendJson(ctx.res, 409, { ok: false, code: 'TAB_GONE', message: 'That LinkedIn tab is gone; the card now shows it as abandoned.' });
      }
      await cdp.send('Target.activateTarget', { targetId: found.targetId });
    } finally {
      cdp.close();
    }
    sendJson(ctx.res, 200, { ok: true });
  }, { allowEmptyBody: true });

  registerWithAlias('POST', '/api/applications/:id/easy-apply/submitted', async (ctx) => {
    const id = parseId(ctx.params.id);
    const body = /** @type {any} */ (ctx.body) ?? {};
    const found = await loadAwaiting(deps, id);
    if (!found) return sendJson(ctx.res, 409, { ok: false, code: 'NOT_AWAITING_SUBMIT', message: `application ${id} is not waiting on an Easy Apply Review tab` });
    if (body.confirm_anyway === true) {
      const row = await deps.withClient((/** @type {any} */ c) => markAppliedByHand(c, id, { actor: 'dashboard', note: 'Easy Apply: Damian confirmed he submitted (Applied badge not verified)' }));
      notify();
      return sendJson(ctx.res, 200, { ok: true, outcome: 'submitted', verified_badge: false, row });
    }
    const t = tabDeps(deps);
    const profile = profileForAts(found.app.ats_type);
    const site = profile ? String(profile.label) : 'The site';
    /** @type {{ state: string, evidence: string|null }} */
    let badge = { state: 'unknown', evidence: null };
    let cdp = null;
    try {
      if (!profile) throw new Error('no assisted profile for this application');
      cdp = await t.connect();
      const live = new Set((await cdp.listPageTargets()).map((x) => x.targetId));
      if (live.has(found.targetId)) {
        const driver = t.createDriver(cdp, found.targetId, profile);
        await driver.attach();
        try {
          badge = await driver.appliedBadge();
        } finally {
          await driver.detach();
        }
      }
    } catch {
      badge = { state: 'unknown', evidence: null };
    } finally {
      cdp?.close();
    }
    if (badge.state === 'applied') {
      const row = await deps.withClient((/** @type {any} */ c) => markAppliedByHand(c, id, { actor: 'dashboard', note: `${site}: Damian submitted; the page shows "${String(badge.evidence ?? 'Applied').slice(0, 80)}"` }));
      notify();
      return sendJson(ctx.res, 200, { ok: true, outcome: 'submitted', verified_badge: true, row });
    }
    const message = badge.state === 'unknown'
      ? `Could not read the ${site} tab to confirm an Applied badge or submitted confirmation. If you did submit, confirm anyway.`
      : `${site} does not show an Applied badge or submitted confirmation in that tab yet. Submit there first, or confirm anyway if you already did.`;
    await deps.withClient(async (/** @type {any} */ c) => {
      await c.query(
        `UPDATE ic_job_applications SET pending_question = pending_question || jsonb_build_object('last_check', jsonb_build_object('at', now(), 'result', $2::text, 'message', $3::text)), updated_at = now()
          WHERE id = $1 AND state = 'needs_human' AND pending_question->>'kind' = '${AWAITING_SUBMIT_KIND}'`,
        [id, badge.state, message],
      );
      await recordApplicationEvent(c, { applicationId: id, kind: 'note', actor: 'dashboard', note: `Easy Apply "I submitted" check: ${badge.state}` });
    });
    notify();
    sendJson(ctx.res, 200, { ok: false, outcome: 'badge_not_found', badge: badge.state, message, confirm_anyway_available: true });
  }, { allowEmptyBody: true });

  registerWithAlias('POST', '/api/applications/:id/easy-apply/abandon', async (ctx) => {
    const id = parseId(ctx.params.id);
    const found = await loadAwaiting(deps, id);
    if (!found) return sendJson(ctx.res, 409, { ok: false, code: 'NOT_AWAITING_SUBMIT', message: `application ${id} is not waiting on an Easy Apply Review tab` });
    const row = await deps.withClient((/** @type {any} */ c) => transition(c, id, 'withdrawn', { actor: 'dashboard', note: 'Easy Apply abandoned from the dashboard' }));
    try {
      const cdp = await tabDeps(deps).connect();
      try {
        await cdp.send('Target.closeTarget', { targetId: found.targetId });
      } finally {
        cdp.close();
      }
    } catch {
      /* the tab may already be gone; the application is withdrawn either way */
    }
    notify();
    sendJson(ctx.res, 200, { ok: true, row });
  }, { allowEmptyBody: true });
}
