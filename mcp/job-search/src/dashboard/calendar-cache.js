// @ts-check
/**
 * Calendar agenda cache (dashboard PR 2, plan "Calendar": TTL 5 min keyed by window, invalidated on every
 * dashboard insert/delete, `?fresh=1` bypass). Kept trivially simple: an in-memory Map is enough for a
 * loopback-only, single-instance server.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * @param {{ timeMin: string, timeMax: string, maxResults?: number, calendarId?: string }} params
 */
function keyFor(params) {
  return [params.timeMin, params.timeMax, params.maxResults ?? '', params.calendarId ?? 'primary'].join('|');
}

/** @param {{ ttlMs?: number }} [opts] */
export function createCalendarCache(opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  /** @type {Map<string, { data: unknown, expiresAt: number }>} */
  const store = new Map();

  /**
   * @param {{ timeMin: string, timeMax: string, maxResults?: number, calendarId?: string }} params
   * @param {() => Promise<unknown>} loader
   * @param {{ fresh?: boolean }} [callOpts]
   */
  async function get(params, loader, callOpts = {}) {
    const key = keyFor(params);
    if (!callOpts.fresh) {
      const hit = store.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.data;
    }
    const data = await loader();
    store.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  }

  function invalidateAll() {
    store.clear();
  }

  return { get, invalidateAll };
}
