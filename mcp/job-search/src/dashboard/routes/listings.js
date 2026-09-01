// @ts-check
/**
 * Listings routes (dashboard PR 2 API table, "Listings"). Reuses buildQuery (extended with
 * group/untriaged), applyMark, createManualListing, and the document/follow-up/event readers so a
 * listing's detail view assembles from the same functions the MCP tools use.
 */
import { JobSearchError } from '../../core/errors.js';
import { buildQuery, SORTS } from '../../tools/query_jobs.js';
import { applyMark } from '../../tools/mark_jobs.js';
import { createManualListing } from '../../core/manual.js';
import { listEvents } from '../../core/events.js';
import { listDocuments, suggestDocuments, listOutputFiles } from '../../core/documents.js';
import { listFollowups } from '../../core/followups.js';
import { PIPELINE_STATUSES } from '../../core/statuses.js';
import { reembedRows } from '../../core/reembed.js';
import { buildRegistry } from '../../core/urlguard.js';
import { urlPassesRegistry } from '../../core/report.js';
import { prescoreParts } from '../../core/prescore.js';
import { weightedPrescore, getDefaultNoiseRules } from '../../core/noise.js';
import { classifyApplyUrl } from '../../apply/ats-detect.js';
import { getApplicationForListing } from '../../core/applications.js';
import { sendJson } from '../http.js';

/** @param {Record<string,string>} q @param {string} key */
function listParam(q, key) {
  return q[key] ? String(q[key]).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

/**
 * Mirrors the MCP tool's own zod rule (`z.number().int().min(0).max(100).optional()`) exactly: a
 * non-integer, out-of-range, or unparseable value is DROPPED (returns `undefined`, applying no filter),
 * never clamped into range. Clamping a typo like `minPrescore=1000` down to 100 would silently apply a
 * filter the user never asked for; dropping it applies no filter at all, which is the same "did nothing
 * surprising" behavior the MCP schema already gives an out-of-range caller.
 * @param {string|undefined} raw
 * @returns {number|undefined}
 */
function parseScoreParam(raw) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
}

/**
 * @param {Record<string,string>} q
 */
