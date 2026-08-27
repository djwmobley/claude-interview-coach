// @ts-check
/**
 * Analytics route (dashboard PR 2 API table, "Analytics"). Plain SQL over ic_job_listings, ic_job_events,
 * and ic_followups; no new tables. `weeks` is clamped to 1-52 so a careless query string never triggers
 * an unbounded scan.
 */
import { sendJson } from '../http.js';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/analytics', async (ctx) => {
    const weeks = Math.max(1, Math.min(52, Number(ctx.query.weeks) || 8));
    const timezone = deps.config?.adapters.run.timezone ?? 'America/Chicago';

    const data = await deps.withClient(async (c) => {
      const newBySource = await c.query(
        `SELECT date_trunc('week', first_seen)::date AS week, source, count(*)::int AS n
         FROM ic_job_listings
         WHERE coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
           AND first_seen >= now() - ($1::int * interval '1 week')
         GROUP BY week, source ORDER BY week ASC`,
        [weeks],
      );
      const lookAtTheseByDay = await c.query(
        `SELECT date_trunc('day', first_seen)::date AS day, count(*)::int AS n
         FROM ic_job_listings
         WHERE coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL AND noise_class IN ('ok', 'ok_manual')
           AND first_seen >= now() - ($1::int * interval '1 week')
         GROUP BY day ORDER BY day ASC`,
        [weeks],
      );
      const funnel = await c.query(
        `SELECT to_status, count(*)::int AS n FROM ic_job_events
         WHERE kind = 'status' AND to_status IS NOT NULL AND at >= now() - ($1::int * interval '1 week')
         GROUP BY to_status`,
        [weeks],
      );
      const followupCompletion = await c.query(
        `SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*)::int AS total
         FROM ic_followups WHERE created_at >= now() - ($1::int * interval '1 week')`,
        [weeks],
      );
      const replyCount = await c.query(
        `SELECT count(DISTINCT listing_id)::int AS n FROM ic_job_events WHERE kind = 'reply' AND at >= now() - ($1::int * interval '1 week')`,
        [weeks],
      );
      const appliedCount = await c.query(
        `SELECT count(DISTINCT listing_id)::int AS n FROM ic_job_events WHERE kind = 'status' AND to_status = 'applied' AND at >= now() - ($1::int * interval '1 week')`,
        [weeks],
      );
      const medianStage = await c.query(
        `SELECT to_status, percentile_cont(0.5) WITHIN GROUP (ORDER BY days) AS median_days
         FROM (
           SELECT listing_id, to_status, at,
                  EXTRACT(EPOCH FROM (lead(at) OVER (PARTITION BY listing_id ORDER BY at) - at)) / 86400.0 AS days
           FROM ic_job_events WHERE kind = 'status'
         ) x
         WHERE days IS NOT NULL
         GROUP BY to_status`,
      );
      return {
        newBySource: newBySource.rows,
        lookAtTheseByDay: lookAtTheseByDay.rows,
        funnel: funnel.rows,
        followupCompletion: followupCompletion.rows[0],
        replyCount: replyCount.rows[0].n,
        appliedCount: appliedCount.rows[0].n,
        medianStage: medianStage.rows,
      };
    });

    const responseRate = data.appliedCount > 0 ? data.replyCount / data.appliedCount : null;
    sendJson(ctx.res, 200, {
      ok: true,
      weeks,
      timezone,
      new_by_source: data.newBySource.map((r) => ({ week: r.week, source: r.source, count: r.n })),
      look_at_these_by_day: data.lookAtTheseByDay.map((r) => ({ day: r.day, count: r.n })),
      funnel: data.funnel.map((r) => ({ status: r.to_status, count: r.n })),
      followups: {
        done: data.followupCompletion.done,
        total: data.followupCompletion.total,
        completion_rate: data.followupCompletion.total ? data.followupCompletion.done / data.followupCompletion.total : null,
      },
      response_rate: responseRate,
      response_rate_note: data.appliedCount === 0 ? 'no reply events yet' : null,
      median_days_per_stage: data.medianStage.map((r) => ({ status: r.to_status, median_days: r.median_days !== null ? Number(r.median_days) : null })),
    });
  });
}
