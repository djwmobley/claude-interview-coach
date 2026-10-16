// @ts-check
/**
 * Date helpers for the target runner (plan 17). Every date is a calendar day in America/New_York (ET), written
 * YYYY-MM-DD. A business day is Monday to Friday; there is no holiday calendar (a holiday shows up as an empty
 * Form D day, which the suspicious_empty rule handles).
 *
 *   bd(0) = the latest business day on or before today (today itself on a weekday)
 *   bd(1) = the business day before bd(0)      never marked covered (late indexing)
 *   bd(2) = the business day before bd(1)      the newest day the cursor may reach
 *
 * Pure: no clock except the Date passed in.
 */

export const TARGET_TZ = 'America/New_York';
const DAY_MS = 86_400_000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {Date} date @returns {string} the ET calendar day */
export function etDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TARGET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** @param {unknown} v @returns {v is string} */
export function isYmd(v) {
  if (typeof v !== 'string' || !YMD_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** @param {string} ymd @returns {number} UTC ms of the day start */
function ms(ymd) {
  return Date.parse(`${ymd}T00:00:00Z`);
}

/** @param {string} ymd @param {number} n @returns {string} */
export function addDays(ymd, n) {
  return new Date(ms(ymd) + n * DAY_MS).toISOString().slice(0, 10);
}

/** @param {string} ymd @returns {boolean} Monday to Friday */
export function isBusinessDay(ymd) {
  const d = new Date(ms(ymd)).getUTCDay();
  return d !== 0 && d !== 6;
}

/** @param {string} ymd @returns {string} the latest business day on or before ymd */
export function lastBusinessDayOnOrBefore(ymd) {
  let d = ymd;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

/** @param {string} ymd @returns {string} the business day strictly before ymd */
export function prevBusinessDay(ymd) {
  let d = addDays(ymd, -1);
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

/**
 * @param {string} today ET day
 * @returns {{ bd0: string, bd1: string, bd2: string }}
 */
export function businessDayAnchors(today) {
  const bd0 = lastBusinessDayOnOrBefore(today);
  const bd1 = prevBusinessDay(bd0);
  return { bd0, bd1, bd2: prevBusinessDay(bd1) };
}

/**
 * Business days d with after < d <= through, oldest first.
 * @param {string} after exclusive lower bound
 * @param {string} through inclusive upper bound
 * @returns {string[]}
 */
export function businessDaysBetween(after, through) {
  /** @type {string[]} */
  const out = [];
  for (let d = addDays(after, 1); d <= through; d = addDays(d, 1)) if (isBusinessDay(d)) out.push(d);
  return out;
}

/**
 * The slices a source must read: the business days after the cursor through bd(0); with no cursor, from
 * `lookbackDays` calendar days before today. Oldest first.
 * @param {{ cursor: string|null, today: string, lookbackDays: number }} o
 * @returns {string[]}
 */
export function sliceDays({ cursor, today, lookbackDays }) {
  const { bd0 } = businessDayAnchors(today);
  const after = cursor && isYmd(cursor) ? cursor : addDays(today, -Math.max(1, lookbackDays) - 1);
  return businessDaysBetween(after, bd0);
}

/**
 * Business days that are old enough to be covered (<= bd(2)) but are not: after the cursor, or after the
 * first-run lookback start when there is no cursor.
 * @param {{ cursor: string|null, today: string, lookbackDays: number }} o
 * @returns {number}
 */
export function backlogDays({ cursor, today, lookbackDays }) {
  const { bd2 } = businessDayAnchors(today);
  const after = cursor && isYmd(cursor) ? cursor : addDays(today, -Math.max(1, lookbackDays) - 1);
  return businessDaysBetween(after, bd2).length;
}

/** @param {Date} date @returns {boolean} true Monday to Friday in ET */
export function isEtWeekday(date) {
  return isBusinessDay(etDay(date));
}
