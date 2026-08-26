// @ts-check
/**
 * review (spec section 3.2 and 5): list open review-queue items and resolve
 * them as merge | separate | repost.
 *
 *   merge     candidate becomes duplicate_of the target's ROOT; every row
 *             that pointed at the candidate (or at the old root) is re-pointed
 *             to the new root in the same transaction. No chains, ever.
 *   separate  pre-checks the unique partial indexes; on conflict the item
 *             stays queued with reason separate_blocked_unique and a merge hint.
 *   repost    candidate.repost_of = target root, status inherited.
 *
 * Auto-resolve: open items older than reviewAutoSeparateDays whose candidate
 * status still equals status_at_create are separated when `list` runs.
 */
import { z } from 'zod';
import { inheritStatus } from '../core/dedup.js';
import { JobSearchError } from '../core/errors.js';
import { truncate } from '../core/compact.js';

export const schema = {
  action: z.enum(['list', 'resolve']),
  limit: z.number().int().min(1).max(25).default(25),
  queue_id: z.number().int().positive().optional(),
  resolution: z.enum(['merge', 'separate', 'repost']).optional(),
  target_id: z.number().int().positive().optional().describe('listing id to merge into / mark as repost of; defaults to the first match'),
};

/**
 * Root of a listing (follows one hop; the invariant is that no chains exist).
 * @param {import('pg').ClientBase} c
 * @param {number} id
 */
