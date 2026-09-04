// @ts-check
/**
 * Auto-apply candidate selection (auto-apply PR B, docs/auto-apply-spec.md). bin/auto-apply.js's "select"
 * phase: given every listing the "prepare" phase already tried to resolve an apply target for, decide
 * which ones are eligible to actually submit through today, and WHY every other one is not -- a total,
 * closed classification (CLOSED_REASONS below), never an allow-list. Every listing this module looks at
 * maps to exactly one reason, `eligible` included, so a listing this code has never seen a shape for still
 * gets a visible, correctable reason rather than silently vanishing from the report.
 *
 * isUsLocation is likewise total over src/core/normalize.js's REAL location_norm vocabulary (see that
 * module and src/core/salary-floor.js's own doc comment for the exact shapes): 'country-us', any
 * 'state-<abbr>' value (normalizeLocation only ever produces that prefix for a recognized US state name),
 * any 'remote-us*' value, and a bare '<slug>-<US state abbreviation>' city form are US; every other value
 * -- including 'country-<other-iso>', 'remote-<other-iso>*', a bare 'remote' with no country signal,
 * 'absent', 'legacy-unknown', and any 'unknown:<sha1>' value -- is non-US. The bare city-form branch is
 * checked LAST and only after every other prefixed shape has already been ruled out, specifically so a
 * value like 'country-de' (Germany) is never mistaken for a US state just because its ISO code happens to
 * collide with a state abbreviation (Delaware, 'de') -- the same defensive ordering
 * src/core/salary-floor.js's own TEXAS_RE comment calls out for the identical class of collision.
 */
import { US_ABBRS } from './normalize.js';
import { resolveFloor } from './salary-floor.js';
import { ABSENT_LOCATION, LEGACY_UNKNOWN_LOCATION } from './normalize.js';
import { HOURLY_RE } from '../apply/answers.js';
import { classifyExclusion, EXCLUSION_BRANCHES, loadExclusionConfig } from '../apply/exclusions.js';
import { loadConfig } from './config.js';

/**
 * Hourly-pay signal (Damian's ruling, spec item D): true when `salaryPeriod === 'hour'` (the structured,
 * migration-016 column -- authoritative whenever set), OR `salaryPeriod` is null/undefined AND
 * `salaryRaw` (NEVER `description` -- a job's prose routinely mentions "hourly" in unrelated benefits
 * copy) contains the same HOURLY_RE cue answers.js's compensation gate uses, with the cue within 12
 * characters of a dollar figure either direction -- "Pays $45/hr" and "$45 hourly rate" both signal;
 * "Hourly wellness stipend available; $65,000/year base" does not, because the dollar figure nearest the
 * hourly cue in that string is well outside a 12-character window. A listing with neither a period nor a
 * salary_raw carrying this proximity pattern is simply unaffected -- this function returns false, never a
 * third "unknown" outcome that would need its own handling.
 * @param {string|null|undefined} salaryPeriod
 * @param {string|null|undefined} salaryRaw
 * @returns {boolean}
 */
export const HOURLY_NEAR_DOLLAR_RE = new RegExp(
  `\\$\\s?\\d[\\d,.]*.{0,12}(?:${HOURLY_RE.source})|(?:${HOURLY_RE.source}).{0,12}\\$\\s?\\d[\\d,.]*`,
  'i',
);

export function isHourlyPaySignal(salaryPeriod, salaryRaw) {
  if (salaryPeriod === 'hour') return true;
  if ((salaryPeriod === null || salaryPeriod === undefined) && typeof salaryRaw === 'string' && HOURLY_NEAR_DOLLAR_RE.test(salaryRaw)) {
    return true;
  }
  return false;
}

/**
 * Total classification: every string maps to US or non-US, never a third "unknown" branch. See the
 * module doc comment for the exact vocabulary and the Germany/Delaware ("country-de") collision this
 * ordering deliberately avoids.
 * @param {string|null|undefined} locationNorm
 * @returns {boolean}
 */
