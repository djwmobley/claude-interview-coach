// @ts-check
/**
 * Application routes (apply pipeline slice 3, plan `let-s-brainstorm-a-bit-humble-umbrella.md` section
 * "7. Dashboard human gate" -- reduced scope for this slice: creation and Approve only. The runner and
 * the needs_human/failed actions (screenshot, answer box, Retry) are slice 5+; this file's Approve route
 * only records state and hashes, exactly as the PR slice list says ("Approve only records state for now").
 */
import { JobSearchError } from '../../core/errors.js';
import { createApplication, approve, getApplication, getApplicationForListing } from '../../core/applications.js';
import { classifyApplyUrl } from '../../apply/ats-detect.js';
import { sendJson } from '../http.js';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  router.register('POST', '/api/listings/:id/application', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const listingRes = await deps.withClient((c) => c.query('SELECT id, url, url_normalized FROM ic_job_listings WHERE id = $1', [id]));
    if (listingRes.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${id} not found`);
    const listing = listingRes.rows[0];
    const applyUrl = listing.url_normalized ?? listing.url ?? null;
    const classification = classifyApplyUrl(applyUrl);
    // Apply pipeline slice 3, orchestrator decision (plan section 2 / PR slice list item 3): an unknown
    // ATS does NOT route the new application to needs_human at creation. Documents still have to be
    // drafted (an interactive Claude Code session, not the automated runner) regardless of ATS
    // confidence, and needs_human is the slice 5 runner's own manual-apply routing decision at submit
    // time -- a document-drafting step has no business preempting it. An unknown-ATS application is
    // created in 'drafting' exactly like any other; the dashboard card shows a muted "unknown ATS: apply
    // by hand after approving documents" note instead (components/application-card.js).
    let app;
    try {
      app = await deps.withClient((c) => createApplication(c, {
        listingId: id, atsType: classification.ats, applyUrl, actor: 'dashboard',
      }));
    } catch (err) {
      // createApplication throws a clean VALIDATION error (never a raw pg unique-violation) for a
      // second active application on the same listing, with details.listing_id set (src/core/
      // applications.js). Translated to 409 DUPLICATE_APPLICATION here, the same pattern POST
      // /api/listings already uses for DUPLICATE_CANDIDATE: a distinct, UI-recognizable code rather than
      // the generic 400 VALIDATION every other malformed request gets.
      if (err instanceof JobSearchError && err.code === 'VALIDATION' && err.details && err.details.listing_id !== undefined) {
        return sendJson(ctx.res, 409, { ok: false, code: 'DUPLICATE_APPLICATION', message: err.message });
      }
      throw err;
    }
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 201, { ok: true, row: app, ats: classification });
  }, { allowEmptyBody: true });

  router.register('GET', '/api/applications/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => getApplication(c, id));
    sendJson(ctx.res, 200, { ok: true, row });
  });

  router.register('GET', '/api/listings/:id/application', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => getApplicationForListing(c, id));
    sendJson(ctx.res, 200, { ok: true, row });
  });

  router.register('POST', '/api/applications/:id/approve', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => approve(c, id, { outputRoot: deps.outputRoot, actor: 'dashboard' }));
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, row });
  }, { allowEmptyBody: true });
}
