// @ts-check
/**
 * Scan routes (dashboard PR 2 API table, "Scans"). POST /scans and cancel go through scan-runner.js
 * (marker-file correlation, cancel backstop); everything else is a read over ic_scan_runs / ic_source_state
 * or reuses the `scans`/`profiles` tools' own query shapes and bin/scan.js's Chrome-reachability helpers.
 */
import { JobSearchError } from '../../core/errors.js';
import { cdpReachable, launchChrome } from '../../../bin/scan.js';
import { sendJson } from '../http.js';

/** @param {any} r */
function formatRunFull(r) {
  return {
    run_id: Number(r.id),
    profile: r.profile,
    profile_rev: r.profile_rev,
    trigger: r.trigger,
    status: r.status,
    dry_run: r.dry_run,
    config_hash: r.config_hash,
    started_at: new Date(r.started_at).toISOString(),
    finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    heartbeat_at: r.heartbeat_at ? new Date(r.heartbeat_at).toISOString() : null,
    stats: r.stats ?? {},
    pages_by_source: r.pages_by_source ?? {},
    errors: Array.isArray(r.errors) ? r.errors : [],
  };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/scans', async (ctx) => {
    const last = Math.max(1, Math.min(50, Number(ctx.query.last) || 20));
    const r = await deps.withClient((c) => c.query(
      'SELECT * FROM ic_scan_runs ORDER BY started_at DESC LIMIT $1',
      [last],
    ));
    sendJson(ctx.res, 200, { ok: true, runs: r.rows.map(formatRunFull) });
  });

  router.register('GET', '/api/scans/live', async (ctx) => {
    const status = deps.scanRunner.status();
    if (!status.running || status.runId == null) return sendJson(ctx.res, 200, { ok: true, running: false, run: null });
    const r = await deps.withClient((c) => c.query('SELECT * FROM ic_scan_runs WHERE id = $1', [status.runId]));
    sendJson(ctx.res, 200, { ok: true, running: true, pid: status.pid, run: r.rowCount ? formatRunFull(r.rows[0]) : null });
  });

  router.register('GET', '/api/scans/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const run = await deps.withClient((c) => c.query('SELECT * FROM ic_scan_runs WHERE id = $1', [id]));
    if (run.rowCount === 0) throw new JobSearchError('NOT_FOUND', `run ${id} not found`);
    const [items, queue] = await deps.withClient((c) => Promise.all([
      c.query(
        `SELECT ri.listing_id, ri.outcome, ri.page_index, l.title, l.company, l.source, l.status
         FROM ic_scan_run_items ri JOIN ic_job_listings l ON l.id = ri.listing_id
         WHERE ri.run_id = $1 ORDER BY ri.listing_id`,
        [id],
      ),
      c.query('SELECT id, candidate_id, reason FROM ic_job_review_queue WHERE run_id = $1', [id]),
    ]));
    sendJson(ctx.res, 200, { ok: true, run: formatRunFull(run.rows[0]), items: items.rows, review_queue: queue.rows });
  });

  router.register('POST', '/api/scans', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    const result = await deps.scanRunner.start({
      profile: typeof b.profile === 'string' ? b.profile : undefined,
      sources: Array.isArray(b.sources) ? b.sources.map(String) : undefined,
      dryRun: Boolean(b.dryRun),
      days: typeof b.days === 'number' ? b.days : undefined,
      maxPages: typeof b.maxPages === 'number' ? b.maxPages : undefined,
      minPrescore: typeof b.minPrescore === 'number' ? b.minPrescore : undefined,
    });
    sendJson(ctx.res, 202, { ok: true, run_id: result.runId, pid: result.pid });
  }, { allowEmptyBody: true });

  router.register('POST', '/api/scans/:id/cancel', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const r = await deps.withClient((c) => c.query(
      `UPDATE ic_scan_runs SET status = 'failed', finished_at = now(), errors = errors || '[{"code":"CANCELLED"}]'::jsonb
       WHERE id = $1 AND status = 'running' RETURNING id`,
      [id],
    ));
    if (r.rowCount === 0) throw new JobSearchError('NOT_FOUND', `run ${id} is not running`);
    const backstop = deps.scanRunner.armCancelBackstop(id);
    sendJson(ctx.res, 200, {
      ok: true,
      run_id: id,
      status: 'failed',
      forced_kill_available: backstop.forced_kill_available,
      note: backstop.forced_kill_available ? 'cancel requested; forced after 45 s if still running' : 'cancel requested; the scan stops at its next heartbeat check',
    });
  }, { allowEmptyBody: true });

  router.register('POST', '/api/sources/:name/enable', async (ctx) => {
    const raw = ctx.params.name;
    if (!raw) throw new JobSearchError('VALIDATION', 'source name is required');
    // Normalized the same way scan-run.js's resolveSources() normalizes a caller-supplied source name
    // (trim + lowercase) before it is ever used as a lookup or storage key: ic_source_state's rows are
    // always keyed by the adapter's canonical lowercase name (recordWall/recordClean/sourceEnabled all
    // call with s.name from a resolved adapter, never a caller's raw casing), so enabling "Greenhouse"
    // must land on the same row a scan run reads as "greenhouse" -- storing the raw casing verbatim
    // would silently create a second, dead row that never affects a real scan.
    const name = raw.trim().toLowerCase();
    if (deps.config) {
      const known = new Set(Object.keys(deps.config.adapters.adapters));
      if (!known.has(name)) throw new JobSearchError('NOT_FOUND', `unknown source: ${name}`, { hint: `known: ${[...known].join(', ')}` });
    }
    const existing = await deps.withClient((c) => c.query('SELECT manual_disable, disabled_until FROM ic_source_state WHERE source = $1', [name]));
    const row = existing.rows[0];
    const isDisabled = Boolean(row) && (row.manual_disable || (row.disabled_until && new Date(row.disabled_until).getTime() > Date.now()));
    if (!isDisabled) {
      // Visible no-op (never a silent 200 that looks identical to an actual reset): a source with no row,
      // or a row that is not currently disabled, has nothing to re-enable.
      return sendJson(ctx.res, 200, { ok: true, source: name, enabled: true, already_enabled: true });
    }
    const r = await deps.withClient((c) => c.query(
      `INSERT INTO ic_source_state (source, consecutive_walls, disabled_until, manual_disable) VALUES ($1, 0, NULL, false)
       ON CONFLICT (source) DO UPDATE SET consecutive_walls = 0, disabled_until = NULL, manual_disable = false, last_wall_at = ic_source_state.last_wall_at
       RETURNING source`,
      [name],
    ));
    sendJson(ctx.res, 200, { ok: true, source: r.rows[0].source, enabled: true, already_enabled: false });
  }, { allowEmptyBody: true });

  router.register('GET', '/api/profiles', async (ctx) => {
    const r = await deps.withClient((c) => c.query(
      'SELECT name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev, updated_at FROM ic_search_profiles ORDER BY name',
    ));
    // The full universe of scannable source names (adapters.json's own keys, the same set resolveSources()
    // in src/core/scan-run.js validates against), not any one profile's own `sources` column -- a profile's
    // `sources` is usually `{}` (meaning "no restriction, use every configured adapter"), so it cannot
    // double as the checkbox list the Run scan options drawer needs.
    const sources = deps.config ? Object.keys(deps.config.adapters.adapters).sort() : [];
    sendJson(ctx.res, 200, {
      ok: true,
      profiles: r.rows.map((p) => ({ ...p, rev: String(p.rev).slice(0, 12), updated_at: new Date(p.updated_at).toISOString() })),
      sources,
    });
  });

  router.register('GET', '/api/chrome', async (ctx) => {
    const reachable = await cdpReachable(deps.env.SCAN_CDP_URL);
    sendJson(ctx.res, 200, { ok: true, reachable, cdp_url: deps.env.SCAN_CDP_URL });
  });

  router.register('POST', '/api/chrome/launch', async (ctx) => {
    try {
      const result = await launchChrome(deps.env, deps.log ?? (() => {}));
      sendJson(ctx.res, 200, { ok: true, ...result });
    } catch (err) {
      throw new JobSearchError('VALIDATION', err instanceof Error ? err.message : String(err));
    }
  }, { allowEmptyBody: true });
}
