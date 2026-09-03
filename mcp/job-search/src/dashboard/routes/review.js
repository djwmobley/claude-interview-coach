// @ts-check
/**
 * Review routes (dashboard PR 2 API table, "Review"). Reuses resolveItem/autoSeparate from
 * src/tools/review.js so merge/separate/repost behave identically to the MCP tool; the dashboard's own
 * value-add is presenting the candidate against its matches with differing fields highlighted, per the
 * plan's "Review" page description.
 */
import { JobSearchError } from '../../core/errors.js';
import { resolveItem, autoSeparate, bulkResolve, REVIEW_BULK_MODES } from '../../tools/review.js';
import { sendJson } from '../http.js';

const DIFF_FIELDS = Object.freeze(['title', 'company', 'location', 'salary_min', 'salary_max', 'posted_at', 'source', 'status']);

/**
 * @param {import('pg').ClientBase} c @param {number|null} id
 * `fit_score` is deliberately NOT in the SELECT list (jobs-unscored-visibility PR, cross-cutting note):
 * the dedup review view compares a candidate against its matches on the DIFF_FIELDS below, and a fit
 * score (a judgment call, unrelated to whether two rows are the same listing) must never bias a human's
 * merge/separate decision. This omission predates review-band fit-only scoring and is unaffected by it
 * -- a review row CAN carry a fit_score now, this view still never shows it here.
 */
async function loadListingBrief(c, id) {
  if (id == null) return null;
  const r = await c.query('SELECT id, title, company, location, salary_min, salary_max, posted_at, source, status, url_normalized, url FROM ic_job_listings WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

/** @param {any} a @param {any} b */
function diffFields(a, b) {
  if (!a || !b) return [];
  return DIFF_FIELDS.filter((f) => String(a[f] ?? '') !== String(b[f] ?? ''));
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  router.register('GET', '/api/review', async (ctx) => {
    const days = deps.config ? deps.config.adapters.dedup.reviewAutoSeparateDays : 30;
    const result = await deps.withClient(async (c) => {
      await c.query('BEGIN');
      let autoN = 0;
      try {
        autoN = await autoSeparate(c, days);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
      const q = await c.query(`SELECT id, candidate_id, matches, reason, created_at, status_at_create FROM ic_job_review_queue WHERE resolved_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 100`);
      /** @type {any[]} */
      const out = [];
      for (const item of q.rows) {
        const candidate = await loadListingBrief(c, item.candidate_id);
        /** @type {any[]} */
        const matches = [];
        for (const mid of item.matches ?? []) {
          const m = await loadListingBrief(c, mid);
          if (m) matches.push({ ...m, differs: diffFields(candidate, m) });
        }
        out.push({ queue_id: item.id, reason: item.reason, created_at: new Date(item.created_at).toISOString(), status_at_create: item.status_at_create, candidate, matches });
      }
      return { rows: out, autoN };
    });
    sendJson(ctx.res, 200, { ok: true, total: result.rows.length, auto_separated: result.autoN, rows: result.rows });
  });

  // Reason filter options for the dashboard bulk bar: the DB universe of currently-open reasons, never
  // derived from whatever page of rows the client already loaded (dashboard UI restraint rule).
  router.register('GET', '/api/review/reasons', async (ctx) => {
    const r = await deps.withClient((c) => c.query(`SELECT DISTINCT reason FROM ic_job_review_queue WHERE resolved_at IS NULL ORDER BY reason`));
    sendJson(ctx.res, 200, { ok: true, reasons: r.rows.map((row) => row.reason) });
  });

  // Bulk-separate (review-bulk spec S3b). dry_run defaults true; a live run (dry_run:false) requires
  // confirm:true, enforced inside bulkResolve() itself -- this route does not duplicate that check, it
  // only shapes/validates the request body before handing off.
  router.register('POST', '/api/review/bulk', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    if (!REVIEW_BULK_MODES.includes(b.mode)) throw new JobSearchError('VALIDATION', `mode must be one of ${REVIEW_BULK_MODES.join(', ')}`);
    const dryRun = Object.prototype.hasOwnProperty.call(b, 'dry_run') ? b.dry_run : true;
    if (typeof dryRun !== 'boolean') throw new JobSearchError('VALIDATION', 'dry_run must be a boolean');
    const confirm = Object.prototype.hasOwnProperty.call(b, 'confirm') ? b.confirm : false;
    if (typeof confirm !== 'boolean') throw new JobSearchError('VALIDATION', 'confirm must be a boolean');
    const out = await bulkResolve(deps, {
      mode: b.mode,
      reason: typeof b.reason === 'string' ? b.reason : undefined,
      dryRun,
      confirm,
      actor: 'dashboard',
    });
    if (!dryRun && out.counts.separate > 0) streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, ...out });
  });

  router.register('POST', '/api/review/:queueId/resolve', async (ctx) => {
    const queueId = Number(ctx.params.queueId);
    if (!Number.isInteger(queueId) || queueId <= 0) throw new JobSearchError('VALIDATION', 'queueId must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    if (!['merge', 'separate', 'repost'].includes(b.resolution)) throw new JobSearchError('VALIDATION', "resolution must be one of 'merge', 'separate', 'repost'");
    const targetId = b.target_id != null ? Number(b.target_id) : null;
    const result = await deps.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const out = await resolveItem(c, { queueId, resolution: b.resolution, targetId, actor: 'dashboard' });
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, ...result });
  });
}
