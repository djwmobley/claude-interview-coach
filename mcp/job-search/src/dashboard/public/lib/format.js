// @ts-check
/**
 * Pure formatting helpers, no DOM access, so they run identically under node:test (pr3-spec-decisions.md
 * section 12, item 2) and in the browser. US spelling and copy rules apply to every returned string.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "3d ago" / "2h ago" / "5m ago" / "just now" / "in 2d" for a future date. `null`/invalid input renders
 * as the fixed placeholder, never throws and never prints "Invalid Date".
 * @param {string|Date|null|undefined} value
 * @param {Date} [now]
 */
export function relativeTime(value, now = new Date()) {
  if (value === null || value === undefined) return 'unknown';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const diffMs = now.getTime() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.floor(abs / 60000);
  const hours = Math.floor(abs / 3600000);
  const days = Math.floor(abs / DAY_MS);
  /** @type {string} */
  let core;
  if (minutes < 1) core = 'just now';
  else if (minutes < 60) core = `${minutes}m`;
  else if (hours < 24) core = `${hours}h`;
  else if (days < 30) core = `${days}d`;
  else core = d.toISOString().slice(0, 10);
  if (core === 'just now') return core;
  return future ? `in ${core}` : `${core} ago`;
}

/**
 * Age in whole days since `firstSeen`, clamped to 0. Used for the aging-chip thresholds (design's age()
 * function: under 7 / 7-14 / over 14).
 * @param {string|Date|null|undefined} firstSeen
 * @param {Date} [now]
 * @returns {number|null}
 */
export function ageDays(firstSeen, now = new Date()) {
  if (!firstSeen) return null;
  const d = firstSeen instanceof Date ? firstSeen : new Date(firstSeen);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS));
}

/**
 * Aging-chip bucket: 'fresh' (<7d), 'aging' (7-14d), 'stale' (>14d). null input maps to 'fresh' (no
 * data reads as not-yet-aging, never as an error state).
 * @param {number|null} days
 */
export function agingBucket(days) {
  if (days === null || days < 7) return 'fresh';
  if (days <= 14) return 'aging';
  return 'stale';
}

/**
 * Score bucket: 'good' (>=85), 'ok' (>=70), 'low' (below 70 or missing). Matches the design's score()
 * thresholds exactly.
 * @param {number|null|undefined} score
 */
export function scoreBucket(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return 'low';
  const n = Number(score);
  if (n >= 85) return 'good';
  if (n >= 70) return 'ok';
  return 'low';
}

/**
 * Format an ISO date/datetime string as a short human date, e.g. "Aug 27". Invalid/missing input
 * renders as a placeholder dash-free string, never throws.
 * @param {string|Date|null|undefined} value
 */
export function shortDate(value) {
  if (!value) return 'not set';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'not set';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format a datetime for display, e.g. "Aug 27, 9:00 AM".
 * @param {string|Date|null|undefined} value
 */
export function shortDateTime(value) {
  if (!value) return 'not set';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'not set';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** @param {number|null|undefined} n */
export function formatMoney(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'not listed';
  return `$${Number(n).toLocaleString('en-US')}`;
}

/**
 * Salary range as "N to M" or a single value; "not listed" when both are absent.
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 */
export function salaryRange(min, max) {
  if (min == null && max == null) return 'not listed';
  if (min != null && max != null && min !== max) return `${formatMoney(min)} to ${formatMoney(max)}`;
  return formatMoney(min ?? max);
}

/** Pluralize a simple count-noun pair, e.g. count(3, 'item') -> "3 items". @param {number} n @param {string} noun */
export function pluralize(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Clamp text to a max length with a trailing ellipsis marker (three periods, never an en/em dash). @param {string} s @param {number} max */
export function truncate(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * A source's display label; sentence case, US spelling. Unknown sources fall back to their raw value
 * title-cased rather than a blank string (totality: every input maps to a string).
 * @param {string|null|undefined} source
 */
export function sourceLabel(source) {
  const known = {
    greenhouse: 'Greenhouse', lever: 'Lever', linkedin: 'LinkedIn', indeed: 'Indeed',
    builtin: 'BuiltIn', ziprecruiter: 'ZipRecruiter', manual: 'Manual',
  };
  if (!source) return 'Unknown';
  if (known[source]) return known[source];
  return source.length ? source[0].toUpperCase() + source.slice(1) : 'Unknown';
}

/** Render a percentage from a 0-1 fraction, or a fixed placeholder when null (no data yet). @param {number|null|undefined} frac */
export function formatPercent(frac) {
  if (frac === null || frac === undefined || Number.isNaN(Number(frac))) return 'not enough data yet';
  return `${Math.round(Number(frac) * 100)}%`;
}

/**
 * Total normalizer for one Google Calendar-shaped `start` (or `end`) value, as returned in the `events`
 * array of GET /api/calendar/agenda. The real Google Calendar API resource never carries a bare
 * `startIso`/`start_at` field -- it is always `start: { dateTime, timeZone }` for a timed event or
 * `start: { date }` for an all-day event (Calendar's own date field has no time-of-day at all). Earlier
 * front-end code read `e.start ?? e.startIso ?? e.start_at`, none of which matched that real shape, which
 * is why the Calendar page crashed blank against a live Google event: `e.start` is an object, so
 * `new Date(object)` produced an Invalid Date that then broke on `.toISOString()` downstream.
 *
 * Every input maps to a branch here, never throws, and callers never need a try/catch:
 * - a bare ISO string -> `{ at: <ISO>, allDay: false }` (kept for any caller that already has a flat
 *   string, e.g. a follow-up's `due_at`)
 * - `{ dateTime }` -> `{ at: <ISO>, allDay: false }`
 * - `{ date }` (all-day) -> `{ at: <ISO>, allDay: true }`
 * - `null`/`undefined` (no start at all) -> `{ at: null, allDay: false }`
 * - anything else -- wrong type, an object with neither `dateTime` nor `date`, or a string/dateTime/date
 *   value that fails to parse as a real date -- is the unknown/failure branch and returns `null`, so a
 *   caller can filter it out of a rendered agenda rather than showing "Invalid Date" or crashing.
 * @param {unknown} start
 * @returns {{ at: string|null, allDay: boolean } | null}
 */
export function normalizeAgendaTime(start) {
  if (start === null || start === undefined) return { at: null, allDay: false };
  if (typeof start === 'string') {
    const d = new Date(start);
    return Number.isNaN(d.getTime()) ? null : { at: d.toISOString(), allDay: false };
  }
  if (typeof start === 'object' && !Array.isArray(start)) {
    const obj = /** @type {Record<string, unknown>} */ (start);
    if (typeof obj.dateTime === 'string') {
      const d = new Date(obj.dateTime);
      return Number.isNaN(d.getTime()) ? null : { at: d.toISOString(), allDay: false };
    }
    if (typeof obj.date === 'string') {
      const d = new Date(obj.date);
      return Number.isNaN(d.getTime()) ? null : { at: d.toISOString(), allDay: true };
    }
  }
  return null;
}

/**
 * Display label for one agenda item's time: the normal short datetime for a timed item, or the date
 * plus a plain "all day" marker (no dash) for an all-day item. `at: null` (a normalized-but-empty start)
 * falls back to the same "not set" placeholder `shortDateTime`/`shortDate` already use.
 * @param {{ at: string|null, allDay: boolean }} normalized
 */
export function agendaTimeLabel(normalized) {
  if (normalized.allDay) {
    return normalized.at ? `${shortDate(normalized.at)}, all day` : 'not set';
  }
  return shortDateTime(normalized.at);
}
