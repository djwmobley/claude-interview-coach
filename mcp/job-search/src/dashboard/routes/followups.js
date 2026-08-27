// @ts-check
/**
 * Follow-up routes (dashboard PR 2 API table, "Follow-ups"). Reuses core/followups.js plus the new
 * updateFollowup for the edit drawer. `reply` records a `reply` event on the linked listing (feeds the
 * analytics response-rate stat); a follow-up with no linked listing records nothing but still succeeds.
 */
import { JobSearchError } from '../../core/errors.js';
import { createFollowup, listFollowups, completeFollowup, cancelFollowup, snoozeFollowup, updateFollowup, getFollowup } from '../../core/followups.js';
import { recordEvent } from '../../core/events.js';
import { sendJson } from '../http.js';

const FOLLOWUP_COLS = 'id, contact, org, listing_id, due_at, channel, action, notify, status, snoozed_until, created_from, reminded_at, calendar_event_id, created_at, updated_at';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  router.register('GET', '/api/followups', async (ctx) => {
    const q = ctx.query;
    const status = q.status ? String(q.status).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const listingId = q.listing_id ? Number(q.listing_id) : undefined;
    // listingId is pushed into the SQL WHERE clause (not an in-memory filter after LIMIT 25), so a
    // listing's own follow-ups are never dropped just because more than 25 other follow-ups are due
    // sooner system-wide. `total` now reflects the listing-scoped count too, matching `rows`.
    const result = await deps.withClient((c) => listFollowups(c, { status, listingId, limit: listingId ? 100 : 25, offset: q.offset ? Number(q.offset) : 0 }));
    let rows = result.rows;
    if (q.from) rows = rows.filter((r) => new Date(r.due_at).getTime() >= new Date(String(q.from)).getTime());
    if (q.to) rows = rows.filter((r) => new Date(r.due_at).getTime() <= new Date(String(q.to)).getTime());
    sendJson(ctx.res, 200, { ok: true, total: result.total, rows });
  });

  router.register('POST', '/api/followups', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    if (!b.channel) throw new JobSearchError('VALIDATION', 'channel is required');
    const calendar = deps.calendar ? await deps.calendar() : null;
    const { row, warnings } = await deps.withClient((c) => createFollowup(c, {
      contact: b.contact ?? '',
      org: b.org ?? null,
      listing_id: b.listing_id ?? null,
      due_at: b.due_at ?? '',
      channel: b.channel,
      action: b.action_text ?? '',
      notify: b.notify,
      created_from: 'dashboard',
    }, { calendar }));
    streamHub?.notifyChanged('followups');
    sendJson(ctx.res, 201, { ok: true, row, warnings });
  });

  router.register('PUT', '/api/followups/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    /** @type {any} */
    const patch = {};
    if (b.contact !== undefined) patch.contact = b.contact;
    if (b.org !== undefined) patch.org = b.org;
    if (b.due_at !== undefined) patch.due_at = b.due_at;
    if (b.channel !== undefined) patch.channel = b.channel;
    if (b.action_text !== undefined) patch.action = b.action_text;
    if (b.notify !== undefined) patch.notify = b.notify;
    const { row, warnings } = await deps.withClient((c) => updateFollowup(c, id, patch));
    streamHub?.notifyChanged('followups');
    sendJson(ctx.res, 200, { ok: true, row, warnings });
  });

  router.register('POST', '/api/followups/:id/complete', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const calendar = deps.calendar ? await deps.calendar() : null;
    const { row, warnings } = await deps.withClient((c) => completeFollowup(c, id, { calendar }));
    streamHub?.notifyChanged('followups');
    sendJson(ctx.res, 200, { ok: true, row, warnings });
  }, { allowEmptyBody: true });

  router.register('POST', '/api/followups/:id/cancel', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const calendar = deps.calendar ? await deps.calendar() : null;
    const { row, warnings } = await deps.withClient((c) => cancelFollowup(c, id, { calendar }));
    streamHub?.notifyChanged('followups');
    sendJson(ctx.res, 200, { ok: true, row, warnings });
  }, { allowEmptyBody: true });

  router.register('POST', '/api/followups/:id/snooze', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    if (!b.snoozed_until) throw new JobSearchError('VALIDATION', 'snoozed_until is required');
    const { row, warnings } = await deps.withClient((c) => snoozeFollowup(c, id, b.snoozed_until));
    streamHub?.notifyChanged('followups');
    sendJson(ctx.res, 200, { ok: true, row, warnings });
  });

  router.register('POST', '/api/followups/:id/calendar', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const calendar = deps.calendar ? await deps.calendar() : null;
    if (!calendar) throw new JobSearchError('VALIDATION', 'calendar is not configured');
    const row = await deps.withClient((c) => getFollowup(c, id));
    if (!row) throw new JobSearchError('NOT_FOUND', `followup ${id} not found`);
    if (row.calendar_event_id) return sendJson(ctx.res, 200, { ok: true, row, warnings: ['calendar event already attached'] });
    const start = new Date(row.due_at);
    const end = new Date(start.getTime() + 30 * 60000);
    const eventId = await calendar.insertEvent({
      summary: `Follow up: ${row.contact}${row.org ? ` (${row.org})` : ''}`,
      description: row.action,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      reminderMinutes: 60,
    });
    const updated = await deps.withClient((c) => c.query(`UPDATE ic_followups SET calendar_event_id = $2, updated_at = now() WHERE id = $1 RETURNING ${FOLLOWUP_COLS}`, [id, eventId]));
    streamHub?.notifyChanged('followups');
    sendJson(ctx.res, 200, { ok: true, row: updated.rows[0], warnings: [] });
  }, { allowEmptyBody: true });

  router.register('POST', '/api/followups/:id/reply', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    const note = typeof b.note === 'string' ? b.note.slice(0, 400) : null;
    const row = await deps.withClient((c) => getFollowup(c, id));
    if (!row) throw new JobSearchError('NOT_FOUND', `followup ${id} not found`);
    /** @type {string[]} */
    const warnings = [];
    if (row.listing_id) {
      await deps.withClient((c) => recordEvent(c, { listingId: row.listing_id, kind: 'reply', note, actor: 'dashboard' }));
    } else {
      warnings.push('no linked listing; reply was not recorded against any listing history');
    }
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, row, warnings });
  }, { allowEmptyBody: true });
}
