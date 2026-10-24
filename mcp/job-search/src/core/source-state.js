// @ts-check
/**
 * Why is a source off? One place turns an ic_source_state row into the sentence every surface shows (text,
 * HTML and markdown reports, the dashboard Home and Runs pages), so the wording cannot drift between them.
 *
 *   latched : "auto-disabled after 3 failed scans (2026-10-08, 2026-10-09, 2026-10-12): <reason>"
 *   backoff : "paused until <time> after 1 failed scan: <reason>"
 *
 * N and the dates come from wall_history entries AFTER reset_at (a re-enable resets the count but keeps the
 * history). A row with no history (written before sql/028) falls back to consecutive_walls and last_wall_at.
 * A NULL kind renders "reason not recorded". The reason is only ever shown for a source that is currently
 * disabled or paused: the query below returns no other rows.
 *
 * Values here are plain strings; every surface escapes them for its own format (the reports through esc(),
 * the dashboard through textContent).
 */

const NO_REASON = 'reason not recorded';

/**
 * @typedef {Object} SourceStateRow
 * @property {string} source
 * @property {boolean} manual_disable
 * @property {Date|string|null} disabled_until
 * @property {number|null} [consecutive_walls]
 * @property {Date|string|null} [last_wall_at]
 * @property {string|null} [last_wall_kind]
 * @property {string|null} [last_wall_detail]
 * @property {string|null} [last_wall_url]
 * @property {string|null} [last_wall_snapshot]
 * @property {Date|string|null} [reset_at]
 * @property {any} [wall_history]
 */

/**
 * @typedef {Object} DisabledSource
 * @property {string} source
 * @property {boolean} manual true when latched (needs a re-enable), false when paused until `until`
 * @property {string|null} until ISO time the pause ends (null when latched)
 * @property {string|null} since ISO time of the last wall
 * @property {number} count failed scans since the last reset
 * @property {string[]} dates YYYY-MM-DD of each counted failed scan
 * @property {string|null} kind
 * @property {string} reason
 * @property {string|null} url
 * @property {string|null} snapshot file name of the saved page, when one exists
 * @property {string} text the full sentence
 */

/** @param {unknown} v @returns {number|null} */
function ms(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(/** @type {any} */ (v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/** @param {unknown} v @returns {string|null} */
function iso(v) {
  const t = ms(v);
  return t === null ? null : new Date(t).toISOString();
}

/**
 * Wall history entries that count toward "N failed scans": those after reset_at. Total over malformed
 * history: anything that is not an object with a parseable time is skipped.
 * @param {SourceStateRow} row
 * @returns {Array<{ at: string }>}
 */
export function countedWalls(row) {
  const resetMs = ms(row.reset_at);
  const hist = Array.isArray(row.wall_history) ? row.wall_history : [];
  /** @type {Array<{ at: string }>} */
  const out = [];
  for (const e of hist) {
    const at = e && typeof e === 'object' ? iso(e.at) : null;
    if (at === null) continue;
    if (resetMs !== null && new Date(at).getTime() <= resetMs) continue;
    out.push({ at });
  }
  return out;
}

/** @param {SourceStateRow} row @returns {string} */
function reasonOf(row) {
  const kind = typeof row.last_wall_kind === 'string' && row.last_wall_kind ? row.last_wall_kind : null;
  if (!kind) return NO_REASON;
  const detail = typeof row.last_wall_detail === 'string' && row.last_wall_detail ? row.last_wall_detail : null;
  return detail ? `${kind}, ${detail}` : kind;
}

/**
 * @param {SourceStateRow} row a row that is currently latched or in backoff
 * @returns {DisabledSource}
 */
export function describeDisabledSource(row) {
  const manual = Boolean(row.manual_disable);
  const until = manual ? null : iso(row.disabled_until);
  const counted = countedWalls(row);
  let count = counted.length;
  let dates = counted.map((e) => e.at.slice(0, 10));
  if (count === 0) {
    const walls = Math.max(0, Number(row.consecutive_walls ?? 0));
    const last = iso(row.last_wall_at);
    count = walls;
    dates = walls > 0 && last ? [last.slice(0, 10)] : [];
  }
  const reason = reasonOf(row);
  const plural = `${count} failed scan${count === 1 ? '' : 's'}`;
  let text;
  if (manual) {
    text = count > 0
      ? `auto-disabled after ${plural}${dates.length ? ` (${dates.join(', ')})` : ''}: ${reason}`
      : `disabled with no failed scans on record: ${reason}`;
  } else {
    text = `paused until ${until ?? 'unknown'} after ${count > 0 ? plural : 'a failed scan'}: ${reason}`;
  }
  const snap = typeof row.last_wall_snapshot === 'string' && row.last_wall_snapshot ? row.last_wall_snapshot : null;
  return {
    source: String(row.source),
    manual,
    until,
    since: iso(row.last_wall_at),
    count,
    dates,
    kind: typeof row.last_wall_kind === 'string' && row.last_wall_kind ? row.last_wall_kind : null,
    reason,
    url: typeof row.last_wall_url === 'string' && row.last_wall_url ? row.last_wall_url : null,
    snapshot: snap,
    text,
  };
}

/**
 * The JSON the dashboard receives for one disabled source (Home and Runs render it with textContent).
 * @param {DisabledSource} s
 */
export function disabledSourceView(s) {
  return { source: s.source, manual: s.manual, until: s.until, text: s.text, kind: s.kind, reason: s.reason, count: s.count, dates: s.dates, url: s.url, snapshot: s.snapshot };
}

/**
 * Every source that is latched or paused right now, with its sentence.
 * @param {import('pg').ClientBase} client
 * @returns {Promise<DisabledSource[]>}
 */
export async function collectDisabledSourceStates(client) {
  const r = await client.query(
    `SELECT source, disabled_until, manual_disable, consecutive_walls, last_wall_at, last_wall_kind, last_wall_detail,
            last_wall_url, last_wall_snapshot, reset_at, wall_history
     FROM ic_source_state WHERE manual_disable = true OR disabled_until > now() ORDER BY source`,
  );
  return r.rows.map(describeDisabledSource);
}
