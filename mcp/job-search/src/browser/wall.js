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

export { classifyDetail, normalizeDetailText, isBlockedClass, detailWallKey, DETAIL_BLOCK_REASONS, DETAIL_CLASSIFICATIONS } from './detail-classify.js';

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
 * @property {boolean} [guestInterstitial] "sign in to see more" / "join to view more" guest interstitial text present
 * @property {boolean} [loginForm] an inline login form is present
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
  // A guest interstitial or inline login form outranks an empty-state marker: the page is gating results.
  if (s.guestInterstitial === true) return { kind: 'wall', reason: 'guest_interstitial', stopSource: true, code: 'LOGIN_WALL' };
  if (s.loginForm === true) return { kind: 'wall', reason: 'login_form', stopSource: true, code: 'LOGIN_WALL' };
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
 * reCAPTCHA v3 script-presence signal (apply pipeline slice 5, amended spec: "add a reCAPTCHA v3
 * script-presence signal to wall.js (detect, never solve; captcha wall -> needs_human)"). Independent of
 * classifyPage()/recordWall() above -- those are scan-specific (login-wall backoff bookkeeping written to
 * ic_source_state) and are left untouched. This is a small, pure, total function the apply worker/adapters
 * call directly on a fetched page's HTML: it looks for the v3 script-loader URL (`.../recaptcha/api.js?
 * render=<site-key>`, the shape v3 always uses, distinct from v2's checkbox widget) or a `grecaptcha.
 * execute(...)` call site (the v3 JS API invocation every v3 integration makes to obtain a token). Detect
 * only -- there is no solve path anywhere in this codebase; a true hit is the apply worker's own signal to
 * park the run in needs_human rather than attempt to submit past a live challenge.
 * @param {unknown} html
 * @returns {boolean}
 */
export function detectRecaptchaV3Script(html) {
  if (typeof html !== 'string' || !html) return false;
  return /https:\/\/www\.google\.com\/recaptcha\/api\.js\?render=/i.test(html) || /grecaptcha\.execute\s*\(/i.test(html);
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

/** Wall history entries kept per source (the last N, oldest first). */
export const WALL_HISTORY_MAX = 5;

/**
 * @typedef {Object} WallInfo
 * @property {string|null} [kind] closed classification of the wall (e.g. unhydrated_after_retry)
 * @property {string|null} [detail] short human detail
 * @property {string|null} [url] final page URL (query already stripped)
 * @property {string|null} [snapshot] snapshot file name; only the basename is stored
 * @property {number|string|null} [runId] the scan run that saw it
 * @property {boolean} [dryRun] refused: a dry run never records a wall
 */

/** @param {unknown} v @param {number} max */
const clip = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/**
 * Record a wall in ic_source_state and return the disable decision. The counter, the flags, the last-wall
 * columns and the capped history append are ONE statement, so two writers cannot interleave a stale read.
 * The backoff thresholds in the CASE below mirror backoffFor() (1 -> 24 h, 2 -> 72 h, 3+ -> manual); a test
 * pins the two together. `info` is optional so the other sources sharing this function behave unchanged.
 * The wall is stamped with the database clock when it is recorded, never the run's start time, so a wall
 * recorded after a mid-run re-enable counts after reset_at. `at` exists only so a test can pin the time.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 * @param {Date|null} [at] test seam: pin the wall time; null or undefined means now()
 * @param {WallInfo} [info]
 */
export async function recordWall(client, source, at = null, info = {}) {
  if (info.dryRun) throw new Error('recordWall: a dry run must never record a wall');
  const kind = clip(info.kind, 80);
  const detail = clip(info.detail, 300);
  const url = clip(info.url, 300);
  const snapshot = clip(typeof info.snapshot === 'string' ? info.snapshot.split(/[\\/]/).pop() : null, 200);
  const runId = info.runId !== undefined && info.runId !== null && /^\d+$/.test(String(info.runId)) ? String(info.runId) : null;
  const entry = JSON.stringify({ kind, detail, url, snapshot, run_id: runId === null ? null : Number(runId) });
  const T = 'coalesce($2::timestamptz, now())';
  const ENTRY = `($8::jsonb || jsonb_build_object('at', to_char(${T} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))`;
  const r = await client.query(
    `INSERT INTO ic_source_state AS s (source, consecutive_walls, last_wall_at, disabled_until, manual_disable, last_wall_kind, last_wall_detail, last_wall_url, last_wall_snapshot, last_wall_run_id, wall_history)
     VALUES ($1, 1, ${T}, ${T} + interval '24 hours', false, $3, $4, $5, $6, $7::bigint, jsonb_build_array(${ENTRY}))
     ON CONFLICT (source) DO UPDATE SET
       consecutive_walls = s.consecutive_walls + 1,
       last_wall_at = EXCLUDED.last_wall_at,
       manual_disable = s.manual_disable OR s.consecutive_walls + 1 >= 3,
       disabled_until = CASE WHEN s.consecutive_walls + 1 >= 3 THEN NULL WHEN s.consecutive_walls + 1 = 2 THEN ${T} + interval '72 hours' ELSE EXCLUDED.disabled_until END,
       last_wall_kind = EXCLUDED.last_wall_kind,
       last_wall_detail = EXCLUDED.last_wall_detail,
       last_wall_url = EXCLUDED.last_wall_url,
       last_wall_snapshot = EXCLUDED.last_wall_snapshot,
       last_wall_run_id = EXCLUDED.last_wall_run_id,
       wall_history = (
         SELECT coalesce(jsonb_agg(x.e ORDER BY x.i), '[]'::jsonb)
         FROM (SELECT t.e, t.i FROM jsonb_array_elements(s.wall_history || jsonb_build_array(${ENTRY})) WITH ORDINALITY AS t(e, i) ORDER BY t.i DESC LIMIT ${WALL_HISTORY_MAX}) x
       )
     RETURNING consecutive_walls`,
    [source, at, kind, detail, url, snapshot, runId, entry],
  );
  const n = Number(r.rows[0].consecutive_walls);
  return { consecutiveWalls: n, ...backoffFor(n) };
}

/**
 * Re-enable a source in one transaction: reset the counter and both disable flags, stamp reset_at, keep the
 * history (only entries after reset_at count toward the next "N failed scans"). last_wall_* stay as audit.
 * @param {import('pg').ClientBase} client
 * @param {string} source
 * @returns {Promise<string>} the stored source key
 */
export async function reenableSource(client, source) {
  await client.query('BEGIN');
  try {
    const r = await client.query(
      `INSERT INTO ic_source_state (source, consecutive_walls, disabled_until, manual_disable, reset_at) VALUES ($1, 0, NULL, false, now())
       ON CONFLICT (source) DO UPDATE SET consecutive_walls = 0, disabled_until = NULL, manual_disable = false, reset_at = now(), last_wall_at = ic_source_state.last_wall_at
       RETURNING source`,
      [source],
    );
    await client.query('COMMIT');
    return r.rows[0].source;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the original error is the one to surface */
    }
    throw err;
  }
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
