// @ts-check
/**
 * Listing event log (dashboard PR 1, sql/009_pipeline_events_documents.sql). Every status/note/fit
 * change, manual creation, document link, follow-up action, and reply gets one row here, so the
 * dashboard (and any other caller, including the MCP tools) can render a listing's history without
 * re-deriving it from ic_scan_run_items timestamps or mark_meta alone.
 *
 * kind and actor are both closed, total classifications (matching the CHECK constraints in
 * sql/009_pipeline_events_documents.sql): a value outside either list throws VALIDATION here, before
 * the round trip, rather than being silently coerced or left to the database to reject.
 */
import { JobSearchError } from './errors.js';

export const EVENT_KINDS = Object.freeze(['status', 'note', 'fit', 'created', 'document', 'followup', 'reply', 'migrated']);
export const EVENT_ACTORS = Object.freeze(['dashboard', 'mcp', 'cli', 'migration', 'seed']);

const COLS = 'id, listing_id, at, kind, from_status, to_status, note, actor, run_id';

/**
 * @typedef {Object} JobEventRow
 * @property {number} id
 * @property {number} listing_id
 * @property {Date} at
 * @property {'status'|'note'|'fit'|'created'|'document'|'followup'|'reply'|'migrated'} kind
 * @property {string|null} from_status
 * @property {string|null} to_status
 * @property {string|null} note
 * @property {'dashboard'|'mcp'|'cli'|'migration'|'seed'} actor
 * @property {number|null} run_id
 */

/**
 * @typedef {Object} RecordEventInput
 * @property {number} listingId
 * @property {'status'|'note'|'fit'|'created'|'document'|'followup'|'reply'|'migrated'} kind
 * @property {string|null} [fromStatus]
 * @property {string|null} [toStatus]
 * @property {string|null} [note]
 * @property {'dashboard'|'mcp'|'cli'|'migration'|'seed'} [actor] default 'mcp'
 * @property {number|null} [runId]
 * @property {Date} [at] default now() (server clock)
 */

/**
 * Insert one event row. Runs on whatever client/transaction the caller passes in (mark_jobs.js and
 * review.js call this inside their own BEGIN/COMMIT block so the event and the row change commit or
 * roll back together).
 * @param {import('pg').ClientBase} client
 * @param {RecordEventInput} input
 * @returns {Promise<JobEventRow>}
 */
export async function recordEvent(client, input) {
  if (!input || typeof input.listingId !== 'number') throw new JobSearchError('VALIDATION', 'recordEvent: listingId is required');
  if (!EVENT_KINDS.includes(input.kind)) throw new JobSearchError('VALIDATION', `event kind must be one of ${EVENT_KINDS.join(', ')}`);
  const actor = input.actor ?? 'mcp';
  if (!EVENT_ACTORS.includes(actor)) throw new JobSearchError('VALIDATION', `event actor must be one of ${EVENT_ACTORS.join(', ')}`);
  const r = await client.query(
    `INSERT INTO ic_job_events (listing_id, at, kind, from_status, to_status, note, actor, run_id)
     VALUES ($1, coalesce($2, now()), $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [input.listingId, input.at ?? null, input.kind, input.fromStatus ?? null, input.toStatus ?? null, input.note ?? null, actor, input.runId ?? null],
  );
  return r.rows[0];
}

/**
 * Events for one listing, most recent first (dashboard job-detail history timeline).
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<JobEventRow[]>}
 */
export async function listEvents(client, listingId, opts = {}) {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const r = await client.query(`SELECT ${COLS} FROM ic_job_events WHERE listing_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, [listingId, limit]);
  return r.rows;
}

/**
 * Events across every listing since a timestamp, most recent first (dashboard home "recent activity"
 * feed and the SSE 10 s watermark check for cross-process changes). `since` omitted (or null) returns
 * the most recent `limit` events with no lower bound.
 * @param {import('pg').ClientBase} client
 * @param {{ since?: Date|null, limit?: number }} [opts]
 * @returns {Promise<JobEventRow[]>}
 */
export async function recentEvents(client, opts = {}) {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  if (opts.since) {
    const r = await client.query(`SELECT ${COLS} FROM ic_job_events WHERE at > $1 ORDER BY at DESC, id DESC LIMIT $2`, [opts.since, limit]);
    return r.rows;
  }
  const r = await client.query(`SELECT ${COLS} FROM ic_job_events ORDER BY at DESC, id DESC LIMIT $1`, [limit]);
  return r.rows;
}