export function isUsLocation(locationNorm) {
  const loc = typeof locationNorm === 'string' ? locationNorm.trim().toLowerCase() : '';
  if (!loc) return false;
  if (loc === ABSENT_LOCATION || loc === LEGACY_UNKNOWN_LOCATION) return false;
  if (loc.startsWith('unknown:')) return false;
  if (loc === 'country-us') return true;
  if (loc.startsWith('country-')) return false;
  if (loc.startsWith('state-')) return true;
  if (loc.startsWith('remote-us')) return true;
  if (loc.startsWith('remote-')) return false;
  if (loc === 'remote') return false;
  const m = /^[a-z0-9'.-]+-([a-z]{2})$/.exec(loc);
  return Boolean(m && US_ABBRS.has(m[1]));
}

/** The closed, total reason enum every candidate maps to (see the module doc comment). Order here is also
 * the evaluation precedence: the first matching branch wins, exactly like src/core/salary-floor.js's own
 * "first match wins" total classification. */
export const CLOSED_REASONS = Object.freeze([
  // Apply exclusion gate (src/apply/exclusions.js): runs before every reason below, one 'exclusion_'-
  // prefixed reason per non-eligible EXCLUSION_BRANCHES entry (its own 'eligible' branch simply falls
  // through to the checks below, never adding a reason of its own).
  ...EXCLUSION_BRANCHES.filter((b) => b !== 'eligible').map((b) => `exclusion_${b}`),
  'not_scored', 'below_fit', 'human_fit_override', 'duplicate_of', 'not_us', 'salary_below_floor',
  'active_application', 'no_description', 'apply_target_unresolved', 'easy_apply_only', 'ats_not_allowed',
  'confidence_not_exact', 'hourly_pay', 'daily_cap', 'eligible',
]);

/**
 * @typedef {Object} CandidateRow
 * @property {number} listingId
 * @property {number|null} fitScore ic_job_listings.fit_score
 * @property {string|null} fitActor actor of the most recent ic_job_events kind='fit' row for this
 *   listing, or null when no fit event has ever been recorded (a listing whose fit_score was set some
 *   other way, or never scored at all)
 * @property {number|null} duplicateOf ic_job_listings.duplicate_of
 * @property {string|null} locationNorm
 * @property {string|null} remoteMode
 * @property {number|null} salaryMax
 * @property {string|null} [salaryPeriod] ic_job_listings.salary_period ('hour'|'day'|'week'|'month'|
 *   'year'|'unknown'), or null for a pre-migration-016 row
 * @property {string|null} [salaryRaw] ic_job_listings.salary_raw -- consulted for the hourly_pay signal
 *   ONLY when salaryPeriod is null/undefined; never `description`, which routinely mentions "hourly" in
 *   unrelated benefits copy
 * @property {boolean} hasActiveApplication a non-withdrawn ic_job_applications row already exists
 * @property {string|null} description
 * @property {string|null} applyUrl
 * @property {string|null} applyAts
 * @property {string|null} applyConfidence
 * @property {boolean} applyEasyOnly
 * @property {string|null} [company] ic_job_listings.company -- apply exclusion gate input
 * @property {string|null} [companyNorm] ic_job_listings.company_norm -- apply exclusion gate input
 * @property {string|null} [title] ic_job_listings.title -- apply exclusion gate input
 * @property {string|null} [titleNorm] ic_job_listings.title_norm -- apply exclusion gate input
 * @property {string|null} [sourceUrl] ic_job_listings.url_normalized (falling back to url) -- apply
 *   exclusion gate's blocked_company_suspect check
 */

/**
 * Classify one candidate row against the closed reason enum. Pure, total, never throws: an unrecognized
 * shape still falls through the ordered checks to a real branch (missing salaryMax never disqualifies on
 * its own -- only a POSITIVELY KNOWN salary max below the floor does, mirroring resolveFloor's own
 * "friction over silent escape" ethos of never inventing a disqualifying category from absent data).
 * @param {CandidateRow} row
 * @param {{ fitFloor: number, floors: import('./salary-floor.js').SalaryFloors, atsAllow: string[] }} ctx
 * @returns {Exclude<typeof CLOSED_REASONS[number], 'daily_cap'>}
 */
export function classifyCandidate(row, ctx) {
  if (row.duplicateOf !== null && row.duplicateOf !== undefined) return 'duplicate_of';
  if (row.fitScore === null || row.fitScore === undefined) return 'not_scored';
  if (row.fitScore < ctx.fitFloor) {
    // Human-set fit always wins over model fit (locked decision): a below-floor score a human deliberately
    // set is reported distinctly from an automatic model-driven exclusion, even though both exclude the
    // candidate identically.
    return row.fitActor && row.fitActor !== 'auto' ? 'human_fit_override' : 'below_fit';
  }
  if (!isUsLocation(row.locationNorm)) return 'not_us';
  const floor = resolveFloor({ locationNorm: row.locationNorm, remoteMode: row.remoteMode }, ctx.floors);
  if (typeof row.salaryMax === 'number' && row.salaryMax < floor) return 'salary_below_floor';
  if (row.hasActiveApplication) return 'active_application';
  if (typeof row.description !== 'string' || row.description.trim().length === 0) return 'no_description';
  if (row.applyEasyOnly) return 'easy_apply_only';
  if (!row.applyUrl || !row.applyAts) return 'apply_target_unresolved';
  if (!ctx.atsAllow.includes(row.applyAts)) return 'ats_not_allowed';
  if (row.applyConfidence !== 'exact') return 'confidence_not_exact';
  if (isHourlyPaySignal(row.salaryPeriod ?? null, row.salaryRaw ?? null)) return 'hourly_pay';
  return 'eligible';
}

/**
 * Total classification: the apply exclusion gate (src/apply/exclusions.js), then -- only when that
 * returns 'eligible' -- everything classifyCandidate() already checks. Requires a DB client because the
 * exclusion gate's already_applied_listing/previously_withdrawn/already_applied_history branches all query
 * ic_job_listings/ic_job_applications (dedup-tree walking and title similarity are not computable from a
 * plain row object alone).
 * @param {import('pg').ClientBase} client
 * @param {CandidateRow} row
 * @param {{ fitFloor: number, floors: import('./salary-floor.js').SalaryFloors, atsAllow: string[], exclusionConfig: import('../apply/exclusions.js').ExclusionConfig }} ctx
 * @returns {Promise<Exclude<typeof CLOSED_REASONS[number], 'daily_cap'>>}
 */
export async function classifyCandidateWithExclusions(client, row, ctx) {
  const excl = await classifyExclusion(
    {
      id: row.listingId, company: row.company ?? null, companyNorm: row.companyNorm ?? null,
      title: row.title ?? null, titleNorm: row.titleNorm ?? null, applyUrl: row.applyUrl ?? null,
      sourceUrl: row.sourceUrl ?? null, description: row.description ?? null,
    },
    { client, config: ctx.exclusionConfig },
  );
  if (excl.branch !== 'eligible') return /** @type {any} */ (`exclusion_${excl.branch}`);
  return classifyCandidate(row, ctx);
}

/**
 * Dedup on the resolved (ats, url) pair (spec: "dedup on resolved (apply_ats, apply_url) before
 * selection"): among rows classifyCandidate already marked 'eligible', keep only the FIRST occurrence of
 * each distinct pair in the given order (callers pass rows already sorted best-first, e.g. fit_score
 * descending) -- every later row sharing that exact pair is downgraded to 'duplicate_of', the same
 * listing-level dedup outcome a shared ic_job_listings.duplicate_of would have produced, just discovered
 * one level later (after apply-target resolution rather than before it).
 * @param {Array<{ row: CandidateRow, reason: string }>} classified rows already classified, in priority order
 * @returns {Array<{ row: CandidateRow, reason: string }>}
 */
export function dedupResolvedTargets(classified) {
  /** @type {Set<string>} */
  const seen = new Set();
  return classified.map((entry) => {
    if (entry.reason !== 'eligible') return entry;
    // ' || ' is a safe delimiter here: applyAts is a lowercase ATS identifier (e.g. 'workday',
    // 'icims') and applyUrl is a URL string, neither of which contains this sequence.
    const key = `${entry.row.applyAts} || ${entry.row.applyUrl}`;
    if (seen.has(key)) return { row: entry.row, reason: 'duplicate_of' };
    seen.add(key);
    return entry;
  });
}

/**
 * Applies the daily cap (spec: "Cap counts only actor=auto approved transitions since America/Chicago
 * midnight... a review FAIL never consumes a slot"): among rows still 'eligible' after dedup, in the given
 * order, keeps only the first `remaining` and downgrades the rest to 'daily_cap'. `remaining` is computed
 * by the caller (selectCandidates below) from the day's already-consumed slots; this function itself is a
 * pure slicing operation with no notion of time or the database.
 * @param {Array<{ row: CandidateRow, reason: string }>} classified rows already dedup'd, in priority order
 * @param {number} remaining
 * @returns {Array<{ row: CandidateRow, reason: string }>}
 */
export function applyDailyCap(classified, remaining) {
  let slots = Math.max(0, remaining);
  return classified.map((entry) => {
    if (entry.reason !== 'eligible') return entry;
    if (slots > 0) {
      slots--;
      return entry;
    }
    return { row: entry.row, reason: 'daily_cap' };
  });
}

/**
 * @param {Date} date
 * @param {string} timezone IANA zone
 * @returns {string} YYYY-MM-DD in that zone (mirrors src/core/report.js's dayKeyInTz -- duplicated rather
 *   than imported to avoid a report.js <-> auto-apply-select.js circular dependency for one small helper)
 */
function dayKeyInTz(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The instant of local midnight, in `timezone`, for the calendar day `now` falls on. No timezone-
 * arithmetic library dependency (same technique src/core/report.js's resolveReportWindow already uses):
 * step backward from `now` until the local day key changes, then refine to the minute.
 * @param {Date} now
 * @param {string} timezone
 * @returns {Date}
 */
export function startOfDayInTz(now, timezone) {
  const targetKey = dayKeyInTz(now, timezone);
  let t = now.getTime();
  const stepMs = 15 * 60000;
  while (dayKeyInTz(new Date(t - stepMs), timezone) === targetKey) t -= stepMs;
  let boundary = t;
  while (dayKeyInTz(new Date(boundary - 60000), timezone) === targetKey) boundary -= 60000;
  return new Date(boundary);
}

/**
 * Count of today's already-consumed auto-apply slots (spec: actor='auto' approved transitions since local
 * midnight; a review FAIL never reaches 'approved' so it never consumes a slot -- no separate filter is
 * needed here for that, it falls out of only counting the 'approved' transition itself).
 * @param {import('pg').ClientBase} client
 * @param {Date} now
 * @param {string} timezone
 * @returns {Promise<number>}
 */
export async function countAutoApprovedToday(client, now, timezone) {
  const since = startOfDayInTz(now, timezone);
  const r = await client.query(
    `SELECT count(*)::int AS n FROM ic_job_application_events WHERE kind = 'state' AND to_state = 'approved' AND actor = 'auto' AND created_at >= $1`,
    [since],
  );
  return Number(r.rows[0].n);
}

/**
 * Default candidate-row fetch: every non-expired, non-duplicate listing row that has EVER been probed for
 * an apply target (apply_probed_at IS NOT NULL) OR already carries a description, restricted to the
 * triage/untriaged pipeline group (never a listing already applied/closed) with no active application.
 * Overridable via opts.fetchCandidateRows for tests, which never touch a real database.
 * @param {import('pg').ClientBase} client
 * @returns {Promise<CandidateRow[]>}
 */
export async function fetchCandidateRows(client) {
  const r = await client.query(`
    SELECT
      l.id AS listing_id, l.fit_score, l.duplicate_of, l.location_norm, l.remote_mode,
      l.salary_max, l.salary_period, l.salary_raw, l.description, l.apply_url, l.apply_ats, l.apply_ats_confidence, l.apply_easy_only,
      l.company, l.company_norm, l.title, l.title_norm, coalesce(l.url_normalized, l.url) AS source_url,
      (SELECT actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'fit' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS fit_actor,
      EXISTS (SELECT 1 FROM ic_job_applications a WHERE a.listing_id = l.id AND a.state <> 'withdrawn') AS has_active_application
    FROM ic_job_listings l
    WHERE coalesce(l.record_kind, 'listing') = 'listing'
      AND l.duplicate_of IS NULL
      AND l.expired_at IS NULL
      AND (l.status IS NULL OR l.status IN ('new', 'maybe', 'shortlisted'))
    ORDER BY l.fit_score DESC NULLS LAST, l.id ASC
  `);
  return r.rows.map((row) => ({
    listingId: Number(row.listing_id),
    fitScore: row.fit_score === null ? null : Number(row.fit_score),
    fitActor: row.fit_actor ?? null,
    duplicateOf: row.duplicate_of === null ? null : Number(row.duplicate_of),
    locationNorm: row.location_norm ?? null,
    remoteMode: row.remote_mode ?? null,
    salaryMax: row.salary_max === null ? null : Number(row.salary_max),
    salaryPeriod: row.salary_period ?? null,
    salaryRaw: row.salary_raw ?? null,
    hasActiveApplication: Boolean(row.has_active_application),
    description: row.description ?? null,
    applyUrl: row.apply_url ?? null,
    applyAts: row.apply_ats ?? null,
    applyConfidence: row.apply_ats_confidence ?? null,
    applyEasyOnly: Boolean(row.apply_easy_only),
    company: row.company ?? null,
    companyNorm: row.company_norm ?? null,
    title: row.title ?? null,
    titleNorm: row.title_norm ?? null,
    sourceUrl: row.source_url ?? null,
  }));
}

/**
 * @typedef {Object} SelectResult
 * @property {Array<{ listingId: number, reason: string }>} results every considered row, one reason each
 * @property {CandidateRow[]} eligible the rows selected to actually apply through this run, in order
 * @property {number} capUsed slots already consumed today before this run
 * @property {number} capRemaining slots left after `eligible` (never negative)
 */

/**
 * Full select phase: fetch, classify, dedup, cap. Total and deterministic given the same input rows and
 * `now` -- no randomness, no hidden state.
 * @param {import('pg').ClientBase} client
 * @param {{ fitFloor: number, floors: import('./salary-floor.js').SalaryFloors, atsAllow: string[], dailyCap: number, now: Date, timezone: string, fetchCandidateRows?: (client: import('pg').ClientBase) => Promise<CandidateRow[]>, countAutoApprovedToday?: (client: import('pg').ClientBase, now: Date, timezone: string) => Promise<number>, exclusionConfig?: import('../apply/exclusions.js').ExclusionConfig, classifyCandidateWithExclusions?: (client: import('pg').ClientBase, row: CandidateRow, ctx: any) => Promise<string> }} opts
 * @returns {Promise<SelectResult>}
 */
export async function selectCandidates(client, opts) {
  const fetchRows = opts.fetchCandidateRows ?? fetchCandidateRows;
  const countToday = opts.countAutoApprovedToday ?? countAutoApprovedToday;
  // Test seam: a caller exercising only the dedup/cap logic (no real DB client, no apply-exclusions.json
  // on disk) can inject a stub here -- e.g. `async (c, row, ctx) => classifyCandidate(row, ctx)` -- to skip
  // the exclusion gate's own DB queries entirely. Production code (bin/auto-apply.js) never sets this.
  const classify = opts.classifyCandidateWithExclusions ?? classifyCandidateWithExclusions;
  const rows = await fetchRows(client);
  // Apply exclusion gate config (spec: "auto-apply loads once per run"): loaded once here, reused for
  // every row this call classifies. A missing/invalid file throws CONFIG_INVALID and this whole select
  // phase aborts -- bin/auto-apply.js's own top-level catch turns that into the run's non-zero exit and
  // [NO APPLY] report line (spec section 2), exactly like every other hard-error config in this pipeline.
  const exclusionConfig = opts.exclusionConfig ?? loadExclusionConfig(loadConfig().configDir);
  const ctx = { fitFloor: opts.fitFloor, floors: opts.floors, atsAllow: opts.atsAllow, exclusionConfig };
  const classified = [];
  for (const row of rows) {
    classified.push({ row, reason: await classify(client, row, ctx) });
  }
  const deduped = dedupResolvedTargets(classified);
  const capUsed = await countToday(client, opts.now, opts.timezone);
  const remaining = Math.max(0, opts.dailyCap - capUsed);
  const capped = applyDailyCap(deduped, remaining);
  const eligible = capped.filter((e) => e.reason === 'eligible').map((e) => e.row);
  return {
    results: capped.map((e) => ({ listingId: e.row.listingId, reason: e.reason })),
    eligible,
    capUsed,
    capRemaining: Math.max(0, remaining - eligible.length),
  };
}
