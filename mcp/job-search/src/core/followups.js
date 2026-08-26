// @ts-check
/**
 * Follow-up reminders (spec 2.4, 5, 12b): state machine over ic_followups.
 *
 * Calendar integration is injected as `{ insertEvent, deleteEvent }` so the
 * tool can pass the real Google client and tests can pass stubs. Calendar
 * failure never fails a create/complete/cancel; it is returned as a warning.
 */
import { JobSearchError } from './errors.js';

export const CHANNELS = Object.freeze(['phone', 'email', 'linkedin', 'other']);
export const NOTIFY = Object.freeze(['email', 'calendar']);
export const STATUSES = Object.freeze(['open', 'done', 'snoozed', 'cancelled']);

const COLS = 'id, contact, org, listing_id, due_at, channel, action, notify, status, snoozed_until, created_from, reminded_at, calendar_event_id, created_at, updated_at';

/**
 * @typedef {Object} CalendarDeps
 * @property {(ev: { summary: string, description: string, startIso: string, endIso: string, reminderMinutes?: number }) => Promise<string>} insertEvent
 * @property {(eventId: string) => Promise<void>} deleteEvent
 */

/**
 * @typedef {Object} FollowupRow
 * @property {number} id
 * @property {string} contact
 * @property {string|null} org
 * @property {number|null} listing_id
 * @property {Date} due_at
 * @property {string} channel
 * @property {string} action
 * @property {string[]} notify
 * @property {string} status
 * @property {Date|null} snoozed_until
 * @property {string|null} created_from
 * @property {Date|null} reminded_at
 * @property {string|null} calendar_event_id
 */

/**
 * Parse an ISO date string strictly. Date-only values mean 09:00 local.
 * @param {unknown} v
 * @param {string} field
 * @returns {Date}
 */
export function parseIsoDate(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new JobSearchError('VALIDATION', `${field} is required (ISO date)`);
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) {
    throw new JobSearchError('VALIDATION', `${field} must be an ISO date like 2026-08-27 or 2026-08-27T09:00-05:00`);
  }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T09:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new JobSearchError('VALIDATION', `${field} is not a valid date`);
  return d;
}

/** @param {FollowupRow} r */
export function formatFollowup(r) {
  const due = r.status === 'snoozed' && r.snoozed_until ? r.snoozed_until : r.due_at;
  const d = new Date(due).toISOString().slice(0, 10);
  const parts = [`#${r.id}`, r.contact, r.org ?? '', r.channel, `due ${d}`, r.status, String(r.action).replace(/\s+/g, ' ').slice(0, 60)];
  return parts.filter((p) => p !== '').join(' | ').slice(0, 120);
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @returns {Promise<FollowupRow|null>}
 */
export async function getFollowup(client, id) {
  const r = await client.query(`SELECT ${COLS} FROM ic_followups WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ contact: string, org?: string|null, listing_id?: number|null, due_at: string, channel: string, action: string, notify?: string[], created_from?: string|null }} input
 * @param {{ calendar?: CalendarDeps|null, now?: Date }} [opts]
 * @returns {Promise<{ row: FollowupRow, warnings: string[] }>}
 */
export async function createFollowup(client, input, opts = {}) {
  const contact = String(input.contact ?? '').trim();
  if (!contact) throw new JobSearchError('VALIDATION', 'contact is required');
  const action = String(input.action ?? '').trim();
  if (!action) throw new JobSearchError('VALIDATION', 'action_text is required');
  if (!CHANNELS.includes(input.channel)) throw new JobSearchError('VALIDATION', `channel must be one of ${CHANNELS.join(', ')}`);
  const notify = input.notify && input.notify.length > 0 ? [...new Set(input.notify)] : ['email'];
  for (const n of notify) if (!NOTIFY.includes(n)) throw new JobSearchError('VALIDATION', `notify values must be one of ${NOTIFY.join(', ')}`);
  const due = parseIsoDate(input.due_at, 'due_at');
  if (input.listing_id != null) {
    const l = await client.query(`SELECT id FROM ic_job_listings WHERE id = $1`, [input.listing_id]);
    if (l.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${input.listing_id} not found`);
  }
  const r = await client.query(
    `INSERT INTO ic_followups (contact, org, listing_id, due_at, channel, action, notify, created_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
    [contact, input.org ? String(input.org).trim() : null, input.listing_id ?? null, due, input.channel, action, notify, input.created_from ?? null],
  );
  /** @type {FollowupRow} */
  let row = r.rows[0];
  /** @type {string[]} */
  const warnings = [];
  if (notify.includes('calendar')) {
    if (!opts.calendar) {
      warnings.push('calendar notify requested but calendar is not configured; no event created');
    } else {
      try {
        const start = due;
        const end = new Date(due.getTime() + 30 * 60000);
        const id = await opts.calendar.insertEvent({
          summary: `Follow up: ${contact}${row.org ? ` (${row.org})` : ''}`,
          description: action,
          startIso: start.toISOString(),
          endIso: end.toISOString(),
          reminderMinutes: 60,
        });
        const u = await client.query(`UPDATE ic_followups SET calendar_event_id = $2, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [row.id, id]);
        row = u.rows[0];
      } catch (err) {
        const msg = err && typeof err === 'object' && 'message' in err ? String(/** @type {{ message: unknown }} */ (err).message) : String(err);
        warnings.push(`calendar event not created: ${msg.slice(0, 200)}`);
      }
    }
  }
  return { row, warnings };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ status?: string[], limit?: number, offset?: number, contact?: string }} [f]
 * @returns {Promise<{ rows: FollowupRow[], total: number }>}
 */
