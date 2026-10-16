// @ts-check
/**
 * Target draft routes (plan 19.6): preflight, edit, approve, discard, regenerate. The draft itself is read
 * through GET /api/targets/:id (routes/targets.js adds a `note` section).
 *
 * Nothing here sends anything. Approve records that Damian copied the note (the browser writes the clipboard;
 * no server code can) and creates one followup reminder. Every POST rides the dashboard's existing guards
 * (checkHost, checkContentType, checkOrigin in server.js) with no route-local exemption; the actor is the
 * literal 'damian' inside the transaction code and a request body cannot set it.
 */
import { DashboardError, sendJson } from '../http.js';
import { DraftError } from '../../targets/draft-errors.js';
import { loadDraftConfig } from '../../targets/draft-context.js';
import { preflightDraft, editDraft, approveDraft, discardDraft, regenerateDraft } from '../draft-approve.js';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  const configDir = () => deps.env?.JOBSEARCH_CONFIG_DIR || undefined;

  /** @param {string} raw @returns {number} */
  function idParam(raw) {
    if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1 || Number(raw) > 2_147_483_647) throw new DashboardError(400, 'INVALID_ID', 'id must be a positive integer');
    return Number(raw);
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DraftError) throw new DashboardError(err.status, err.code, err.message, { details: err.details });
      throw err;
    }
  }

  router.register('GET', '/api/targets/:id/draft/preflight', async (ctx) => {
    const id = idParam(ctx.params.id);
    const raw = ctx.query.draft_id ?? '';
    const draftId = idParam(raw);
    const cfg = loadDraftConfig(configDir());
    const out = await guarded(() => deps.withClient((c) => preflightDraft(c, id, draftId, cfg)));
    sendJson(ctx.res, 200, { ok: true, ...out });
  });

  router.register('POST', '/api/targets/:id/draft/edit', async (ctx) => {
    const id = idParam(ctx.params.id);
    const cfg = loadDraftConfig(configDir());
    const out = await guarded(() => deps.withClient((c) => editDraft(c, id, ctx.body, cfg)));
    sendJson(ctx.res, 200, { ok: true, ...out });
  });

  router.register('POST', '/api/targets/:id/draft/approve', async (ctx) => {
    const id = idParam(ctx.params.id);
    const cfg = loadDraftConfig(configDir());
    const out = await guarded(() => deps.withClient((c) => approveDraft(c, id, ctx.body, cfg, new Date())));
    sendJson(ctx.res, 200, { ok: true, ...out });
  });

  router.register('POST', '/api/targets/:id/draft/discard', async (ctx) => {
    const id = idParam(ctx.params.id);
    const out = await guarded(() => deps.withClient((c) => discardDraft(c, id, ctx.body)));
    sendJson(ctx.res, 200, { ok: true, ...out });
  });

  router.register('POST', '/api/targets/:id/draft/regenerate', async (ctx) => {
    const id = idParam(ctx.params.id);
    const out = await guarded(() => deps.withClient((c) => regenerateDraft(c, id, new Date())));
    sendJson(ctx.res, 200, { ok: true, ...out });
  }, { allowEmptyBody: true });
}
