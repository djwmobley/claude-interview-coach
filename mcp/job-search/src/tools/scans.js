// @ts-check
/**
 * scans (spec section 5): run status, source re-enable, cancel.
 * Cancel flips a running row to failed and clears the heartbeat so the
 * in-process run loop (stage 3) sees it on its next heartbeat check; a
 * runner in another process (CLI) also reads this row.
 */
import { z } from 'zod';
import { JobSearchError } from '../core/errors.js';

export const schema = {
  action: z.enum(['status', 'enable_source', 'cancel']),
  run_id: z.number().int().positive().optional(),
  last: z.number().int().min(1).max(10).default(3),
  source: z.string().max(40).optional(),
};

/** @param {any} r */
function runSummary(r) {
  return {
    run_id: r.id,
    profile: r.profile,
    trigger: r.trigger,
    status: r.status,
    dry_run: r.dry_run,
    started_at: new Date(r.started_at).toISOString(),
    finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    heartbeat_at: r.heartbeat_at ? new Date(r.heartbeat_at).toISOString() : null,
    stats: r.stats ?? {},
    pages_by_source: r.pages_by_source ?? {},
    errors: Array.isArray(r.errors) ? r.errors.slice(0, 5) : [],
  };
}

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'scans',
  description: 'Scan run status (last N or one run_id), per-source disable state, re-enable a source after walls (enable_source), or cancel a running scan.',
  schema,
  async handler(a, deps) {
    if (a.action === 'status') {
      return deps.withClient(async (c) => {
        const runs = a.run_id
          ? await c.query('SELECT * FROM ic_scan_runs WHERE id = $1', [a.run_id])
          : await c.query('SELECT * FROM ic_scan_runs ORDER BY started_at DESC LIMIT $1', [a.last]);
        if (a.run_id && runs.rowCount === 0) throw new JobSearchError('NOT_FOUND', `run ${a.run_id} not found`);
        const sources = await c.query('SELECT source, disabled_until, consecutive_walls, last_wall_at, manual_disable FROM ic_source_state ORDER BY source');
        const budget = await c.query('SELECT source, pages, details FROM ic_scan_budget WHERE day = current_date ORDER BY source');
        const queue = await c.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE resolved_at IS NULL');
        return {
          ok: true,
          runs: runs.rows.map(runSummary),
          sources: sources.rows.map((s) => ({
            source: s.source,
            manual_disable: s.manual_disable,
            disabled_until: s.disabled_until ? new Date(s.disabled_until).toISOString() : null,
            consecutive_walls: s.consecutive_walls,
          })),
          budget_today: budget.rows,
          open_review: queue.rows[0].n,
        };
      });
    }
    if (a.action === 'enable_source') {
      if (!a.source) throw new JobSearchError('VALIDATION', 'source is required');
      const r = await deps.withClient((c) => c.query(
        `INSERT INTO ic_source_state (source, consecutive_walls, disabled_until, manual_disable) VALUES ($1, 0, NULL, false)
         ON CONFLICT (source) DO UPDATE SET consecutive_walls = 0, disabled_until = NULL, manual_disable = false, last_wall_at = ic_source_state.last_wall_at
         RETURNING source`,
        [a.source],
      ));
      return { ok: true, source: r.rows[0].source, enabled: true };
    }
    if (!a.run_id) throw new JobSearchError('VALIDATION', 'run_id is required for cancel');
    const r = await deps.withClient((c) => c.query(
      `UPDATE ic_scan_runs SET status = 'failed', finished_at = now(), errors = errors || '[{"code":"CANCELLED"}]'::jsonb
       WHERE id = $1 AND status = 'running' RETURNING id`,
      [a.run_id],
    ));
    if (r.rowCount === 0) return { ok: false, code: 'NOT_FOUND', message: `run ${a.run_id} is not running`, hint: 'scans({action:"status"})' };
    return { ok: true, run_id: a.run_id, status: 'failed', note: 'cancel requested; a live runner stops at its next heartbeat' };
  },
};
