// @ts-check
/**
 * Shared "fit sweep" candidate predicate (fix/detail-fit-sweep spec S1). Auto-apply has never fired: 12
 * listings carry fit_score >= 70 but an empty description, so src/core/auto-apply-select.js's
 * classifyCandidate() rejects every one of them at the no_description gate -- and a live scan's own
 * runDetailPass (src/core/scan-run.js) only ever queues a listing it sees FRESH on the current run's list
 * pages, so an already-scanned, already-fit-scored row sitting at a prescore below the source's
 * detailFetchMinPrescore gate is never revisited for a detail fetch on its own. This module is the single
 * source of truth for "which already-persisted rows are worth a detail fetch because they already look
 * like a good fit," used by BOTH src/core/scan-run.js's runDetailPass (S1: a per-source sweep appended to
 * a live scan's run queue, sharing its per-run detail-fetch budget per S2) and bin/backfill-detail.js (S4:
 * this same predicate is UNIONed into the script's own existing status-based selection) so the two paths
 * can never drift apart.
 *
 * Predicate (every clause independently required -- see fitSweepPredicateSql below):
 *   - coalesce(record_kind,'listing') = 'listing'          -- never a non-listing record (mirrors
 *     src/core/auto-apply-select.js's fetchCandidateRows() and bin/backfill-detail.js's own selection)
 *   - fit_score >= fitFloor                                 -- the SAME floor auto-apply-select.js's
 *     classifyCandidate() reads from config/auto-apply.json (opts.fitFloor -- loaded via loadConfig()
 *     upstream; this module never loads config itself, every caller resolves and passes the number)
 *   - description IS NULL OR btrim(description) = ''        -- the SAME emptiness test
 *     auto-apply-select.js's classifyCandidate() no_description branch uses:
 *     `typeof row.description !== 'string' || row.description.trim().length === 0`. A NULL description
 *     and a description that is only whitespace both satisfy that JS check, so both must satisfy this SQL
 *     check too -- btrim(description) = '' is the SQL-side equivalent of `.trim().length === 0`.
 *   - duplicate_of IS NULL                                   -- never a row merged away into another
 *   - status IS NULL OR status IN ('new','maybe','shortlisted')  -- the EXACT set
 *     auto-apply-select.js's fetchCandidateRows() selects over, so a terminal status (applied, closed,
 *     skip, review, etc.) is never reopened by the sweep
 *   - expired_at IS NULL AND absent_runs = 0                  -- never an expired row, and never a row
 *     that did not appear on its source's most recent scan list pages (src/core/scan-run.js's expiryPass
 *     increments absent_runs for exactly that case, ahead of eventual expiry -- a listing already on that
 *     path is not worth spending a detail-fetch slot on)
 *   - coalesce(stale, false) = false                          -- spec S1's "if stale is a separate flag,
 *     exclude stale too": sql/001_extend_ic_job_listings.sql's own `stale` boolean, set by expiryPass when
 *     a listing falls off the deepest page a run actually crawled
 *   - NOT EXISTS (... ic_job_applications ... state <> 'withdrawn' ...) -- the EXACT active-application
 *     predicate auto-apply-select.js's fetchCandidateRows() uses (there it is a positive EXISTS read into
 *     `row.hasActiveApplication`, which classifyCandidate() then rejects on; restated here directly as a
 *     NOT EXISTS since this module has no per-row JS classification step of its own)
 *
 * detail_attempts is DELIBERATELY NOT part of this shared predicate. scan-run.js's own sweep call (a
 * single, already-known source per invocation) applies it as an extra SQL clause alongside this one (see
 * buildScanFitSweepQuery below); bin/backfill-detail.js already applies the equivalent check AFTER its own
 * query, in JS, per row's own source-specific effective cap (its existing `effectiveMaxAttempts()` /
 * `candidates.filter(...)` step) -- that filter runs over every candidate row regardless of why it
 * matched, so a fit-sweep-matched row gets the exact same attempts-cap treatment a status-matched row
 * already does, without this module needing to know backfill's per-source override rules at all.
 *
 * Adapter capability ("only for sources whose adapter exports fetchDetail") is likewise NOT checked here:
 * it is a per-source fact the CALLER already knows before ever calling into this module (scan-run.js only
 * calls buildScanFitSweepQuery for a source `s` whose `s.adapter.fetchDetail` it has already checked;
 * bin/backfill-detail.js already computes its own `detailSources` allow-list the same way for its existing
 * selection) -- duplicating that check here would need this module to import the adapter registry for no
 * benefit.
 *
 * BLIND SPOT (documented per spec S1): ic_job_listings carries no rubric/profile-revision column on
 * fit_score at all (verified against every sql/*.sql migration through 017 -- see sql/001 through
 * sql/017, none add one). There is therefore nothing to compare "the current rubric revision" against, so
 * that predicate clause is never applied: a fit_score computed under a since-changed scoring rubric is
 * still swept if every other clause matches. This is a real, known gap, not an oversight -- see the PR
 * body's BLIND SPOTS section.
 */

