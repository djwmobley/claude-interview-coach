// @ts-check
/**
 * Calendar routes (dashboard PR 2 API table, "Calendar"). Reuses the injected calendar provider
 * (src/core/calendar-provider.js) through calendar-cache.js's 5-minute window cache; a banner-worthy
 * "not connected" state (no Google token) is a normal 200 response, never an error, so the front end can
 * show its own banner instead of treating a missing grant as a fault.
 */
import { JobSearchError } from '../../core/errors.js';
import { GOOGLE_TOKEN_STATE_HINTS, DEFAULT_GOOGLE_TOKEN_STATE_HINT } from '../../core/google.js';
import { sendJson } from '../http.js';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/calendar/agenda', async (ctx) => {
    const q = ctx.query;
    if (!q.from || !q.to) throw new JobSearchError('VALIDATION', 'from and to are required (ISO datetimes)');
    const calendar = deps.calendar ? await deps.calendar() : null;
    if (!calendar) {
      // Never re-classifies here: only reads the provider's already-cached classification (auth-health
      // hardening, spec Change 2). `deps.calendar` may be a plain test double with no `.lastState`
      // (dashboard-server.test.js's stub) -- 'unknown' is the honest fallback for "no classification
      // information available", never a guessed real state.
      const lastState = deps.calendar && typeof (/** @type {any} */ (deps.calendar).lastState) === 'function' ? /** @type {any} */ (deps.calendar).lastState() : null;
      const reason = lastState ? lastState.state : 'unknown';
      const hint = GOOGLE_TOKEN_STATE_HINTS[reason] ?? DEFAULT_GOOGLE_TOKEN_STATE_HINT;
      return sendJson(ctx.res, 200, { ok: true, connected: false, events: [], followups: [], reason, hint });
    }
    const fresh = q.fresh === '1' || q.fresh === 'true';
    const events = await deps.calendarCache.get({ timeMin: q.from, timeMax: q.to }, () => calendar.listEvents({ timeMin: q.from, timeMax: q.to }), { fresh });
    const followupsInWindow = await deps.withClient((c) => c.query(
      `SELECT id, contact, org, listing_id, due_at, channel, action, status, calendar_event_id
       FROM ic_followups WHERE due_at >= $1 AND due_at <= $2 AND status IN ('open','snoozed') ORDER BY due_at`,
      [q.from, q.to],
    ));
    sendJson(ctx.res, 200, { ok: true, connected: true, events, followups: followupsInWindow.rows });
  });

  router.register('POST', '/api/calendar/events', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    const calendar = deps.calendar ? await deps.calendar() : null;
    if (!calendar) throw new JobSearchError('VALIDATION', 'calendar is not configured');
    if (!b.summary || !b.startIso || !b.endIso) throw new JobSearchError('VALIDATION', 'summary, startIso, and endIso are required');
    const id = await calendar.insertEvent({
      summary: String(b.summary),
      description: typeof b.description === 'string' ? b.description : '',
      startIso: String(b.startIso),
      endIso: String(b.endIso),
      reminderMinutes: typeof b.reminderMinutes === 'number' ? b.reminderMinutes : 60,
    });
    deps.calendarCache.invalidateAll();
    sendJson(ctx.res, 201, { ok: true, event_id: id });
  });

  router.register('DELETE', '/api/calendar/events/:id', async (ctx) => {
    const calendar = deps.calendar ? await deps.calendar() : null;
    if (!calendar) throw new JobSearchError('VALIDATION', 'calendar is not configured');
    await calendar.deleteEvent(ctx.params.id);
    deps.calendarCache.invalidateAll();
    sendJson(ctx.res, 200, { ok: true, deleted: true });
  }, { allowEmptyBody: true });
}
