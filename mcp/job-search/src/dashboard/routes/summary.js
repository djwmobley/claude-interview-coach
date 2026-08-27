// @ts-check
/**
 * GET /api/summary (dashboard PR 2 API table, "Health/summary"). Pipeline counts by status and group
 * (including untriaged), follow-up buckets, last/live run, open review count, today's budget, disabled
 * sources, next scheduled scan, and the last 50 cross-listing events.
 */
import { sendJson } from '../http.js';
import { recentEvents } from '../../core/events.js';
import { groupOf, STATUS_GROUPS } from '../../core/statuses.js';
import { nextScheduledScan } from '../next-scheduled-scan.js';

/** @param {any} r */
function formatRun(r) {
  return {
    run_id: Number(r.id),
    status: r.status,
    trigger: r.trigger,
    started_at: new Date(r.started_at).toISOString(),
    finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    heartbeat_at: r.heartbeat_at ? new Date(r.heartbeat_at).toISOString() : null,
    stats: r.stats ?? {},
  };
}

/** @param {any} e */
function formatEvent(e) {
  return {
    id: Number(e.id),
    listing_id: Number(e.listing_id),
    at: new Date(e.at).toISOString(),
    kind: e.kind,
    from_status: e.from_status,
    to_status: e.to_status,
    note: e.note ? String(e.note).slice(0, 300) : null,
    actor: e.actor,
    run_id: e.run_id != null ? Number(e.run_id) : null,
  };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/summary', async (ctx) => {
    const data = await deps.withClient(async (c) => {
      const statusCounts = await c.query(
        `SELECT status, count(*)::int AS n FROM ic_job_listings
         WHERE coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL AND expired_at IS NULL
         GROUP BY status`,
      );
      const followupCounts = await c.query(
        `SELECT
           count(*) FILTER (WHERE status IN ('open','snoozed') AND coalesce(snoozed_until, due_at) < now())::int AS overdue,
           count(*) FILTER (WHERE status IN ('open','snoozed') AND coalesce(snoozed_until, due_at) >= now() AND coalesce(snoozed_until, due_at) < now() + interval '1 day')::int AS today,
           count(*) FILTER (WHERE status IN ('open','snoozed') AND coalesce(snoozed_until, due_at) >= now() AND coalesce(snoozed_until, due_at) < now() + interval '7 day')::int AS week
         FROM ic_followups`,
      );
      const lastRun = await c.query(`SELECT id, status, trigger, started_at, finished_at, heartbeat_at, stats FROM ic_scan_runs ORDER BY started_at DESC LIMIT 1`);
      const liveRun = await c.query(`SELECT id, status, trigger, started_at, finished_at, heartbeat_at, stats FROM ic_scan_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`);
      const openReview = await c.query(`SELECT count(*)::int AS n FROM ic_job_review_queue WHERE resolved_at IS NULL`);
      const budgetToday = await c.query(`SELECT source, pages, details FROM ic_scan_budget WHERE day = current_date ORDER BY source`);
      const disabledSources = await c.query(`SELECT source, disabled_until, manual_disable FROM ic_source_state WHERE manual_disable = true OR disabled_until > now() ORDER BY source`);
      const events = await recentEvents(c, { limit: 50 });
      return { statusCounts: statusCounts.rows, followupCounts: followupCounts.rows[0], lastRun: lastRun.rows[0] ?? null, liveRun: liveRun.rows[0] ?? null, openReview: openReview.rows[0].n, budgetToday: budgetToday.rows, disabledSources: disabledSources.rows, events };
    });

    /** @type {Record<string, number>} */
    const byStatus = {};
    let untriaged = 0;
    /** @type {Record<string, number>} */
    const byGroup = Object.fromEntries(Object.keys(STATUS_GROUPS).map((g) => [g, 0]));
    for (const row of data.statusCounts) {
      if (row.status === null) {
        untriaged = row.n;
        continue;
      }
      byStatus[row.status] = row.n;
      const g = groupOf(row.status);
      if (g) byGroup[g] += row.n;
    }

    const nextScan = await nextScheduledScan();

    sendJson(ctx.res, 200, {
      ok: true,
      pipeline: { by_status: byStatus, by_group: byGroup, untriaged },
      followups: data.followupCounts,
      last_run: data.lastRun ? formatRun(data.lastRun) : null,
      live_scan: data.liveRun ? formatRun(data.liveRun) : null,
      open_review: data.openReview,
      budget_today: data.budgetToday,
      disabled_sources: data.disabledSources.map((s) => ({ source: s.source, manual: s.manual_disable, until: s.manual_disable ? null : s.disabled_until ? new Date(s.disabled_until).toISOString() : null })),
      next_scheduled_scan: nextScan,
      recent_events: data.events.map(formatEvent),
    });
  });
}
