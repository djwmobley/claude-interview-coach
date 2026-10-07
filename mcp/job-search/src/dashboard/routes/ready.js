// @ts-check
/**
 * Dashboard routes for the Ready to apply list (spec section 10, R4, R6, R8, A1, A10).
 *
 *   GET  /api/ready-to-apply                       the list, classified live (memoized 30 s). Viewing it is
 *                                                  a DISPLAY (A1): the ledger is refreshed and every listed
 *                                                  row that never had a manual-only lock gets one.
 *   POST /api/ready-to-apply/:listingId/resume     start a listing-mode resume now (202). Refusals are 409
 *                                                  with a code: READY_RESUME_BUSY (the shared spawn lock is
 *                                                  held), READY_RESUME_CAP (the daily cap, hard ceiling 10,
 *                                                  no override; the request body is ignored), and
 *                                                  READY_RESUME_NOT_ELIGIBLE.
 *   POST /api/ready-to-apply/:listingId/hand-back  Damian's explicit hand back of a manual-only lock (R8),
 *                                                  logged as a listing event.
 *
 * "I applied" and "Dismiss" deliberately reuse POST /api/listings/:id/status (applied / passed), so this
 * file never changes a listing's status itself.
 */
import { JobSearchError } from '../../core/errors.js';
import { sendJson } from '../http.js';
import { classifyReadyList, refreshReadyLedger, readyConfig } from '../../core/ready-to-apply.js';
import { readyView } from '../../core/report-ready.js';
import { startReadyResumeForListing } from '../../core/ready-resumes.js';
import { handBackManualLock } from '../../core/manual-lock.js';
import { withTransaction } from '../../core/db.js';
import { log as defaultLog } from '../../core/logger.js';

/** Memo window for GET (spec section 5: live per request, memoized 30 s). */
export const READY_MEMO_MS = 30000;

/** @param {unknown} raw */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'listingId must be a positive integer');
  return id;
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {any} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  /** @type {{ at: number, body: any }|null} */
  let memo = null;
  const invalidate = () => { memo = null; };
  const notify = () => streamHub?.notifyChanged('events');
  const log = deps.log ?? ((/** @type {any} */ f) => defaultLog.info(f));

  router.register('GET', '/api/ready-to-apply', async (ctx) => {
    if (!deps.config) throw new JobSearchError('VALIDATION', 'config could not be loaded; the Ready list is unavailable');
    if (!readyConfig(deps.config).enabled) return sendJson(ctx.res, 200, { ok: true, enabled: false });
    const nowMs = Date.now();
    if (memo && nowMs - memo.at < READY_MEMO_MS) return sendJson(ctx.res, 200, memo.body);
    const now = new Date(nowMs);
    const body = await deps.withClient(async (/** @type {any} */ c) => {
      const res = await classifyReadyList(c, { config: deps.config, now });
      await refreshReadyLedger(c, res, now, { display: true });
      return { ok: true, ...readyView(res, { now, dashboardUrl: null }) };
    });
    memo = { at: nowMs, body };
    sendJson(ctx.res, 200, body);
  });

  // The rail badge. Reads the ledger only (the last classification), so polling it is NOT a display and
  // never writes a lock: only opening the list (or the report send) does.
  router.register('GET', '/api/ready-to-apply/count', async (ctx) => {
    const r = await deps.withClient((/** @type {any} */ c) => c.query(`SELECT count(*)::int AS n FROM ic_ready_to_apply WHERE bucket = 'ready_to_apply' AND left_at IS NULL`));
    sendJson(ctx.res, 200, { ok: true, ready: Number(r.rows[0].n) });
  });

  router.register('POST', '/api/ready-to-apply/:listingId/resume', async (ctx) => {
    const listingId = parseId(ctx.params.listingId);
    if (!deps.readyResumeRunner || !deps.resumeSpawnLock) throw new JobSearchError('VALIDATION', 'resume generation is not wired in this dashboard process');
    const r = await startReadyResumeForListing({
      withClient: deps.withClient, config: deps.config, now: () => new Date(), log, runner: deps.readyResumeRunner,
      spawnLock: deps.resumeSpawnLock, outputRoot: deps.outputRoot,
    }, listingId);
    if (r.status !== 202) return sendJson(ctx.res, r.status, { ok: false, error: { code: r.code, message: r.message } });
    invalidate();
    r.done.then(() => { invalidate(); notify(); }, () => { invalidate(); notify(); });
    notify();
    sendJson(ctx.res, 202, { ok: true, started: true, listingId });
  }, { allowEmptyBody: true });

  router.register('POST', '/api/ready-to-apply/:listingId/hand-back', async (ctx) => {
    const listingId = parseId(ctx.params.listingId);
    const out = await deps.withClient((/** @type {any} */ c) => withTransaction(c, (tx) => handBackManualLock(tx, listingId, { actor: 'dashboard', now: new Date() })));
    if (!out.found) throw new JobSearchError('NOT_FOUND', `listing ${listingId} not found`);
    invalidate();
    notify();
    sendJson(ctx.res, 200, { ok: true, listingId, released: out.released });
  }, { allowEmptyBody: true });
}
