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
import { reembedRows } from '../core/reembed.js';
import { enqueueReview } from '../core/upsert.js';
import { JobSearchError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { PIPELINE_STATUSES } from '../core/statuses.js';

// PIPELINE_STATUSES is the single source of truth (dashboard PR 1, src/core/statuses.js); STATUSES is
// re-exported under its old name so existing importers of mark_jobs.js keep working unchanged.
export const STATUSES = PIPELINE_STATUSES;

export const schema = {
  items: z.array(z.object({
    id: z.number().int().positive(),
    status: z.enum(/** @type {[string, ...string[]]} */ (PIPELINE_STATUSES)).optional(),
    fit_score: z.number().int().min(0).max(100).optional(),
    notes: z.string().max(600).optional(),
  })).min(1).max(25),
  propagateTo: z.array(z.number().int().positive()).max(50).optional().describe('ids that receive the same status/fit (duplicates or reposts you name explicitly)'),
};

/**
 * Apply one mark inside the caller's transaction. Exported for tests.
 * @param {import('pg').ClientBase} c
 * @param {{ id: number, status?: string, fit_score?: number, notes?: string, statusNote?: string }} item
 *   statusNote (dashboard PR 2's POST /listings/:id/status {status, note}): text recorded on the status
 *   event itself, separate from the persistent `notes` column -- passing a status change annotation here
 *   never also writes a `note` event, so a status change with a `note` still writes exactly one event.
 * @param {{ now: Date, explicit: boolean, propagatedFrom?: number, actor?: 'dashboard'|'mcp'|'cli'|'migration'|'seed', runId?: number|null }} ctx
 *   actor defaults to 'mcp' (dashboard PR 2 passes 'dashboard' for its own mutating requests).
 * @returns {Promise<{ id: number, applied: boolean, routed_to_review: boolean, resolved_queue: number[], reembed: boolean }>}
 */
export async function applyMark(c, item, ctx) {
  const actor = ctx.actor ?? 'mcp';
  const cur = await c.query(`SELECT id, title, company, notes, status, fit_score, marked_at, coalesce(record_kind,'listing') AS record_kind FROM ic_job_listings WHERE id = $1 FOR UPDATE`, [item.id]);
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
    await recordEvent(c, { listingId: item.id, kind: 'status', fromStatus: row.status ?? null, toStatus: 'review', note: 'propagation_conflict', actor, runId: ctx.runId ?? null });
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
  // One event per field that actually changed (dashboard PR 1): a status change writes exactly one
  // 'status' event, never one per intermediate branch above -- the propagation-conflict path above
  // returns before reaching here, so this and that path are mutually exclusive per call.
  if (item.status !== undefined && item.status !== row.status) {
    await recordEvent(c, { listingId: item.id, kind: 'status', fromStatus: row.status ?? null, toStatus: item.status, note: item.statusNote ?? null, actor, runId: ctx.runId ?? null });
  }
  if (item.notes !== undefined && item.notes !== (row.notes ?? '')) {
    await recordEvent(c, { listingId: item.id, kind: 'note', note: item.notes, actor, runId: ctx.runId ?? null });
  }
  if (item.fit_score !== undefined && item.fit_score !== row.fit_score) {
    await recordEvent(c, { listingId: item.id, kind: 'fit', note: String(item.fit_score), actor, runId: ctx.runId ?? null });
  }
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
    const { warnings } = await reembedRows(deps, toEmbed);
    return { ok: true, results, warnings };
  },
};
