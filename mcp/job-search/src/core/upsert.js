// @ts-check
/**
 * Persistence for classify() decisions, review-queue entries, run items,
 * and adoption of rows inserted by the Python tools (spec 2.2 step 5, 3.2).
 *
 * All functions take a pg client that the caller controls (transaction
 * boundaries belong to the scan loop). Per-record work runs inside a
 * SAVEPOINT so one bad row never aborts a run.
 */
import crypto from 'node:crypto';
import { withSavepoint, isUniqueViolation } from './db.js';
import { classify, LISTING_COLUMNS, makePgLookups } from './dedup.js';
import { normalizeLegacyRow } from './normalize.js';
import { classifyNoise } from './noise.js';
import { JobSearchError } from './errors.js';
import { recordEvent } from './events.js';
import { isStickyStatus, matchTest, surfaceException, stickyEligibleFor } from './sticky-skip.js';

/**
 * sha256 over the searchable profile fields (spec 2.3 `rev`).
 * @param {{ keywords?: string[], phrases?: string[], exclude_terms?: string[], locations?: string[], remote?: string, posted_within_days?: number, max_pages?: number, sources?: string[] }} p
 */
export function computeProfileRev(p) {
  const norm = (/** @type {string[]|undefined} */ a) => (a ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const body = {
    keywords: norm(p.keywords),
    phrases: norm(p.phrases),
    exclude_terms: norm(p.exclude_terms),
    locations: norm(p.locations),
    remote: String(p.remote ?? 'any').toLowerCase(),
    posted_within_days: Number(p.posted_within_days ?? 7),
    max_pages: Number(p.max_pages ?? 3),
    sources: norm(p.sources).sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * @typedef {Object} ApplyContext
 * @property {number|null} runId
 * @property {number|null} [pageIndex]
 * @property {string|null} [searchProfile]
 * @property {string|null} [profileRev]
 * @property {number|null} [prescore] final, noise-weighted prescore (spec R2.2)
 * @property {number|null} [prescoreRaw] the unweighted prescore before the noise_class multiplier
 * @property {string|null} [noiseClass] one of NOISE_CLASSES (spec R2.1)
 * @property {boolean} [detailSkipped] true when a detail fetch was queued for this row but skipped for budget reasons (spec R4.2, decision 22)
 * @property {string|null} [embedding] pgvector literal `[a,b,...]` or null
 * @property {Date} [now]
 */

/**
 * Compact JSON snapshot of a candidate for the queue (never the raw payload).
 * @param {import('./normalize.js').NormalizedListing} rec
 */
export function candidateSnapshot(rec) {
  return {
    source: rec.source,
    external_id: rec.external_id,
    url_normalized: rec.url_normalized,
    title: rec.title,
    company: rec.company,
    title_norm: rec.title_norm,
    company_norm: rec.company_norm,
    location_norm: rec.location_norm,
    dedup_hash: rec.dedup_hash,
    description_hash: rec.description_hash,
    posted_at: rec.posted_at,
    salary_min: rec.salary_min,
    salary_max: rec.salary_max,
  };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ runId: number|null, candidate: object|null, candidateId: number|null, matches: number[], reason: string, statusAtCreate: string|null }} q
 * @returns {Promise<number>} queue id
 */
export async function enqueueReview(client, q) {
  const r = await client.query(
    `INSERT INTO ic_job_review_queue (run_id, candidate, candidate_id, matches, reason, status_at_create)
     VALUES ($1, $2::jsonb, $3, $4::int[], $5, $6) RETURNING id`,
    [q.runId, q.candidate ? JSON.stringify(q.candidate) : null, q.candidateId, q.matches ?? [], q.reason, q.statusAtCreate],
  );
  return r.rows[0].id;
}

/**
 * Record the per-run item; returns true when this is the first time the
 * (run, listing, source) triple was seen in the run.
 * @param {import('pg').ClientBase} client
 * @param {number|null} runId
 * @param {number} listingId
 * @param {string} source
 * @param {string} outcome
 * @param {number|null} [pageIndex]
 */
export async function recordRunItem(client, runId, listingId, source, outcome, pageIndex = null) {
  if (runId === null || runId === undefined) return true;
  const r = await client.query(
    `INSERT INTO ic_scan_run_items (run_id, listing_id, source, outcome, page_index) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (run_id, listing_id, source) DO NOTHING`,
    [runId, listingId, source, outcome, pageIndex],
  );
  return r.rowCount === 1;
}

/**
 * Insert a listing row for outcomes new / cross_source_dup / repost / ambiguous.
 * fit_score is always NULL; status comes from inheritance or 'review'.
 *
 * classify() is pure with respect to the database (dedup.js's own doc comment): its ambiguous
 * branches (4-ambiguous `url_reuse`, `branch1_conflict`) can match a row that is CURRENTLY the sole
 * live (duplicate_of IS NULL) holder of the same url_normalized or (source, external_id) key WITHOUT
 * setting decision.rootId -- an ambiguous outcome means "queue this for a human", not "merge it", so
 * classify() correctly leaves target/rootId unset. But the partial unique indexes
 * (sql/unique_indexes.sql: ic_job_listings_url_norm_uniq, ic_job_listings_source_ext_uniq) allow at
 * most one duplicate_of-NULL row per key, so inserting a second one for the SAME key throws 23505 and,
 * uncaught, aborted the whole source (observed on gmail: scan #2112, source_failed, err_code 23505 --
 * a gmail-sourced listing whose title/description didn't corroborate an existing row well enough for
 * the safe sameExternalId/contentMatch cross-source-dup path landed in url_reuse instead, then failed
 * to insert). ON CONFLICT DO NOTHING turns that failure into a no-op INSTEAD OF an error (a real 23505
 * would abort the enclosing SAVEPOINT, leaving no clean way to run the recovery query below in the
 * same transaction) so the fallback can run: find whichever row currently holds the colliding key and
 * anchor duplicate_of to it, exactly the way cross_source_dup already does
 * (target.duplicate_of ?? target.id). This is a persistence-layer fallback, not a reclassification --
 * the outcome/branch/reason recorded on the run item and the review-queue entry are unchanged (still
 * 'ambiguous' / 'url_reuse' / 'branch1_conflict'), so a human still resolves it via
 * review({resolution:'merge'|'separate'}); review.js's own uniqueConflict() check already anticipates
 * exactly this shape (a candidate whose key is still live elsewhere blocks 'separate' with
 * separate_blocked_unique and a merge hint), so the loop closes correctly however the human resolves
 * it. Only the two partial indexes above exist on this table (no other unique constraint), so a
 * conflict this fallback cannot explain is a genuine defect worth surfacing loudly rather than papering
 * over.
 * @param {import('pg').ClientBase} client
 * @param {import('./normalize.js').NormalizedListing} rec
 * @param {import('./dedup.js').Decision} decision
 * @param {ApplyContext} ctx
 * @returns {Promise<{ id: number, conflictAnchor: number|null }>} new id, plus the live row it had to
 *   anchor duplicate_of to when the primary insert hit a unique conflict (null on the common path)
 */
export async function insertListing(client, rec, decision, ctx) {
  const status = decision.outcome === 'ambiguous' ? 'review' : decision.inherit?.status ?? null;
  const now = ctx.now ?? new Date();
  /** @param {number|null} duplicateOf */
  const insertOnce = (duplicateOf) => client.query(
    `INSERT INTO ic_job_listings
       (title, company, status, ad_date, url, notes, record_kind, source, external_id, url_normalized, dedup_hash,
        company_norm, title_norm, location, location_norm, remote_mode, remote_declared, salary_min, salary_max, salary_raw,
        posted_at, first_seen, last_seen, times_seen, absent_runs, last_page_index, profile_rev, description, description_hash,
        search_profile, prescore, prescore_raw, noise_class, detail_skipped, duplicate_of, repost_of, embedding, salary_period)
     VALUES
       ($1,$2,$3,$4,$5,NULL,'listing',$6,$7,$8,$9,
        $10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$20,1,0,$21,$22,$23,$24,
        $25,$26,$27,$28,$29,$30,$31,$32::vector,$33)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      rec.title, rec.company, status, rec.posted_at, rec.url_normalized,
      rec.source, rec.external_id, rec.url_normalized, rec.dedup_hash,
      rec.company_norm, rec.title_norm, rec.location, rec.location_norm, rec.remote_mode, rec.remote_declared, rec.salary_min, rec.salary_max, rec.salary_raw,
      rec.posted_at, now, ctx.pageIndex ?? null, ctx.profileRev ?? null, rec.description, rec.description_hash,
      ctx.searchProfile ?? null, ctx.prescore ?? null, ctx.prescoreRaw ?? null, ctx.noiseClass ?? null, Boolean(ctx.detailSkipped), duplicateOf, decision.repostOf, ctx.embedding ?? null,
      rec.salary_period ?? null,
    ],
  );

  let r = await insertOnce(decision.rootId);
  let conflictAnchor = null;
  if (r.rowCount === 0) {
    const conflict = await client.query(
      `SELECT id, duplicate_of FROM ic_job_listings
       WHERE duplicate_of IS NULL AND (
         ($1::text IS NOT NULL AND source = $2 AND external_id = $1)
         OR ($3::text IS NOT NULL AND url_normalized = $3))
       ORDER BY id LIMIT 1`,
      [rec.external_id, rec.source, rec.url_normalized],
    );
    if (conflict.rowCount === 0) {
      throw new JobSearchError('INTERNAL', 'insertListing: unique conflict with no resolvable live row', {
        details: { source: rec.source, external_id: rec.external_id, url_normalized: rec.url_normalized },
      });
    }
    const anchor = conflict.rows[0];
    conflictAnchor = anchor.duplicate_of ?? anchor.id;
    r = await insertOnce(conflictAnchor);
    if (r.rowCount === 0) {
      throw new JobSearchError('INTERNAL', 'insertListing: unique conflict persisted after anchoring to the live conflict row', {
        details: { source: rec.source, external_id: rec.external_id, url_normalized: rec.url_normalized, anchor: anchor.id },
      });
    }
  }
  return { id: r.rows[0].id, conflictAnchor };
}

/**
 * Same-listing update (1a/1b) or repost-same-id. Never touches fit_score or
 * notes; status changes only via inheritance on repost-same-id.
 * @param {import('pg').ClientBase} client
 * @param {import('./normalize.js').NormalizedListing} rec
 * @param {import('./dedup.js').Decision} decision
 * @param {ApplyContext} ctx
 * @param {{ bumpTimesSeen: boolean }} flags
 */
export async function updateListing(client, rec, decision, ctx, flags) {
  const target = /** @type {import('./dedup.js').ListingRow} */ (decision.target);
  const now = ctx.now ?? new Date();
  const repost = decision.branch === '1a-repost-same-id' || decision.branch === '1b-repost-same-url';
  const inheritedStatus = repost && decision.inherit && decision.inherit.status !== null ? decision.inherit.status : null;
  await client.query(
    `UPDATE ic_job_listings SET
       last_seen = $2,
       times_seen = times_seen + $3,
       salary_min = coalesce($4, salary_min),
       salary_max = coalesce($5, salary_max),
       salary_raw = coalesce($6, salary_raw),
       description = coalesce($7, description),
       description_hash = coalesce($8, description_hash),
       posted_at = coalesce($9, posted_at),
       last_page_index = coalesce($10, last_page_index),
       profile_rev = coalesce($11, profile_rev),
       prescore = coalesce($12, prescore),
       prescore_raw = coalesce($15, prescore_raw),
       noise_class = coalesce($16, noise_class),
       detail_skipped = coalesce($17, detail_skipped),
       salary_period = coalesce($18, salary_period),
       expired_at = CASE WHEN $13 THEN NULL ELSE expired_at END,
       absent_runs = CASE WHEN $13 THEN 0 ELSE absent_runs END,
       stale = CASE WHEN $13 THEN false ELSE stale END,
       status = CASE WHEN $14::text IS NOT NULL THEN $14 ELSE status END
     WHERE id = $1`,
    [
      target.id, now, flags.bumpTimesSeen ? 1 : 0, rec.salary_min, rec.salary_max, rec.salary_raw, rec.description, rec.description_hash,
      rec.posted_at, ctx.pageIndex ?? null, ctx.profileRev ?? null, ctx.prescore ?? null, repost, inheritedStatus,
      ctx.prescoreRaw ?? null, ctx.noiseClass ?? null, typeof ctx.detailSkipped === 'boolean' ? ctx.detailSkipped : null,
      rec.salary_period ?? null,
    ],
  );
  return target.id;
}

/**
 * Scan-time sticky-skip auto-merge (sticky-skip spec part B). Only ever consulted from applyDecision's
 * NEW-LISTING path below (never the same-row update path, 1a/1b -- those never insert a "new listing"
 * at all, they reactivate the same DB row in place). Called ONLY when `decision.queue` is true: that is
 * exactly "a new listing would otherwise create a queue row (any reason)", classify()'s own total
 * classification of when a queue row is required.
 *
 * Gathers every id classify() already surfaced as related to this record -- `decision.matches`, plus
 * `decision.rootId`/`decision.repostOf`/`decision.target?.id` when set -- resolves each to its true
 * root (one hop via duplicate_of; the no-chains invariant means one hop is always enough), and for
 * every DISTINCT root runs MATCH-TEST(rec, root) + SURFACE-EXCEPTION(rec, root) + STICKY-ELIGIBLE(root).
 * The lowest-id qualifying root wins (spec: "auto-merge ... into the lowest-id such root"). Returns
 * null when no root qualifies, so the caller's ordinary queued path runs unchanged.
 *
 * No table scan: this only ever looks at ids classify() already found via its own indexed lookups, so
 * it adds at most a handful of point queries to an already-queued candidate, never a new search.
 * @param {import('pg').ClientBase} client
 * @param {import('./normalize.js').NormalizedListing} rec
 * @param {import('./dedup.js').Decision} decision
 * @returns {Promise<{ id: number, status: string }|null>}
 */
export async function findStickySkipRoot(client, rec, decision) {
  if (!decision.queue) return null;
  /** @type {Set<number>} */
  const pool = new Set((decision.matches ?? []).filter((n) => typeof n === 'number'));
  if (decision.rootId != null) pool.add(decision.rootId);
  if (decision.repostOf != null) pool.add(decision.repostOf);
  if (decision.target?.id != null) pool.add(decision.target.id);
  if (pool.size === 0) return null;

  const matched = await client.query('SELECT id, duplicate_of FROM ic_job_listings WHERE id = ANY($1::int[])', [[...pool]]);
  /** @type {Set<number>} */
  const rootIds = new Set();
  for (const row of matched.rows) rootIds.add(row.duplicate_of != null ? Number(row.duplicate_of) : Number(row.id));
  if (rootIds.size === 0) return null;

  const roots = await client.query(
    `SELECT id, status, source, url_normalized, title_norm, company_norm, location_norm, salary_max, apply_url
     FROM ic_job_listings WHERE id = ANY($1::int[]) AND duplicate_of IS NULL`,
    [[...rootIds]],
  );

  const cand = {
    url_normalized: rec.url_normalized ?? null,
    url_kind: rec.url_kind ?? null,
    source: rec.source ?? null,
    title_norm: rec.title_norm ?? null,
    company_norm: rec.company_norm ?? null,
    location_norm: rec.location_norm ?? null,
    salary_max: rec.salary_max ?? null,
    apply_url: /** @type {string|null} */ (null), // an incoming scan record never carries a resolved apply_url of its own
  };

  /** @type {{ id: number, status: string }[]} */
  const eligible = [];
  for (const root of roots.rows) {
    if (!matchTest(cand, root)) continue;
    if (surfaceException(cand, root)) continue;
    // eslint-disable-next-line no-await-in-loop -- root pool is small (classify()'s own match sets), sequential is fine and keeps this readable
    const isEligible = await stickyEligibleFor(client, root.id, root.status);
    if (isEligible) eligible.push({ id: Number(root.id), status: String(root.status) });
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.id - b.id);
  return eligible[0];
}

/**
 * Sticky-skip check for the SAME-ROW repost branches (1a-repost-same-id, 1b-repost-same-url):
 * classify() has already established identity via an EXACT (source, external_id) or url_normalized
 * match, so unlike findStickySkipRoot() above (which is fed a pool of near-miss candidates and must
 * filter them with matchTest()), no MATCH-TEST is needed here -- only STICKY-ELIGIBLE(root) and
 * SURFACE-EXCEPTION(rec, root), mirroring resolveItem's own reasoning (spec part A) that an
 * already-established identity does not need to be re-verified, only gated on eligibility and the
 * surface exception.
 * @param {import('pg').ClientBase} client
 * @param {import('./normalize.js').NormalizedListing} rec
 * @param {number} targetId decision.target.id for the 1a/1b branch
 * @returns {Promise<{ id: number, status: string }|null>}
 */
export async function findStickySkipRootForSameRow(client, rec, targetId) {
  const t = (await client.query('SELECT id, duplicate_of FROM ic_job_listings WHERE id = $1', [targetId])).rows[0];
  if (!t) return null;
  const rootId = t.duplicate_of != null ? Number(t.duplicate_of) : Number(t.id);
  const root = (await client.query(
    `SELECT id, status, source, url_normalized, title_norm, company_norm, location_norm, salary_max, apply_url
     FROM ic_job_listings WHERE id = $1`,
    [rootId],
  )).rows[0];
  if (!root || !isStickyStatus(root.status)) return null;
  const cand = {
    url_normalized: rec.url_normalized ?? null,
    source: rec.source ?? null,
    title_norm: rec.title_norm ?? null,
    company_norm: rec.company_norm ?? null,
    location_norm: rec.location_norm ?? null,
    salary_max: rec.salary_max ?? null,
    apply_url: /** @type {string|null} */ (null), // an incoming scan record never carries a resolved apply_url of its own
  };
  if (surfaceException(cand, root)) return null;
  const eligible = await stickyEligibleFor(client, root.id, root.status);
  return eligible ? { id: Number(root.id), status: String(root.status) } : null;
}

/**
 * Persist one classify() decision. Runs inside a SAVEPOINT.
 * @param {import('pg').ClientBase} client
 * @param {import('./normalize.js').NormalizedListing} rec
 * @param {import('./dedup.js').Decision} decision
 * @param {ApplyContext} ctx
 * @returns {Promise<{ id: number, outcome: string, queued: number|null, branch: string, status: string|null, stickySkipMerged?: boolean, stickySkipRootId?: number|null }>}
 */
export async function applyDecision(client, rec, decision, ctx) {
  return withSavepoint(client, async (c) => {
    /** @type {number} */
    let id;
    /** @type {number|null} */
    let queued = null;
    if (decision.outcome === 'update' || decision.branch === '1a-repost-same-id' || decision.branch === '1b-repost-same-url') {
      const target = /** @type {import('./dedup.js').ListingRow} */ (decision.target);
      const first = await recordRunItem(c, ctx.runId, target.id, rec.source, decision.outcome, ctx.pageIndex ?? null);
      const repostBranch = decision.branch === '1a-repost-same-id' || decision.branch === '1b-repost-same-url';
      // Sticky-skip check for the SAME-ROW repost branches (spec part B, independent-review fix): a
      // human-skipped/passed/lost listing reappearing under the identical external_id or url_normalized
      // is exactly "a later sighting of the same real-world posting" -- only gated when this row would
      // otherwise queue (decision.queue is Boolean(inheritStatus(target.status).queueReason), the same
      // total-classification trigger findStickySkipRoot() uses for the new-listing path above).
      let stickyRoot = null;
      if (repostBranch && decision.queue && decision.reason) {
        stickyRoot = await findStickySkipRootForSameRow(c, rec, target.id);
      }
      const effective = stickyRoot
        ? { ...decision, inherit: { status: stickyRoot.status, queueReason: null }, queue: false, reason: null }
        : decision;
      id = await updateListing(c, rec, effective, ctx, { bumpTimesSeen: first });
      if (effective.queue && effective.reason) {
        queued = await enqueueReview(c, { runId: ctx.runId, candidate: candidateSnapshot(rec), candidateId: id, matches: effective.matches, reason: effective.reason, statusAtCreate: target.status ?? null });
      }
      if (stickyRoot) {
        await recordEvent(c, {
          listingId: id, kind: 'status', fromStatus: target.status ?? null, toStatus: stickyRoot.status, note: 'sticky skip', actor: 'auto', runId: ctx.runId ?? null, at: ctx.now ?? new Date(),
        });
      }
      const status = repostBranch && effective.inherit && effective.inherit.status !== null ? effective.inherit.status : (target.status ?? null);
      return {
        id, outcome: decision.outcome, queued, branch: decision.branch, status, stickySkipMerged: Boolean(stickyRoot), stickySkipRootId: stickyRoot?.id ?? null,
      };
    }

    // New-listing path: outcome new / ambiguous / cross_source_dup / repost (branch 3-repost or
    // 6-state-remote-dup all insert a fresh row anchored to their match; 1a/1b above never reach here).
    // Sticky-skip check (spec part B) runs only when this candidate would otherwise create a queue row.
    let effective = decision;
    let stickyRoot = null;
    if (decision.queue && decision.reason) {
      stickyRoot = await findStickySkipRoot(c, rec, decision);
      if (stickyRoot) {
        effective = {
          ...decision,
          outcome: 'cross_source_dup',
          rootId: stickyRoot.id,
          repostOf: null,
          inherit: { status: stickyRoot.status, queueReason: null },
          queue: false,
          reason: null,
        };
      }
    }

    const inserted = await insertListing(c, rec, effective, ctx);
    id = inserted.id;
    await recordRunItem(c, ctx.runId, id, rec.source, effective.outcome, ctx.pageIndex ?? null);
    if (effective.queue && effective.reason) {
      const statusAtCreate = effective.outcome === 'ambiguous' ? 'review' : effective.inherit?.status ?? null;
      queued = await enqueueReview(c, { runId: ctx.runId, candidate: candidateSnapshot(rec), candidateId: id, matches: effective.matches, reason: effective.reason, statusAtCreate });
    } else if (inserted.conflictAnchor !== null) {
      // Defense in depth: classify() should never hand back a non-queued decision whose key
      // physically collided with a live row (only the ambiguous url_reuse / branch1_conflict
      // branches do that, and both already set queue+reason -- see insertListing's doc comment).
      // If some other decision shape ever reaches here, insertListing still had to auto-anchor
      // duplicate_of to avoid a 23505 crash; that anchoring must never happen silently, so it gets
      // its own review-queue entry even though the decision itself didn't ask for one. (A sticky-skip
      // merge's `effective.rootId` is a real, already-verified root, so this branch is not expected to
      // ever fire for a sticky-merged row -- included anyway as the same defense-in-depth net.)
      const statusAtCreate = effective.outcome === 'ambiguous' ? 'review' : effective.inherit?.status ?? null;
      queued = await enqueueReview(c, { runId: ctx.runId, candidate: candidateSnapshot(rec), candidateId: id, matches: [inserted.conflictAnchor], reason: 'insert_conflict_auto_anchored', statusAtCreate });
    }
    if (stickyRoot) {
      await recordEvent(c, {
        listingId: id, kind: 'status', fromStatus: null, toStatus: stickyRoot.status, note: 'sticky skip', actor: 'auto', runId: ctx.runId ?? null, at: ctx.now ?? new Date(),
      });
    }
    const status = effective.outcome === 'ambiguous' ? 'review' : effective.inherit?.status ?? null;
    return {
      id, outcome: effective.outcome, queued, branch: decision.branch, status, stickySkipMerged: Boolean(stickyRoot), stickySkipRootId: stickyRoot?.id ?? null,
    };
  });
}

/**
 * Adopt rows inserted by the Python tools (no dedup_hash): normalize, classify
 * against the rest of the table, set posted_at=ad_date. Unique violations
 * roll back to the savepoint and queue `adopt_url_conflict`. Ambiguous or
 * duplicate classifications queue `adopt_<reason>` without changing the
 * row's human-set status. Never throws for a single bad row.
 *
 * Caller owns the transaction (BEGIN before, COMMIT after).
 * @param {import('pg').ClientBase} client
 * @param {{ runId?: number|null, lookups?: import('./dedup.js').Lookups, classifyOpts?: import('./dedup.js').ClassifyOptions, limit?: number }} [opts]
 * @returns {Promise<{ adopted: number, queued: number, failed: number, ids: number[] }>}
 */
export async function adoptUnclassifiedRows(client, opts = {}) {
  const lookups = opts.lookups ?? makePgLookups(client);
  const limit = opts.limit ?? 500;
  const pending = await client.query(
    `SELECT id, title, company, status, url, ad_date FROM ic_job_listings
     WHERE dedup_hash IS NULL AND coalesce(record_kind,'listing') = 'listing' ORDER BY id LIMIT $1`,
    [limit],
  );
  let adopted = 0;
  let queued = 0;
  let failed = 0;
  /** @type {number[]} */
  const ids = [];
  for (const row of pending.rows) {
    const n = normalizeLegacyRow({ id: row.id, title: row.title, company: row.company, url: row.url, source: null });
    /** @type {import('./normalize.js').NormalizedListing} */
    const rec = {
      source: n.source,
      external_id: n.external_id,
      url_normalized: n.url_normalized,
      url_kind: n.url_kind,
      title: row.title,
      company: row.company,
      title_norm: n.title_norm,
      company_norm: n.company_norm,
      company_note: n.company_note,
      location: n.location,
      location_norm: n.location_norm,
      remote_mode: null,
      remote_declared: false,
      dedup_hash: n.dedup_hash,
      description: null,
      description_hash: null,
      posted_at: row.ad_date ? new Date(row.ad_date).toISOString().slice(0, 10) : null,
      salary_raw: null,
      salary_min: null,
      salary_max: null,
      salary_period: 'unknown',
    };
    try {
      const noiseClass = classifyNoise(rec);
      await withSavepoint(client, async (c) => {
        await c.query(
          `UPDATE ic_job_listings SET source=$2, external_id=$3, url_normalized=$4, company_norm=$5, title_norm=$6,
             location_norm=$7, dedup_hash=$8, location=coalesce(location,$9), posted_at=coalesce(posted_at, ad_date), noise_class=$10
           WHERE id=$1`,
          [row.id, n.source, n.external_id, n.url_normalized, n.company_norm, n.title_norm, n.location_norm, n.dedup_hash, n.location, noiseClass],
        );
      });
      adopted++;
      ids.push(row.id);
      const decision = await classify(rec, lookups, { ...(opts.classifyOpts ?? {}), excludeId: row.id });
      if (decision.outcome !== 'new' || decision.queue) {
        const exists = await client.query(`SELECT id FROM ic_job_review_queue WHERE resolved_at IS NULL AND candidate_id=$1`, [row.id]);
        if (exists.rowCount === 0) {
          await enqueueReview(client, {
            runId: opts.runId ?? null,
            candidate: candidateSnapshot(rec),
            candidateId: row.id,
            matches: decision.matches,
            reason: `adopt_${decision.reason ?? decision.outcome}`,
            statusAtCreate: row.status ?? null,
          });
          queued++;
        }
      }
    } catch (err) {
      failed++;
      if (isUniqueViolation(err)) {
        const exists = await client.query(`SELECT id FROM ic_job_review_queue WHERE resolved_at IS NULL AND candidate_id=$1 AND reason='adopt_url_conflict'`, [row.id]);
        if (exists.rowCount === 0) {
          await enqueueReview(client, { runId: opts.runId ?? null, candidate: candidateSnapshot(rec), candidateId: row.id, matches: [], reason: 'adopt_url_conflict', statusAtCreate: row.status ?? null });
          queued++;
        }
      }
      // Any other error: savepoint already rolled back; row stays unadopted for the next run.
    }
  }
  return { adopted, queued, failed, ids };
}

/**
 * Fetch one listing row with the dedup columns (helper for tools/tests).
 * @param {import('pg').ClientBase} client
 * @param {number} id
 */
export async function getListingRow(client, id) {
  const r = await client.query(`SELECT ${LISTING_COLUMNS.join(', ')} FROM ic_job_listings WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}
