// @ts-check
/**
 * Personal mail intake routes (sql/029) and the per-capability Google banner.
 *
 *   GET  /api/mail-intake                 open recruiter_like and thread_reply review items (one per Gmail thread),
 *                                         the subject-level unsorted list (dashboard only; the emailed report carries
 *                                         counts and top senders), and 14-day counts per bucket
 *   POST /api/mail-intake/:id/dismiss     dismiss a message and the rest of its thread (no Gmail write, ledger only)
 *   GET  /api/google/capabilities         { line, broken, capabilities } for the red banner on Home; the
 *                                         Re-authorize Google button reuses POST /api/google/reauth
 *
 * Every string sent to the browser is plain text; the page renders it with textContent only. Nothing here
 * writes to Gmail, replies, or applies to anything.
 */
import { JobSearchError } from '../../core/errors.js';
import { sendJson } from '../http.js';
import { listMailIntakeForDashboard, dismissMailIntake } from '../../core/mail-intake-store.js';
import { gmailMessageUrl, gmailTab } from '../../core/mail-intake.js';
import { collectGoogleCapability, capabilityBannerLine } from '../../core/google-capability.js';

/** @param {any} v */
function decorate(v) {
  return { ...v, tab: gmailTab(v.labels), link: gmailMessageUrl(v.message_id) };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  router.register('GET', '/api/mail-intake', async (ctx) => {
    const data = await deps.withClient((c) => listMailIntakeForDashboard(c));
    sendJson(ctx.res, 200, {
      ok: true,
      items: data.items.map(decorate),
      items_total: data.items_total,
      unsorted: data.unsorted.map(decorate),
      counts: data.counts,
    });
  });

  router.register('POST', '/api/mail-intake/:id/dismiss', async (ctx) => {
    const id = String(ctx.params.id ?? '');
    if (!/^[0-9a-f]{8,32}$/.test(id)) throw new JobSearchError('VALIDATION', 'id must be a Gmail message id');
    const n = await deps.withClient((c) => dismissMailIntake(c, id));
    streamHub?.notifyChanged('review');
    sendJson(ctx.res, 200, { ok: true, dismissed: n });
  }, { allowEmptyBody: true });

  router.register('GET', '/api/google/capabilities', async (ctx) => {
    const rows = await deps.withClient((c) => collectGoogleCapability(c));
    const line = capabilityBannerLine(rows, new Date());
    sendJson(ctx.res, 200, { ok: true, line, broken: line !== null, capabilities: rows });
  });
}