async function rootOf(c, id) {
  const r = await c.query('SELECT id, duplicate_of, status FROM ic_job_listings WHERE id = $1', [id]);
  if (r.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${id} not found`);
  const row = r.rows[0];
  if (row.duplicate_of == null) return row;
  const p = await c.query('SELECT id, duplicate_of, status FROM ic_job_listings WHERE id = $1', [row.duplicate_of]);
  return p.rows[0] ?? row;
}

/**
 * Would separating this candidate violate a unique partial index?
 * @param {import('pg').ClientBase} c
 * @param {{ id: number, source: string|null, external_id: string|null, url_normalized: string|null }} cand
 */
async function uniqueConflict(c, cand) {
  const r = await c.query(
    `SELECT id FROM ic_job_listings WHERE id <> $1 AND duplicate_of IS NULL AND (
       ($2::text IS NOT NULL AND source = $3 AND external_id = $2) OR ($4::text IS NOT NULL AND url_normalized = $4)) LIMIT 5`,
    [cand.id, cand.external_id, cand.source, cand.url_normalized],
  );
  return r.rows.map((x) => Number(x.id));
}

/**
 * Resolve one queue item. Runs inside the caller's transaction. Exported for tests.
 * @param {import('pg').ClientBase} c
 * @param {{ queueId: number, resolution: 'merge'|'separate'|'repost', targetId?: number|null, now?: Date, auto?: boolean }} r
 */
export async function resolveItem(c, r) {
  const now = r.now ?? new Date();
  const q = await c.query('SELECT id, candidate_id, matches, reason, resolved_at, status_at_create FROM ic_job_review_queue WHERE id = $1 FOR UPDATE', [r.queueId]);
  if (q.rowCount === 0) throw new JobSearchError('NOT_FOUND', `queue item ${r.queueId} not found`);
  const item = q.rows[0];
  if (item.resolved_at) throw new JobSearchError('VALIDATION', `queue item ${r.queueId} already resolved`);
  if (item.candidate_id == null) {
    await c.query(`UPDATE ic_job_review_queue SET resolution = 'separate', resolved_at = $2 WHERE id = $1`, [item.id, now]);
    return { queue_id: item.id, resolution: 'separate', candidate_id: null, note: 'no candidate row; closed' };
  }
  const cand = (await c.query('SELECT id, source, external_id, url_normalized, status, duplicate_of, repost_of FROM ic_job_listings WHERE id = $1 FOR UPDATE', [item.candidate_id])).rows[0];
  if (!cand) throw new JobSearchError('NOT_FOUND', `candidate ${item.candidate_id} missing`);
  const matches = /** @type {number[]} */ (item.matches ?? []).filter((m) => m !== cand.id);

  if (r.resolution === 'separate') {
    const conflicts = await uniqueConflict(c, cand);
    if (conflicts.length) {
      await c.query(`UPDATE ic_job_review_queue SET reason = 'separate_blocked_unique', matches = $2::int[] WHERE id = $1`, [item.id, conflicts]);
      return { queue_id: item.id, resolution: null, blocked: 'separate_blocked_unique', conflicts, hint: `review({action:'resolve', queue_id:${item.id}, resolution:'merge', target_id:${conflicts[0]}})` };
    }
    const newStatus = cand.status === 'review' ? null : cand.status;
    await c.query('UPDATE ic_job_listings SET status = $2 WHERE id = $1', [cand.id, newStatus]);
    await c.query(`UPDATE ic_job_review_queue SET resolution = 'separate', resolved_at = $2 WHERE id = $1`, [item.id, now]);
    return { queue_id: item.id, resolution: 'separate', candidate_id: cand.id, status: newStatus, auto: Boolean(r.auto) };
  }

  const targetId = r.targetId ?? matches[0] ?? null;
  if (!targetId) throw new JobSearchError('VALIDATION', 'target_id is required (the queue item has no matches)');
  if (targetId === cand.id) throw new JobSearchError('VALIDATION', 'target_id must differ from the candidate');
  const root = await rootOf(c, targetId);
  if (root.id === cand.id) throw new JobSearchError('VALIDATION', 'target resolves to the candidate itself');
  const inh = inheritStatus(root.status);

  if (r.resolution === 'merge') {
    // Re-point everything hanging off the candidate to the new root, then the candidate itself. No chains.
    await c.query('UPDATE ic_job_listings SET duplicate_of = $2 WHERE duplicate_of = $1 AND id <> $2', [cand.id, root.id]);
    await c.query('UPDATE ic_job_listings SET duplicate_of = $2, status = $3 WHERE id = $1', [cand.id, root.id, inh.status]);
    // Any row that pointed at a former root that is now itself a duplicate gets re-pointed too (defensive; keeps the no-chain invariant).
    await c.query(
      `UPDATE ic_job_listings x SET duplicate_of = p.duplicate_of FROM ic_job_listings p
       WHERE x.duplicate_of = p.id AND p.duplicate_of IS NOT NULL`,
    );
    await c.query(`UPDATE ic_job_review_queue SET resolution = 'merge', resolved_at = $2 WHERE id = $1`, [item.id, now]);
    // Other open items for the same candidate are closed with the same resolution.
    await c.query(`UPDATE ic_job_review_queue SET resolution = 'merge', resolved_at = $2 WHERE candidate_id = $1 AND resolved_at IS NULL`, [cand.id, now]);
    return { queue_id: item.id, resolution: 'merge', candidate_id: cand.id, root_id: root.id, status: inh.status };
  }

  // repost
  await c.query('UPDATE ic_job_listings SET repost_of = $2, status = $3 WHERE id = $1', [cand.id, root.id, inh.status]);
  await c.query(`UPDATE ic_job_review_queue SET resolution = 'repost', resolved_at = $2 WHERE id = $1`, [item.id, now]);
  if (inh.queueReason) {
    await c.query(
      `INSERT INTO ic_job_review_queue (run_id, candidate, candidate_id, matches, reason, status_at_create) VALUES (NULL, NULL, $1, $2::int[], $3, $4)`,
      [cand.id, [root.id], inh.queueReason, inh.status],
    );
  }
  return { queue_id: item.id, resolution: 'repost', candidate_id: cand.id, repost_of: root.id, status: inh.status };
}

/**
 * Auto-separate stale items (spec 3.2). Exported for tests.
 * @param {import('pg').ClientBase} c
 * @param {number} days
 * @param {Date} [now]
 */
export async function autoSeparate(c, days, now = new Date()) {
  const stale = await c.query(
    `SELECT q.id FROM ic_job_review_queue q JOIN ic_job_listings l ON l.id = q.candidate_id
     WHERE q.resolved_at IS NULL AND q.created_at < $1::timestamptz - make_interval(days => $2)
       AND l.status IS NOT DISTINCT FROM q.status_at_create AND q.reason <> 'separate_blocked_unique'
     ORDER BY q.id LIMIT 100`,
    [now, days],
  );
  let n = 0;
  for (const row of stale.rows) {
    const r = await resolveItem(c, { queueId: row.id, resolution: 'separate', now, auto: true });
    if (r.resolution === 'separate') n++;
  }
  return n;
}

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'review',
  description: 'List open dedup review items (#q | reason | candidate | matches) or resolve one as merge (into target root, no chains), separate (pre-checks unique conflicts), or repost.',
  schema,
  async handler(a, deps) {
    const days = deps.config ? deps.config.adapters.dedup.reviewAutoSeparateDays : 30;
    if (a.action === 'list') {
      return deps.withClient(async (c) => {
        await c.query('BEGIN');
        let autoN = 0;
        try {
          autoN = await autoSeparate(c, days);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
        const total = await c.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE resolved_at IS NULL');
        const r = await c.query(
          `SELECT q.id, q.reason, q.matches, q.created_at, q.candidate_id, l.title, l.company, l.source, l.status
           FROM ic_job_review_queue q LEFT JOIN ic_job_listings l ON l.id = q.candidate_id
           WHERE q.resolved_at IS NULL ORDER BY q.created_at ASC, q.id ASC LIMIT $1`,
          [a.limit],
        );
        const rows = r.rows.map((x) => truncate(
          `#q${x.id} | ${x.reason} | #${x.candidate_id ?? '?'} ${x.title ?? ''} @ ${x.company ?? ''} | ${x.source ?? ''} | matches ${(x.matches ?? []).join(',') || '-'} | ${new Date(x.created_at).toISOString().slice(0, 10)}`,
          120,
        ));
        return { ok: true, total: total.rows[0].n, rows, auto_separated: autoN, hint: "review({action:'resolve', queue_id, resolution:'merge'|'separate'|'repost', target_id?})" };
      });
    }
    if (!a.queue_id || !a.resolution) throw new JobSearchError('VALIDATION', 'queue_id and resolution are required');
    return deps.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const out = await resolveItem(c, { queueId: a.queue_id, resolution: a.resolution, targetId: a.target_id ?? null });
        await c.query('COMMIT');
        return { ok: true, ...out };
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
  },
};