export function parseListingsQuery(q) {
  return {
    q: q.q || undefined,
    status: listParam(q, 'status'),
    source: listParam(q, 'source'),
    noiseClass: listParam(q, 'noiseClass'),
    group: q.group || undefined,
    untriaged: q.untriaged === '1' || q.untriaged === 'true',
    // Slice 3 auto-triage (spec section 7): total classification over the one recognized value -- any
    // other query value (missing, empty, garbage) reduces to `undefined` (no filter), never passed
    // through raw to buildQuery.
    triagedBy: q.triagedBy === 'auto' ? 'auto' : undefined,
    location: q.location || undefined,
    remote: q.remote || undefined,
    postedAfter: q.postedAfter || undefined,
    seenAfter: q.seenAfter || undefined,
    minPrescore: parseScoreParam(q.minPrescore),
    minFit: parseScoreParam(q.minFit),
    unscored: q.unscored === '1' || q.unscored === 'true',
    includeDuplicates: q.includeDuplicates === '1' || q.includeDuplicates === 'true',
    includeExpired: q.includeExpired === '1' || q.includeExpired === 'true',
    // Default Jobs view hides status='skip' rows (dashboard-only, like group/untriaged/dir/triagedBy
    // above -- not part of the MCP query_jobs zod schema). Total classification over the one recognized
    // value: anything else (missing, empty, garbage) is false, which fails open by showing skip rows
    // rather than silently hiding data on a malformed query param.
    hideSkip: q.hideSkip === '1' || q.hideSkip === 'true',
    // Exact membership in the real SORTS list (imported, not redeclared): the previous `q.sort ||
    // 'posted'` let any garbage string through to buildQuery's ORDER BY lookup, which used to resolve to
    // `undefined` and produce broken SQL for a non-empty, non-SORTS value (a latent crash, not just a
    // validation gap -- see query_jobs.js's own order-lookup guard for the other half of this fix).
    sort: SORTS.includes(q.sort) ? q.sort : 'posted',
    // `dir` is a dashboard-only extension to buildQuery (see query_jobs.js): total classification,
    // case/whitespace-insensitive, anything but exactly 'asc' is 'desc'.
    dir: String(q.dir ?? '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc',
    limit: q.limit !== undefined ? Math.max(1, Math.min(200, Number(q.limit) || 50)) : 50,
    offset: q.offset !== undefined ? Math.max(0, Number(q.offset) || 0) : 0,
  };
}

/**
 * Recompute a listing's prescore breakdown against its `search_profile`'s CURRENT row in
 * `ic_search_profiles` (never a snapshot from scan time -- a profile can be edited after the listing was
 * scored, and this route's whole purpose is showing whether the stored score still matches today's
 * profile). Two closed branches:
 *
 * - the listing has no `search_profile` recorded, or that profile name no longer exists in
 *   `ic_search_profiles` (renamed or deleted since scan time) -> `{ available: false, reason:
 *   'profile_missing' }`, with no parts/numbers to show.
 * - the profile still exists -> the full named parts breakdown, the pre-clamp sum, the recomputed
 *   clamped `raw`, the noise multiplier for the listing's CURRENT `noise_class`, the recomputed
 *   noise-weighted prescore, and `stale`: whether the recomputed `raw` differs from the `prescore_raw`
 *   value stored on the row at scan time.
 * @param {import('../server.js').DashboardDeps} deps
 * @param {any} listing a row carrying search_profile, noise_class, prescore, prescore_raw, title,
 *   location, location_norm, remote_mode, description, salary_max
 */
async function computePrescoreBreakdown(deps, listing) {
  if (!listing.search_profile) return { available: false, reason: 'profile_missing' };
  const profileRow = await deps.withClient((c) => c.query(
    'SELECT keywords, phrases, exclude_terms, locations, remote FROM ic_search_profiles WHERE name = $1',
    [listing.search_profile],
  ));
  if (profileRow.rowCount === 0) return { available: false, reason: 'profile_missing' };
  const profile = profileRow.rows[0];
  const { parts, sum, raw } = prescoreParts(listing, profile);
  const rules = getDefaultNoiseRules();
  const multiplier = typeof rules.multipliers[listing.noise_class] === 'number' ? rules.multipliers[listing.noise_class] : 1;
  const recomputedPrescore = weightedPrescore(raw, listing.noise_class, { rules });
  return {
    available: true,
    parts,
    sum,
    raw,
    noise_class: listing.noise_class,
    multiplier,
    recomputed_prescore: recomputedPrescore,
    stored_prescore_raw: listing.prescore_raw,
    stored_prescore: listing.prescore,
    stale: raw !== listing.prescore_raw,
  };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  router.register('GET', '/api/listings', async (ctx) => {
    const args = parseListingsQuery(ctx.query);
    const { sql, params } = buildQuery(args);
    const r = await deps.withClient((c) => c.query(sql, params));
    const registry = deps.config ? buildRegistry(deps.config) : { entries: [], httpAllowedHosts: new Set() };
    const total = r.rows.length ? Number(r.rows[0].total) : 0;
    const rows = r.rows.map((row) => {
      const { total: _t, ...rest } = row;
      return { ...rest, url_ok: urlPassesRegistry(row.url_normalized ?? row.url ?? null, registry) };
    });
    sendJson(ctx.res, 200, { ok: true, total, rows, limit: args.limit, offset: args.offset });
  });

  router.register('GET', '/api/listings/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => c.query(
      `SELECT id, title, company, location, location_norm, remote_mode, posted_at, salary_min, salary_max, salary_raw,
              prescore, prescore_raw, noise_class, fit_score, status, source, url, url_normalized, external_id, notes,
              description, first_seen, last_seen, times_seen, duplicate_of, repost_of, expired_at, stale, record_kind,
              search_profile, detail_skipped, marked_at, company_norm, title_norm
       FROM ic_job_listings WHERE id = $1`,
      [id],
    ));
    if (row.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${id} not found`);
    const listing = row.rows[0];
    const [events, documents, followups, openReview, duplicates, alsoPosted, runSightings, application] = await deps.withClient((c) => Promise.all([
      listEvents(c, id, { limit: 50 }),
      listDocuments(c, id),
      // Scoped in SQL via listingId (not an in-memory filter after a system-wide LIMIT) so a listing's own
      // follow-ups are never dropped just because other listings have more open/snoozed rows due sooner.
      // Status stays open+snoozed, matching this route's prior default; done/cancelled are intentionally
      // excluded here (see PR body).
      listFollowups(c, { listingId: id, limit: 100 }).then((r2) => r2.rows),
      c.query('SELECT id, reason, matches, created_at FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [id]),
      c.query('SELECT id, title, company, source, status FROM ic_job_listings WHERE duplicate_of = $1', [id]),
      c.query('SELECT id, source, location FROM ic_job_listings WHERE duplicate_of = $1 OR repost_of = $1', [id]),
      c.query('SELECT run_id FROM ic_scan_run_items WHERE listing_id = $1 ORDER BY run_id DESC LIMIT 10', [id]),
      getApplicationForListing(c, id),
    ]));
    const files = listOutputFiles(deps.outputRoot);
    const aliases = deps.config?.companyAliases ?? {};
    const suggestions = suggestDocuments(listing, files, { aliases }).filter((s) => !documents.some((d) => d.rel_path === s.file));
    const prescoreBreakdown = await computePrescoreBreakdown(deps, listing);
    // Apply pipeline slice 2 (ATS badge, spec-adversary amendment S12): computed on the fly from the
    // listing's stored URL, never persisted -- no schema change, and the classification always reflects
    // the CURRENT ats-detect.js rules rather than a stale value frozen at scan time. url_normalized wins
    // over the raw url the same way GET /api/listings' url_ok computation already does above.
    const ats = classifyApplyUrl(listing.url_normalized ?? listing.url ?? null);
    sendJson(ctx.res, 200, {
      ok: true,
      row: listing,
      events,
      documents,
      suggestions,
      followups,
      open_review: openReview.rows,
      duplicates: duplicates.rows,
      also_posted: alsoPosted.rows,
      run_sightings: runSightings.rows.map((r2) => Number(r2.run_id)),
      prescore_breakdown: prescoreBreakdown,
      ats,
      // Apply pipeline slice 3 (application card, plan section 7): the most recent non-withdrawn
      // application for this listing, or null when none has been started yet. Nested here (like `ats`
      // above) so the job-detail page assembles the whole application card from this one GET, matching
      // the existing pattern for documents/followups/prescore_breakdown.
      application,
    });
  });

  router.register('POST', '/api/listings', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    const title = typeof b.title === 'string' ? b.title : '';
    const company = typeof b.company === 'string' ? b.company : '';
    const url = typeof b.url === 'string' ? b.url : null;
    const location = typeof b.location === 'string' ? b.location : null;
    const status = b.status === undefined ? 'new' : b.status;
    const via = typeof b.via === 'string' ? b.via : null;
    const force = Boolean(b.force);
    if (status !== null && !PIPELINE_STATUSES.includes(status)) throw new JobSearchError('VALIDATION', `status must be one of ${PIPELINE_STATUSES.join(', ')} or null`);
    const result = await deps.withClient((c) => createManualListing(c, { title, company, url, location, status, via }, { actor: 'dashboard', force }));
    if (!result.created) {
      return sendJson(ctx.res, 409, { ok: false, code: 'DUPLICATE_CANDIDATE', message: 'a similar listing already exists', candidates: result.candidates });
    }
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 201, { ok: true, id: result.id, warnings: [] });
  });

  router.register('POST', '/api/listings/:id/status', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    const status = b.status;
    const note = typeof b.note === 'string' ? b.note : undefined;
    if (!PIPELINE_STATUSES.includes(status)) throw new JobSearchError('VALIDATION', `status must be one of ${PIPELINE_STATUSES.join(', ')}`);
    const now = new Date();
    const result = await deps.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        // `note` documents why the status changed and lands on the status event itself (statusNote),
        // never on the listing's persistent `notes` column -- see PUT /listings/:id/notes for that.
        const out = await applyMark(c, { id, status, ...(note !== undefined ? { statusNote: note } : {}) }, { now, explicit: true, actor: 'dashboard' });
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    if (result.reembed) await reembedRows(deps, [id]);
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, row: result, warnings: [] });
  });

  router.register('PUT', '/api/listings/:id/notes', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    if (typeof b.notes !== 'string') throw new JobSearchError('VALIDATION', 'notes is required (string)');
    const now = new Date();
    const result = await deps.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const out = await applyMark(c, { id, notes: b.notes }, { now, explicit: true, actor: 'dashboard' });
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    if (result.reembed) await reembedRows(deps, [id]);
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, row: result, warnings: [] });
  });

  router.register('PUT', '/api/listings/:id/fit', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    const fit = Number(b.fit_score);
    if (!Number.isInteger(fit) || fit < 0 || fit > 100) throw new JobSearchError('VALIDATION', 'fit_score must be an integer 0-100');
    const now = new Date();
    const result = await deps.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const out = await applyMark(c, { id, fit_score: fit }, { now, explicit: true, actor: 'dashboard' });
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, row: result, warnings: [] });
  });

  router.register('POST', '/api/listings/bulk-status', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0) : [];
    if (ids.length === 0 || ids.length > 200) throw new JobSearchError('VALIDATION', 'ids must be a non-empty array of up to 200 positive integers');
    if (!PIPELINE_STATUSES.includes(b.status)) throw new JobSearchError('VALIDATION', `status must be one of ${PIPELINE_STATUSES.join(', ')}`);
    const now = new Date();
    const results = await deps.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const out = [];
        for (const id of ids) out.push(await applyMark(c, { id, status: b.status }, { now, explicit: true, actor: 'dashboard' }));
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, results, warnings: [] });
  });
}
