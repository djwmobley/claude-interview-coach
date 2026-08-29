// @ts-check
/**
 * GET /api/sources -- every distinct, non-null `source` value actually present in ic_job_listings right
 * now (dashboard UX slice 3, Filters modal). This is deliberately NOT the same list as GET /api/profiles'
 * `sources` field (src/dashboard/routes/scans.js): that one is the full set of scan-configured source
 * adapters (greenhouse, lever, ...) regardless of whether any row carries it yet, for the Run scan
 * options drawer. This endpoint is the opposite: exactly what rows already exist with, including sources
 * no adapter currently scans (manually-marked rows, an imported CSV, a one-off `via` value), and never
 * including a configured adapter that has never produced a single row.
 *
 * No record_kind/duplicate_of/expired_at filtering: the Source checkbox group in the Filters modal is
 * meant to let a source be selected regardless of whether today's other filters would currently exclude
 * every row carrying it, same as Status and Noise class already do.
 */
import { sendJson } from '../http.js';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/sources', async (ctx) => {
    const r = await deps.withClient((c) => c.query(
      `SELECT DISTINCT source FROM ic_job_listings WHERE source IS NOT NULL ORDER BY source`,
    ));
    sendJson(ctx.res, 200, { ok: true, sources: r.rows.map((row) => row.source) });
  });
}
