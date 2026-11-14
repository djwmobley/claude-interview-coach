// @ts-check
/**
 * Scan routes (dashboard PR 2 API table, "Scans"). POST /scans and cancel go through scan-runner.js
 * (marker-file correlation, cancel backstop); everything else is a read over ic_scan_runs / ic_source_state
 * or reuses the `scans`/`profiles` tools' own query shapes and bin/scan.js's Chrome-reachability helpers.
 */
import { JobSearchError } from '../../core/errors.js';
import { cdpReachable, launchChrome } from '../../../bin/scan.js';
import { sendJson } from '../http.js';
import { adapterNames } from '../../adapters/index.js';
import { reenableSource, normalizeSourceName, pairOf } from '../../browser/wall.js';
import { collectDisabledSourceStates, disabledSourceView, getParkedIndeed } from '../../core/source-state.js';
import { connectCdp } from '../../browser/cdp-target.js';

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
    // wall.js is the one source-name normalizer. It rejects a blank name, so a blank name is handled here
    // exactly as before: name and base are '' and flow on (unknown source with the known: hint when
    // deps.config is present, the same no-config flow as before otherwise).
    const blank = !raw.trim();
    const name = blank ? '' : normalizeSourceName(raw);
    const base = blank ? '' : pairOf(raw).base;
    if (deps.config) {
      const known = new Set(Object.keys(deps.config.adapters.adapters));
      // A detail-fetch latch lives under its own "<source>:detail" key (wall.js detailWallKey); it is
      // re-enabled the same way as the list latch of the adapter it belongs to.
      if (!known.has(base)) throw new JobSearchError('NOT_FOUND', `unknown source: ${name}`, { hint: `known: ${[...known].join(', ')}` });
    }
    const existing = await deps.withClient((c) => c.query('SELECT manual_disable, disabled_until FROM ic_source_state WHERE source = $1', [name]));
    const row = existing.rows[0];
    const isDisabled = Boolean(row) && (row.manual_disable || (row.disabled_until && new Date(row.disabled_until).getTime() > Date.now()));
    if (!isDisabled) {
      // Visible no-op (never a silent 200 that looks identical to an actual reset): a source with no row,
      // or a row that is not currently disabled, has nothing to re-enable.
      return sendJson(ctx.res, 200, { ok: true, source: name, enabled: true, already_enabled: true });
    }
    const stored = await deps.withClient((c) => reenableSource(c, name));
    sendJson(ctx.res, 200, { ok: true, source: stored, enabled: true, already_enabled: false });
  }, { allowEmptyBody: true });

  router.register('GET', '/api/sources/disabled', async (ctx) => {
    const rows = await deps.withClient((c) => collectDisabledSourceStates(c));
    const parked = await deps.withClient((c) => getParkedIndeed(c));
    sendJson(ctx.res, 200, { ok: true, sources: rows.map(disabledSourceView), parked_source: parked });
  });

  // Indeed parked on a human-verification challenge (sql/032). Open: bring the parked tab to the front of the
  // scan Chrome; when the tab or the Chrome is gone, start the Chrome and open the stored address in a new tab
  // and store its target id. deps.parkedTab is a test seam (production: raw CDP to SCAN_CDP_URL).
  router.register('POST', '/api/sources/indeed/open-page', async (ctx) => {
    const parked = await deps.withClient((c) => getParkedIndeed(c));
    if (!parked) throw new JobSearchError('NOT_FOUND', 'indeed is not waiting for a click');
    const seam = deps.parkedTab ?? {};
    const connect = seam.connect ?? (() => connectCdp({ cdpHttpUrl: deps.env.SCAN_CDP_URL, timeoutMs: 10000 }));
    const launch = seam.launchChrome ?? launchChrome;
    let cdp;
    try {
      cdp = await connect();
    } catch {
      try {
        await launch(deps.env, deps.log ?? (() => {}));
        cdp = await connect();
      } catch (err) {
        throw new JobSearchError('BROWSER_UNAVAILABLE', err instanceof Error ? err.message : 'the scan Chrome could not be started');
      }
    }
    try {
      const live = (await cdp.listPageTargets()).some((t) => t.targetId === parked.target_id);
      if (parked.target_id && live) {
        await cdp.send('Target.activateTarget', { targetId: parked.target_id });
        return sendJson(ctx.res, 200, { ok: true, reopened: false, target_id: parked.target_id });
      }
      if (!parked.url) throw new JobSearchError('VALIDATION', 'the parked tab is gone and no page address was stored');
      const created = await cdp.send('Target.createTarget', { url: parked.url });
      const newId = String(created.targetId ?? '');
      if (!newId) throw new JobSearchError('BROWSER_UNAVAILABLE', 'the scan Chrome did not open the page');
      await deps.withClient((c) => c.query("UPDATE ic_source_state SET park_target_id = $1 WHERE source = 'indeed' AND parked_at IS NOT NULL", [newId]));
      await cdp.send('Target.activateTarget', { targetId: newId });
      sendJson(ctx.res, 200, { ok: true, reopened: true, target_id: newId });
    } finally {
      cdp.close();
    }
  }, { allowEmptyBody: true });

  // Resume: clear the park through the existing re-enable path, then start a real scan limited to Indeed.
  // A scan already running is a visible no-op (LOCKED, the same 409 POST /api/scans gives) and the park stays.
  router.register('POST', '/api/sources/indeed/resume', async (ctx) => {
    if (deps.scanRunner.status().running) throw new JobSearchError('LOCKED', 'a scan is already running');
    const parked = await deps.withClient((c) => getParkedIndeed(c));
    if (!parked) throw new JobSearchError('NOT_FOUND', 'indeed is not waiting for a click');
    await deps.withClient((c) => reenableSource(c, 'indeed'));
    const result = await deps.scanRunner.start({ sources: ['indeed'] });
    sendJson(ctx.res, 202, { ok: true, run_id: result.runId, pid: result.pid });
  }, { allowEmptyBody: true });

  router.register('GET', '/api/profiles', async (ctx) => {
    const r = await deps.withClient((c) => c.query(
      'SELECT name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev, updated_at FROM ic_search_profiles ORDER BY name',
    ));
    // The full universe of scannable source names (adapters.json's own keys, the same set resolveSources()
    // in src/core/scan-run.js validates against), not any one profile's own `sources` column -- a profile's
    // `sources` is usually `{}` (meaning "no restriction, use every configured adapter"), so it cannot
    // double as the checkbox list the Run scan options drawer needs. Intersected with adapterNames() so a
    // config key with no registered adapter (e.g. icims, smartrecruiters) never appears as a checkbox for
    // a source that cannot actually run.
    const configuredSources = deps.config ? new Set(Object.keys(deps.config.adapters.adapters)) : null;
    const sources = configuredSources ? adapterNames().filter((n) => configuredSources.has(n)).sort() : [];
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