/**
 * The boolean fit-sweep predicate, composable into a larger WHERE clause. Placeholders start at
 * `paramOffset + 1` so a caller with its own earlier params can splice this in without renumbering;
 * `params` (returned in the same order the placeholders were assigned) must be appended, in order, to the
 * caller's own params array immediately after building this.
 * @param {{ paramOffset: number, fitFloor: number, source?: string|null }} o
 * @returns {{ sql: string, params: any[] }}
 */
export function fitSweepPredicateSql(o) {
  /** @type {any[]} */
  const params = [];
  let n = o.paramOffset;
  const next = (/** @type {any} */ v) => {
    params.push(v);
    n += 1;
    return `$${n}`;
  };
  const clauses = [
    `coalesce(record_kind,'listing') = 'listing'`,
    `fit_score >= ${next(o.fitFloor)}`,
    `(description IS NULL OR btrim(description) = '')`,
    `duplicate_of IS NULL`,
    `(status IS NULL OR status IN ('new','maybe','shortlisted'))`,
    `expired_at IS NULL`,
    `absent_runs = 0`,
    `coalesce(stale, false) = false`,
    `NOT EXISTS (SELECT 1 FROM ic_job_applications a WHERE a.listing_id = ic_job_listings.id AND a.state <> 'withdrawn')`,
  ];
  if (o.source) clauses.push(`source = ${next(o.source)}`);
  return { sql: `(${clauses.join(' AND ')})`, params };
}

/** Row shape selected by buildScanFitSweepQuery -- enough for adapter.fetchDetail's input plus
 * normalizeListing()'s other fields (mirrors bin/backfill-detail.js's own candidate SELECT list). */
export const FIT_SWEEP_SELECT_COLUMNS = `id, source, external_id, url, url_normalized, title, company, location, remote_mode, remote_declared,
      salary_min, salary_max, salary_raw, posted_at, fit_score, status, detail_outcome, detail_attempts`;

/**
 * scan-run.js's own standalone fit-sweep query (S1): one source, this source's own resolved
 * detailMaxAttempts, an optional exclude list (S2: never re-select a row this SAME run already queued via
 * the ordinary list-page path, so no row is ever detail-fetched twice in one run), and an optional row
 * limit (S2's share cap). Ordered fit_score DESC, posted_at DESC NULLS LAST, id ASC per spec S1.
 * @param {{ source: string, fitFloor: number, detailMaxAttempts: number, excludeIds?: number[], limit?: number|null }} o
 * @returns {{ sql: string, params: any[] }}
 */
export function buildScanFitSweepQuery(o) {
  const pred = fitSweepPredicateSql({ paramOffset: 0, fitFloor: o.fitFloor, source: o.source });
  const params = [...pred.params];
  const clauses = [pred.sql, `detail_attempts < $${params.push(o.detailMaxAttempts)}`];
  if (o.excludeIds && o.excludeIds.length) clauses.push(`NOT (id = ANY($${params.push(o.excludeIds)}::int[]))`);
  // limit is always an internally-computed non-negative integer (S2's share-cap arithmetic), never user
  // input -- interpolated directly rather than parameterized so it can be omitted cleanly when null/unset.
  const limitClause = o.limit !== null && o.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(Number(o.limit)))}` : '';
  const sql = `SELECT ${FIT_SWEEP_SELECT_COLUMNS}
    FROM ic_job_listings
    WHERE ${clauses.join(' AND ')}
    ORDER BY fit_score DESC, posted_at DESC NULLS LAST, id ASC${limitClause}`;
  return { sql, params };
}