export async function listFollowups(client, f = {}) {
  const statuses = f.status && f.status.length > 0 ? f.status : ['open', 'snoozed'];
  for (const s of statuses) if (!STATUSES.includes(s)) throw new JobSearchError('VALIDATION', `status must be one of ${STATUSES.join(', ')}`);
  const limit = Math.max(1, Math.min(25, f.limit ?? 25));
  const offset = Math.max(0, f.offset ?? 0);
  const params = /** @type {unknown[]} */ ([statuses]);
  let where = 'status = ANY($1::text[])';
  if (f.contact) {
    params.push(`%${f.contact}%`);
    where += ` AND contact ILIKE $${params.length}`;
  }
  const total = await client.query(`SELECT count(*)::int AS n FROM ic_followups WHERE ${where}`, params);
  params.push(limit, offset);
  const r = await client.query(
    `SELECT ${COLS} FROM ic_followups WHERE ${where} ORDER BY coalesce(snoozed_until, due_at) ASC, id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows: r.rows, total: total.rows[0].n };
}

/**
 * Delete the calendar event if present; never throws.
 * @param {import('pg').ClientBase} client
 * @param {FollowupRow} row
 * @param {CalendarDeps|null|undefined} calendar
 * @param {string[]} warnings
 */
async function dropCalendar(client, row, calendar, warnings) {
  if (!row.calendar_event_id) return;
  if (!calendar) {
    warnings.push('calendar event left in place: calendar not configured');
    return;
  }
  try {
    await calendar.deleteEvent(row.calendar_event_id);
    await client.query('UPDATE ic_followups SET calendar_event_id = NULL, updated_at = now() WHERE id = $1', [row.id]);
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? String(/** @type {{ message: unknown }} */ (err).message) : String(err);
    warnings.push(`calendar event not deleted: ${msg.slice(0, 200)}`);
  }
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ calendar?: CalendarDeps|null }} [opts]
 */
export async function completeFollowup(client, id, opts = {}) {
  const row = await getFollowup(client, id);
  if (!row) throw new JobSearchError('NOT_FOUND', `followup ${id} not found`);
  if (row.status === 'done') return { row, warnings: ['already done'] };
  if (row.status === 'cancelled') throw new JobSearchError('VALIDATION', `followup ${id} is cancelled; create a new one`);
  /** @type {string[]} */
  const warnings = [];
  await dropCalendar(client, row, opts.calendar, warnings);
  const r = await client.query(`UPDATE ic_followups SET status = 'done', updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id]);
  return { row: r.rows[0], warnings };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ calendar?: CalendarDeps|null }} [opts]
 */
export async function cancelFollowup(client, id, opts = {}) {
  const row = await getFollowup(client, id);
  if (!row) throw new JobSearchError('NOT_FOUND', `followup ${id} not found`);
  if (row.status === 'cancelled') return { row, warnings: ['already cancelled'] };
  /** @type {string[]} */
  const warnings = [];
  await dropCalendar(client, row, opts.calendar, warnings);
  const r = await client.query(`UPDATE ic_followups SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id]);
  return { row: r.rows[0], warnings };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {string} snoozedUntil ISO
 * @param {{ now?: Date }} [opts]
 */
export async function snoozeFollowup(client, id, snoozedUntil, opts = {}) {
  const row = await getFollowup(client, id);
  if (!row) throw new JobSearchError('NOT_FOUND', `followup ${id} not found`);
  if (row.status === 'done' || row.status === 'cancelled') throw new JobSearchError('VALIDATION', `followup ${id} is ${row.status}; cannot snooze`);
  const until = parseIsoDate(snoozedUntil, 'snoozed_until');
  const now = opts.now ?? new Date();
  if (until.getTime() <= now.getTime()) throw new JobSearchError('VALIDATION', 'snoozed_until must be in the future');
  const r = await client.query(`UPDATE ic_followups SET status = 'snoozed', snoozed_until = $2, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, until]);
  return { row: r.rows[0], warnings: [] };
}

/**
 * Flip snoozed rows whose snoozed_until has passed back to open (remind.js
 * does this before selecting the due set). Returns the ids flipped.
 * @param {import('pg').ClientBase} client
 * @param {Date} [now]
 */
export async function unsnoozeDue(client, now = new Date()) {
  const r = await client.query(
    `UPDATE ic_followups SET status = 'open', snoozed_until = NULL, updated_at = now()
     WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= $1 RETURNING id`,
    [now],
  );
  return r.rows.map((x) => Number(x.id));
}

/**
 * The due set for the daily digest (spec section 6): open rows due within
 * a day that have not been reminded today.
 * @param {import('pg').ClientBase} client
 * @param {Date} [now]
 * @returns {Promise<FollowupRow[]>}
 */
export async function selectDue(client, now = new Date()) {
  const r = await client.query(
    `SELECT ${COLS} FROM ic_followups
     WHERE status = 'open' AND due_at <= $1::timestamptz + interval '1 day'
       AND (reminded_at IS NULL OR reminded_at < date_trunc('day', $1::timestamptz))
     ORDER BY due_at ASC, id ASC`,
    [now],
  );
  return r.rows;
}

/**
 * Stamp reminded_at for the given ids (only after a 2xx send).
 * @param {import('pg').ClientBase} client
 * @param {number[]} ids
 * @param {Date} [now]
 */
export async function stampReminded(client, ids, now = new Date()) {
  if (ids.length === 0) return 0;
  const r = await client.query('UPDATE ic_followups SET reminded_at = $2, updated_at = now() WHERE id = ANY($1::int[])', [ids, now]);
  return r.rowCount ?? 0;
}
