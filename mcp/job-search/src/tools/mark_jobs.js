// @ts-check
/**
 * mark_jobs (spec section 5): batch status/fit/notes updates.
 *
 * Rules:
 *   - at most 25 items; each id must exist and be a listing.
 *   - re-embeds with the Python formula when title/company/notes text changed
 *     (notes are part of the embedding text).
 *   - an explicit mark on a row with an open review-queue item resolves that
 *     item as `separate` (the human's status wins) and records it.
 *   - propagation only to ids the caller names in propagateTo; a descendant
 *     whose status was set by an explicit mark (marked_at set) and differs
 *     from the incoming status is never overwritten: it is routed to review
 *     with reason propagation_conflict instead.
 */
import { z } from 'zod';
import { embedSafe, embeddingText } from '../core/embed.js';
import { enqueueReview } from '../core/upsert.js';
import { JobSearchError } from '../core/errors.js';

export const STATUSES = Object.freeze(['new', 'maybe', 'shortlisted', 'applied', 'skip', 'dead', 'review']);

export const schema = {
  items: z.array(z.object({
    id: z.number().int().positive(),
    status: z.enum(STATUSES).optional(),
    fit_score: z.number().int().min(0).max(100).optional(),
    notes: z.string().max(600).optional(),
  })).min(1).max(25),
  propagateTo: z.array(z.number().int().positive()).max(50).optional().describe('ids that receive the same status/fit (duplicates or reposts you name explicitly)'),
};

/**
 * Apply one mark inside the caller's transaction. Exported for tests.
 * @param {import('pg').ClientBase} c
 * @param {{ id: number, status?: string, fit_score?: number, notes?: string }} item
 * @param {{ now: Date, explicit: boolean, propagatedFrom?: number }} ctx
 * @returns {Promise<{ id: number, applied: boolean, routed_to_review: boolean, resolved_queue: number[], reembed: boolean }>}
 */
export async function applyMark(c, item, ctx) {
  const cur = await c.query(`SELECT id, title, company, notes, status, marked_at, coalesce(record_kind,'listing') AS record_kind FROM ic_job_listings WHERE id = $1 FOR UPDATE`, [item.id]);
  if (cur.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${item.id} not found`);
  const row = cur.rows[0];
  if (row.record_kind !== 'listing') throw new JobSearchError('VALIDATION', `row ${item.id} is a ${row.record_kind}, not a listing`);
  /** @type {number[]} */
  const resolvedQueue = [];
  if (!ctx.explicit && row.marked_at && item.status !== undefined && row.status !== item.status) {
    // Propagation may not overwrite an explicit mark without routing to review.
    await c.query(`UPDATE ic_job_listings SET status = 'review' WHERE id = $1`, [item.id]);
    await enqueueReview(c, {
      runId: null,
      candidate: null,
      candidateId: item.id,
      matches: ctx.propagatedFrom ? [ctx.propagatedFrom] : [],
      reason: 'propagation_conflict',
      statusAtCreate: row.status ?? null,
    });
    return { id: item.id, applied: false, routed_to_review: true, resolved_queue: [], reembed: false };
  }
  const sets = [];
  const params = /** @type {unknown[]} */ ([item.id]);
  const set = (/** @type {string} */ col, /** @type {unknown} */ v) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (item.status !== undefined) set('status', item.status);
  if (item.fit_score !== undefined) set('fit_score', item.fit_score);
  if (item.notes !== undefined) set('notes', item.notes);
  if (ctx.explicit) set('marked_at', ctx.now);
  if (sets.length === 0) return { id: item.id, applied: false, routed_to_review: false, resolved_queue: [], reembed: false };
  await c.query(`UPDATE ic_job_listings SET ${sets.join(', ')} WHERE id = $1`, params);
  if (ctx.explicit && item.status !== undefined && item.status !== 'review') {
    const q = await c.query(
      `UPDATE ic_job_review_queue SET resolution = 'separate', resolved_at = $2 WHERE candidate_id = $1 AND resolved_at IS NULL RETURNING id`,
      [item.id, ctx.now],
    );
    for (const r of q.rows) resolvedQueue.push(Number(r.id));
  }
  return { id: item.id, applied: true, routed_to_review: false, resolved_queue: resolvedQueue, reembed: item.notes !== undefined && item.notes !== (row.notes ?? '') };
}

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'mark_jobs',
  description: 'Set status, fit_score, and/or notes on up to 25 listings in one call. Re-embeds changed notes. Marking a row resolves its open review item as separate. propagateTo copies status/fit only to the ids you name.',
  schema,
  async handler(a, deps) {
    const now = new Date();
    const results = await deps.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        /** @type {Array<Awaited<ReturnType<typeof applyMark>>>} */
        const out = [];
        for (const item of a.items) out.push(await applyMark(c, item, { now, explicit: true }));
        if (a.propagateTo && a.propagateTo.length) {
          const first = a.items[0];
          const named = new Set(a.items.map((i) => i.id));
          for (const pid of a.propagateTo) {
            if (named.has(pid)) continue;
            out.push(await applyMark(c, { id: pid, status: first.status, fit_score: first.fit_score }, { now, explicit: false, propagatedFrom: first.id }));
          }
        }
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    // Re-embed rows whose notes changed (best effort; Ollama down leaves the old vector).
    const toEmbed = results.filter((r) => r.reembed).map((r) => r.id);
    let unembedded = 0;
    if (toEmbed.length) {
      const rows = await deps.withClient((c) => c.query('SELECT id, title, company, notes FROM ic_job_listings WHERE id = ANY($1::int[])', [toEmbed]));
      const texts = rows.rows.map((r) => embeddingText(r));
      const e = await embedSafe(texts, { ollamaUrl: deps.env.OLLAMA_URL, model: deps.env.OLLAMA_MODEL, fetch: deps.fetch });
      unembedded = e.unembedded;
      await deps.withClient(async (c) => {
        for (let i = 0; i < rows.rows.length; i++) {
          if (e.literals[i]) await c.query('UPDATE ic_job_listings SET embedding = $2::vector WHERE id = $1', [rows.rows[i].id, e.literals[i]]);
        }
      });
    }
    const warnings = unembedded ? [`${unembedded} rows not re-embedded (embedding service unavailable)`] : [];
    return { ok: true, results, warnings };
  },
};
