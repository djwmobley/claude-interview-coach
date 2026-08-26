// @ts-check
/**
 * Wall detection (spec section 4): TOTAL page classification.
 *
 *   parsed > 0                                        -> ok
 *   parsed == 0 AND known empty-state marker          -> empty
 *   HTTP 403/429, cf-mitigated header, challenge
 *   containers, or URL /login|/checkpoint|/authwall|/uas/ -> wall
 *   otherwise                                         -> unrecognized (treated as wall)
 *
 * Inputs are scalars and booleans gathered by the caller (HTTP status, a
 * header value, the final URL, and marker booleans from the named
 * `wallMarkers` extractor). This module never scans description text.
 */

export const KINDS = Object.freeze(['ok', 'empty', 'wall', 'unrecognized']);

const WALL_PATH = /\/(login|checkpoint|authwall|uas)(\/|$|\?)/i;

/**
 * @typedef {Object} PageSignals
 * @property {number} parsed number of listings the adapter parsed from the page
 * @property {number|null} [status] HTTP status when known
 * @property {string|null} [cfMitigated] value of the cf-mitigated header
 * @property {string|null} [url] final URL after navigation/redirects
 * @property {boolean} [challengeCloudflare] iframe[src*="challenges.cloudflare.com"] present
 * @property {boolean} [challengeForm] #challenge-form present
 * @property {boolean} [recaptcha] iframe[title*="recaptcha"] present
 * @property {boolean} [emptyState] a known empty-state marker for the source is present
 */

/**
 * @typedef {Object} PageVerdict
 * @property {'ok'|'empty'|'wall'|'unrecognized'} kind
 * @property {string} reason
 * @property {boolean} stopSource true for wall and unrecognized
 * @property {string} code error code to surface (LOGIN_WALL or UNRECOGNIZED_PAGE) or '' for ok/empty
 */

/**
 * @param {PageSignals} s
 * @returns {PageVerdict}
 */
export function classifyPage(s) {
  const parsed = Number.isFinite(s.parsed) ? s.parsed : 0;
  if (parsed > 0) return { kind: 'ok', reason: 'parsed', stopSource: false, code: '' };
  if (s.emptyState === true) return { kind: 'empty', reason: 'empty_state_marker', stopSource: false, code: '' };
  const status = s.status ?? null;
  if (status === 403 || status === 429) return { kind: 'wall', reason: `http_${status}`, stopSource: true, code: 'LOGIN_WALL' };
  if (s.cfMitigated) return { kind: 'wall', reason: 'cf_mitigated', stopSource: true, code: 'LOGIN_WALL' };
  if (s.challengeCloudflare === true) return { kind: 'wall', reason: 'cloudflare_challenge', stopSource: true, code: 'LOGIN_WALL' };
  if (s.challengeForm === true) return { kind: 'wall', reason: 'challenge_form', stopSource: true, code: 'LOGIN_WALL' };
  if (s.recaptcha === true) return { kind: 'wall', reason: 'recaptcha', stopSource: true, code: 'LOGIN_WALL' };
  if (s.url) {
    let pathname = '';
    try {
      pathname = new URL(s.url).pathname;
    } catch {
      pathname = String(s.url);
    }
    if (WALL_PATH.test(pathname)) return { kind: 'wall', reason: 'wall_path', stopSource: true, code: 'LOGIN_WALL' };
  }
  return { kind: 'unrecognized', reason: 'no_results_no_marker', stopSource: true, code: 'UNRECOGNIZED_PAGE' };
}

/**
 * Page-1 throttle heuristic: count under ratio x historical median.
 * With no history (median null or 0) there is nothing to compare against.
 * @param {number} count
 * @param {number|null} median
 * @param {number} ratio e.g. 0.4
 */
export function suspectedThrottle(count, median, ratio) {
  if (median === null || median === undefined || !(median > 0)) return false;
  return count < ratio * median;
}

/**
 * Cross-run backoff (spec section 4): one wall disables the source 24 h,
 * two consecutive 72 h, three or more require manual re-enable.
 * @param {number} consecutiveWalls count INCLUDING the wall just observed
 * @returns {{ hours: number|null, manual: boolean }}
 */
export function backoffFor(consecutiveWalls) {
  if (consecutiveWalls <= 1) return { hours: 24, manual: false };
  if (consecutiveWalls === 2) return { hours: 72, manual: false };
  return { hours: null, manual: true };
}

/**
 * Record a wall in ic_source_state and return the disable decision.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 * @param {Date} [now]
 */
export async function recordWall(client, source, now = new Date()) {
  const r = await client.query(
    `INSERT INTO ic_source_state (source, consecutive_walls, last_wall_at) VALUES ($1, 1, $2)
     ON CONFLICT (source) DO UPDATE SET consecutive_walls = ic_source_state.consecutive_walls + 1, last_wall_at = EXCLUDED.last_wall_at
     RETURNING consecutive_walls`,
    [source, now],
  );
  const n = Number(r.rows[0].consecutive_walls);
  const b = backoffFor(n);
  if (b.manual) {
    await client.query('UPDATE ic_source_state SET manual_disable = true, disabled_until = NULL WHERE source = $1', [source]);
  } else {
    await client.query('UPDATE ic_source_state SET disabled_until = $2 WHERE source = $1', [source, new Date(now.getTime() + (b.hours ?? 0) * 3600000)]);
  }
  return { consecutiveWalls: n, ...b };
}

/**
 * Reset the wall counter after a clean run for the source.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 */
export async function recordClean(client, source) {
  await client.query(
    `INSERT INTO ic_source_state (source, consecutive_walls) VALUES ($1, 0)
     ON CONFLICT (source) DO UPDATE SET consecutive_walls = 0, disabled_until = NULL WHERE ic_source_state.manual_disable = false`,
    [source],
  );
}

/**
 * Is the source usable right now? Total: unknown source -> enabled.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 * @param {Date} [now]
 * @returns {Promise<{ enabled: boolean, reason: string, disabledUntil: Date|null }>}
 */
export async function sourceEnabled(client, source, now = new Date()) {
  const r = await client.query('SELECT disabled_until, manual_disable FROM ic_source_state WHERE source = $1', [source]);
  if (r.rowCount === 0) return { enabled: true, reason: 'no_state', disabledUntil: null };
  const row = r.rows[0];
  if (row.manual_disable) return { enabled: false, reason: 'manual_disable', disabledUntil: null };
  if (row.disabled_until && new Date(row.disabled_until).getTime() > now.getTime()) {
    return { enabled: false, reason: 'backoff', disabledUntil: new Date(row.disabled_until) };
  }
  return { enabled: true, reason: 'ok', disabledUntil: null };
}
