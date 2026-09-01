// @ts-check
/**
 * Calendar provider factory (dashboard PR 1: moved out of src/server.js so the dashboard's `bin/dashboard.js`
 * can build the same calendar deps without importing src/server.js or src/core/stdout-hygiene.js, which the
 * plan forbids for the dashboard entry point).
 *
 * Lazy: the token is loaded and refreshed on first use. Two separate TTLs cache the outcome (auth-health
 * hardening, spec Change 2):
 *   - a successful connection is cached for up to ~50 minutes (unchanged from before this change), so a
 *     healthy grant does not refresh on every call.
 *   - a BROKEN classification is cached for a much shorter cooldown (default 5 minutes, overridable via
 *     `opts.brokenCooldownMs` for tests) during which repeated calls return the cached broken result
 *     WITHOUT re-attempting a live refresh -- a dead grant should not be hammered with a refresh attempt
 *     on every dashboard poll.
 * Returns null (with a logged warning) when the token file is missing, lacks the calendar scope, or the
 * live refresh fails, so callers (followups, the dashboard calendar routes) still work without it. The
 * last classification (success or broken) is exposed via the returned function's `.lastState()`
 * accessor so callers that need the REASON for a null result (the dashboard calendar route) can read it
 * without a second classification attempt of their own.
 */
import { classifyAndConnect, calendarInsertEvent, calendarDeleteEvent, calendarListEvents } from './google.js';
import { log } from './logger.js';

/** Default cooldown before a broken classification is re-attempted (5 minutes). */
export const DEFAULT_BROKEN_COOLDOWN_MS = 5 * 60000;
/** Cap on how long a successful connection is cached, unchanged from before this change. */
const SUCCESS_MAX_CACHE_MS = 50 * 60000;

/**
 * @typedef {Object} CalendarProvider
 * @property {(ev: { summary: string, description: string, startIso: string, endIso: string, reminderMinutes?: number }) => Promise<string>} insertEvent
 * @property {(eventId: string) => Promise<void>} deleteEvent
 * @property {(opts: { timeMin: string, timeMax: string, maxResults?: number, calendarId?: string }) => Promise<Array<Record<string, unknown>>>} listEvents
 */

/**
 * @typedef {(() => Promise<CalendarProvider|null>) & { lastState: () => import('./google.js').GoogleTokenState|null }} CalendarProviderFn
 */

/**
 * @param {import('./config.js').Env} env
 * @param {{ brokenCooldownMs?: number, classifyAndConnect?: typeof classifyAndConnect }} [opts]
 *   brokenCooldownMs: test seam for the broken-state cooldown, default 5 minutes.
 *   classifyAndConnect: test seam so tests never touch a real token file or the network (mirrors
 *   remind.js's `opts.googleHttp` override); production code never passes this.
 * @returns {CalendarProviderFn}
 */
export function makeCalendarProvider(env, opts = {}) {
  const brokenCooldownMs = opts.brokenCooldownMs ?? DEFAULT_BROKEN_COOLDOWN_MS;
  const doClassifyAndConnect = opts.classifyAndConnect ?? classifyAndConnect;
  /** @type {{ deps: import('./google.js').HttpDeps, until: number }|null} */
  let cachedOk = null;
  /** @type {{ until: number }|null} */
  let cachedBroken = null;
  /** @type {import('./google.js').GoogleTokenState|null} */
  let lastClassification = null;

  /** @type {CalendarProviderFn} */
  const provider = /** @type {any} */ (async () => {
    const now = Date.now();
    if (cachedOk && cachedOk.until > now) return wrap(cachedOk.deps);
    if (cachedBroken && cachedBroken.until > now) return null;
    if (!env.GOOGLE_TOKEN_FILE) {
      lastClassification = { state: 'broken_missing_file' };
      cachedBroken = { until: now + brokenCooldownMs };
      cachedOk = null;
      log.warn({ evt: 'google_token_unavailable', state: lastClassification.state, err_message: 'GOOGLE_TOKEN_FILE is not set; add it to mcp/job-search/.env' });
      return null;
    }
    const { state, accessToken } = await doClassifyAndConnect(env.GOOGLE_TOKEN_FILE, { calendar: true });
    lastClassification = state;
    if (state.state === 'ok') {
      const exp = state.expiry ? Date.parse(state.expiry) : now + 30 * 60000;
      const deps = { fetch, accessToken: /** @type {string} */ (accessToken) };
      cachedOk = { deps, until: Math.min(exp - 60000, now + SUCCESS_MAX_CACHE_MS) };
      cachedBroken = null;
      log.info({ evt: 'google_token_ok', expiry: state.expiry });
      return wrap(deps);
    }
    cachedBroken = { until: now + brokenCooldownMs };
    cachedOk = null;
    log.warn({
      evt: 'google_token_unavailable',
      state: state.state,
      code: state.state === 'broken_refresh_error' ? state.code : null,
      missing_scopes: state.state === 'broken_missing_scopes' ? state.missing.join(',') : null,
    });
    return null;
  });
  provider.lastState = () => lastClassification;
  return provider;

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
