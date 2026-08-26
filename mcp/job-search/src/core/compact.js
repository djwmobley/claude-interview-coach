// @ts-check
/**
 * Compact rendering for MCP tool responses (spec section 5 caps).
 *
 *   MAX_ROWS 25, LINE_CHARS 120, MAX_RESPONSE_CHARS 6000.
 *   Row: `#412 | CTO | Mercy Ships | Houston, TX (hybrid) | 2026-08-21 | $250-300k | ps 72 | new | linkedin`
 *   Dry-run rows render `#dry:N` and the response carries a warning.
 */

export const MAX_ROWS = 25;
export const LINE_CHARS = 120;
export const MAX_RESPONSE_CHARS = 6000;

export const DRY_RUN_WARNING = 'dry run: ids are not persisted; network activity is unchanged';

/**
 * @typedef {Object} CompactRowInput
 * @property {number|null|undefined} id
 * @property {string} title
 * @property {string} company
 * @property {string|null} [location]
 * @property {string|null} [remote_mode]
 * @property {string|Date|null} [posted_at]
 * @property {number|null} [salary_min]
 * @property {number|null} [salary_max]
 * @property {number|null} [prescore]
 * @property {number|null} [fit_score]
 * @property {string|null} [status]
 * @property {string|null} [source]
 * @property {string|null} [outcome]
 */

/** @param {string} s @param {number} n */
export function truncate(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return n <= 1 ? str.slice(0, n) : str.slice(0, n - 1) + '~';
}

/** @param {number} n */
function k(n) {
  if (n >= 1000) {
    const v = n / 1000;
    return Number.isInteger(v) ? `${v}k` : `${Math.round(v)}k`;
  }
  return String(n);
}

/**
 * `$250-300k`, `$250k+`, `to $300k`, or '' when unknown.
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 */
export function formatSalary(min, max) {
  const hasMin = typeof min === 'number' && Number.isFinite(min);
  const hasMax = typeof max === 'number' && Number.isFinite(max);
  if (hasMin && hasMax) {
    if (min === max) return `$${k(min)}`;
    const a = k(/** @type {number} */ (min));
    const b = k(/** @type {number} */ (max));
    if (a.endsWith('k') && b.endsWith('k')) return `$${a.slice(0, -1)}-${b}`;
    return `$${a}-${b}`;
  }
  if (hasMin) return `$${k(/** @type {number} */ (min))}+`;
  if (hasMax) return `to $${k(/** @type {number} */ (max))}`;
  return '';
}

/** @param {string|Date|null|undefined} d */
export function formatDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

/**
 * @param {CompactRowInput} row
 * @param {{ dry?: boolean, index?: number }} [opts]
 * @returns {string} one line, at most LINE_CHARS
 */
export function formatRow(row, opts = {}) {
  const id = opts.dry ? `#dry:${opts.index ?? 0}` : `#${row.id ?? '?'}`;
  let loc = String(row.location ?? '').trim();
  if (row.remote_mode === 'remote' && !/remote/i.test(loc)) loc = loc ? `${loc} (remote)` : 'remote';
  else if (row.remote_mode === 'hybrid' && !/hybrid/i.test(loc)) loc = loc ? `${loc} (hybrid)` : 'hybrid';
  const parts = [
    id,
    truncate(row.title, 40),
    truncate(row.company, 28),
    truncate(loc, 24),
    formatDate(row.posted_at),
    formatSalary(row.salary_min, row.salary_max),
    typeof row.prescore === 'number' ? `ps ${row.prescore}` : '',
    typeof row.fit_score === 'number' ? `fit ${row.fit_score}` : '',
    row.status ?? (row.outcome ? row.outcome : 'unscored'),
    row.source ?? '',
  ].filter((p) => p !== '');
  return truncate(parts.join(' | '), LINE_CHARS);
}

/**
 * Cap a row list: at most `limit` (<= MAX_ROWS) rows, each <= LINE_CHARS.
 * @param {CompactRowInput[]} rows
 * @param {{ limit?: number, dry?: boolean, offset?: number }} [opts]
 * @returns {{ rows: string[], truncated: boolean, total: number, warnings: string[] }}
 */
export function compactRows(rows, opts = {}) {
  const limit = Math.max(1, Math.min(MAX_ROWS, opts.limit ?? MAX_ROWS));
  const offset = Math.max(0, opts.offset ?? 0);
  const slice = rows.slice(offset, offset + limit);
  const out = slice.map((r, i) => formatRow(r, { dry: opts.dry, index: offset + i + 1 }));
  const warnings = opts.dry ? [DRY_RUN_WARNING] : [];
  return { rows: out, truncated: rows.length > offset + limit, total: rows.length, warnings };
}

/**
 * Enforce MAX_RESPONSE_CHARS on a response object that has a `rows: string[]`
 * field: drop rows from the end until the JSON fits, marking `truncated` and
 * adding a hint. Other fields are left alone; if the object still does not
 * fit with zero rows, `warnings` receives a note and the object is returned
 * as-is (callers keep non-row fields small by construction).
 * @template {{ rows?: string[], truncated?: boolean, warnings?: string[], hint?: string }} T
 * @param {T} response
 * @param {{ maxChars?: number, hint?: string }} [opts]
 * @returns {T}
 */
export function capResponse(response, opts = {}) {
  const max = opts.maxChars ?? MAX_RESPONSE_CHARS;
  const size = (/** @type {unknown} */ o) => JSON.stringify(o).length;
  if (size(response) <= max) return response;
  const out = { ...response, rows: [...(response.rows ?? [])], warnings: [...(response.warnings ?? [])] };
  if (out.rows.length === 0) {
    out.warnings.push(`response exceeds ${max} chars even with no rows`);
    return out;
  }
  // Reserve space for the truncation markers before trimming so they never push the result back over the cap.
  out.truncated = true;
  if (opts.hint && !out.hint) out.hint = opts.hint;
  while (out.rows.length > 0 && size(out) > max) out.rows.pop();
  if (size(out) > max) out.warnings.push(`response exceeds ${max} chars even with no rows`);
  return out;
}
