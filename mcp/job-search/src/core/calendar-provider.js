// @ts-check
/**
 * Calendar provider factory (dashboard PR 1: moved out of src/server.js so the dashboard's `bin/dashboard.js`
 * can build the same calendar deps without importing src/server.js or src/core/stdout-hygiene.js, which the
 * plan forbids for the dashboard entry point).
 *
 * Lazy: the token is loaded and refreshed on first use, and the resulting access token is cached until
 * shortly before it expires. Returns null (with a logged warning) when the token file is missing or
 * lacks the calendar scope, so callers (followups, the dashboard calendar routes) still work without it.
 */
import { googleHttp, calendarInsertEvent, calendarDeleteEvent, calendarListEvents } from './google.js';
import { log } from './logger.js';
import { errFields } from './errors.js';

/**
 * @typedef {Object} CalendarProvider
 * @property {(ev: { summary: string, description: string, startIso: string, endIso: string, reminderMinutes?: number }) => Promise<string>} insertEvent
 * @property {(eventId: string) => Promise<void>} deleteEvent
 * @property {(opts: { timeMin: string, timeMax: string, maxResults?: number, calendarId?: string }) => Promise<Array<Record<string, unknown>>>} listEvents
 */

/**
 * @param {import('./config.js').Env} env
 * @returns {() => Promise<CalendarProvider|null>}
 */
export function makeCalendarProvider(env) {
  /** @type {{ deps: import('./google.js').HttpDeps, until: number }|null} */
  let cached = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.until > now) return wrap(cached.deps);
    if (!env.GOOGLE_TOKEN_FILE) {
      log.warn({ evt: 'google_token_unavailable', err_code: 'VALIDATION', err_message: 'GOOGLE_TOKEN_FILE is not set; add it to mcp/job-search/.env' });
      return null;
    }
    try {
      const g = await googleHttp({ tokenFile: env.GOOGLE_TOKEN_FILE, need: { calendar: true } });
      const exp = g.expiry ? Date.parse(g.expiry) : now + 30 * 60000;
      cached = { deps: g.deps, until: Math.min(exp - 60000, now + 50 * 60000) };
      log.info({ evt: 'google_token_ok', calendar_ok: g.info.calendar_ok, expiry: g.expiry });
      return wrap(g.deps);
    } catch (err) {
      log.warn({ evt: 'google_token_unavailable', ...errFields(err) });
      return null;
    }
  };
  /**
   * @param {import('./google.js').HttpDeps} deps
   * @returns {CalendarProvider}
   */
  function wrap(deps) {
    return {
      insertEvent: (ev) => calendarInsertEvent(deps, ev),
      deleteEvent: (id) => calendarDeleteEvent(deps, id),
      listEvents: (opts) => calendarListEvents(deps, opts),
    };
  }
}
