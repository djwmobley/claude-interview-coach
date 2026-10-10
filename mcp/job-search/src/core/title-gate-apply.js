// @ts-check
/**
 * Persistence side of the title gate (src/core/title-gate.js, which is pure): turn a 'drop' verdict into
 * status='skip', actor 'auto', for one listing. Shared by the scan ingest path (src/core/upsert.js
 * applyDecision) and bin/title-gate-backfill.js so both make exactly the same change.
 *
 * Same write shape as auto-triage's skip (src/core/triage.js -> applyMark with explicit:true, actor 'auto'):
 * status, marked_at, and one 'status' event whose note carries the reason. Written directly here instead of
 * through applyMark so src/core/upsert.js can import this module without a cycle through
 * src/tools/mark_jobs.js (which imports upsert.js).
 *
 * Protection is a total classification (titleGateBlock): every row maps to either null (the gate may
 * skip it) or one named reason it must be left alone. A row is never downgraded when it has an
 * application row, when its latest status event is by anyone but 'auto', or when it carries a status
 * with no event trail at all (provenance unknown, so treated as human).
 */
import { classifyTitle } from './title-gate.js';
import { recordEvent } from './events.js';

/** Note prefix on the status event; the reason and rule follow. Distinct from auto-triage's notes. */
export const TITLE_GATE_NOTE_PREFIX = 'title-gate: ';

/** Statuses the gate may overwrite ('review' only when no open review item exists for the row). */
const GATE_MAY_OVERWRITE = Object.freeze([null, 'new', 'maybe', 'shortlisted', 'review']);

/**
 * @typedef {Object} GateRowState
 * @property {string|null} status
 * @property {string|null} recordKind
 * @property {number|null} duplicateOf
 * @property {boolean} hasApplication any ic_job_applications row, whatever its state
 * @property {string|null} statusActor actor of the latest kind='status' event, or null when none
 * @property {boolean} hasOpenReview an unresolved ic_job_review_queue row names this listing as candidate
 */

/**
 * @param {GateRowState} s
 * @returns {string|null} null when the gate may skip the row, otherwise why it must be left alone
 */
export function titleGateBlock(s) {
  if ((s.recordKind ?? 'listing') !== 'listing') return 'not_listing';
  if (s.duplicateOf !== null && s.duplicateOf !== undefined) return 'duplicate';
  if (s.hasApplication) return 'has_application';
  if (s.status === 'skip') return 'already_skip';
  if (!GATE_MAY_OVERWRITE.includes(s.status ?? null)) return 'status';
  if (s.statusActor !== null && s.statusActor !== 'auto') return 'human_status';
  if (s.status !== null && s.status !== 'review' && s.statusActor === null) return 'status_no_event';
  if (s.status === 'review' && s.hasOpenReview) return 'open_review';
  return null;
}

const STATE_SQL = `
  SELECT l.id, l.title, l.status, coalesce(l.record_kind, 'listing') AS record_kind, l.duplicate_of,
    EXISTS (SELECT 1 FROM ic_job_applications a WHERE a.listing_id = l.id) AS has_application,
    (SELECT e.actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'status' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS status_actor,
    EXISTS (SELECT 1 FROM ic_job_review_queue q WHERE q.candidate_id = l.id AND q.resolved_at IS NULL) AS has_open_review
  FROM ic_job_listings l WHERE l.id = $1`;

/** @param {any} r @returns {GateRowState} */
function stateOf(r) {
  return {
    status: r.status ?? null,
    recordKind: r.record_kind ?? null,
    duplicateOf: r.duplicate_of === null || r.duplicate_of === undefined ? null : Number(r.duplicate_of),
    hasApplication: Boolean(r.has_application),
    statusActor: r.status_actor ?? null,
    hasOpenReview: Boolean(r.has_open_review),
  };
}

/**
 * Apply the title gate to one stored listing. Caller owns the transaction / savepoint. Locks the row
 * (FOR UPDATE on the listing only) so a human mark landing concurrently is either seen or waits.
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {{ now?: Date, runId?: number|null, dryRun?: boolean }} [ctx] dryRun classifies and reports without writing
 * @returns {Promise<{ applied: boolean, verdict: 'pass'|'drop'|'missing', reason: string|null, rule: string|null, blocked: string|null }>}
 */
export async function applyTitleGate(client, listingId, ctx = {}) {
  if (!ctx.dryRun) await client.query('SELECT id FROM ic_job_listings WHERE id = $1 FOR UPDATE', [listingId]);
  const cur = await client.query(STATE_SQL, [listingId]);
  if (cur.rowCount === 0) return { applied: false, verdict: 'missing', reason: null, rule: null, blocked: 'missing' };
  const row = cur.rows[0];
  const gate = classifyTitle(row.title);
  if (gate.verdict !== 'drop') return { applied: false, verdict: 'pass', reason: null, rule: gate.rule, blocked: null };
  const blocked = titleGateBlock(stateOf(row));
  if (blocked) return { applied: false, verdict: 'drop', reason: gate.reason, rule: gate.rule, blocked };
  if (ctx.dryRun) return { applied: false, verdict: 'drop', reason: gate.reason, rule: gate.rule, blocked: null };
  const now = ctx.now ?? new Date();
  await client.query(`UPDATE ic_job_listings SET status = 'skip', marked_at = $2 WHERE id = $1`, [listingId, now]);
  await recordEvent(client, {
    listingId, kind: 'status', fromStatus: row.status ?? null, toStatus: 'skip',
    note: `${TITLE_GATE_NOTE_PREFIX}${gate.reason} (${gate.rule})`, actor: 'auto', runId: ctx.runId ?? null, at: now,
  });
  return { applied: true, verdict: 'drop', reason: gate.reason, rule: gate.rule, blocked: null };
}
