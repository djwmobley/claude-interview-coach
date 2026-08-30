// @ts-check
/**
 * Daily scan report (spec R1). Pure data collection + rendering; bin/remind.js and the scan_report tool
 * are the only callers that touch the DB marker or send email.
 *
 * "Since the last report" (spec R1.1) is tracked in the ic_report_state singleton table (sql/008), never
 * a file: last_report_sent_at advances ONLY after a confirmed send (decision 23), mirroring
 * followups.js's stampReminded; the on-demand scan_report tool (R1.4) NEVER writes it (decision 24). Day
 * bucketing for the "NO SCAN" weekday check (decision 26) uses an explicit IANA-zone Intl formatter, never
 * naive UTC ::date math (decision 25); the zone comes from config (run.timezone, default
 * America/Chicago).
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatDate } from './compact.js';
import { formatFollowup, selectDue, unsnoozeDue } from './followups.js';
import { repoRoot, DEFAULT_REPORT_HOME_MIN_PRESCORE } from './config.js';
import { normalizeLocation } from './normalize.js';
import { JobSearchError } from './errors.js';

/** Directory the markdown report is written to (spec R1.3), relative to the repo root; covered by the existing `/output/` .gitignore entry. */
export const REPORTS_DIR = path.join('output', 'reports');

/**
 * Wrap renderReportHtml()'s fragment in a minimal, self-contained "house CSS" page so the written
 * .html sibling (dashboard PR 1) renders reasonably as a standalone static file -- the dashboard's
 * report browser (PR 3) serves it inside a sandboxed iframe rather than re-rendering it.
 * @param {string} bodyHtml renderReportHtml() output
 * @param {string} dayKey YYYY-MM-DD
 */
export function wrapReportHtml(bodyHtml, dayKey) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Job scan report ${escapeHtml(dayKey)}</title>`,
    '<style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#ffffff}',
    'h2,h3{margin-top:1.75rem}',
    'ul{padding-left:1.25rem}',
    'a{color:#0b5fff}',
    '</style>',
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Write the markdown report to output/reports/YYYY-MM-DD-scan-report.md (spec R1.3), overwriting a
 * same-day file on a re-run. When `opts.html` is given (renderReportHtml()'s output for the same data),
 * also writes a `.html` sibling wrapped in wrapReportHtml() -- a day written before this option existed
 * has only the `.md` file, which the dashboard (PR 3) serves as plain text.
 * @param {string} markdown
 * @param {string} dayKey YYYY-MM-DD
 * @param {{ root?: string, html?: string }} [opts]
 * @returns {string} the .md file path written
 */
export function writeReportFile(markdown, dayKey, opts = {}) {
  const root = opts.root ?? repoRoot();
  const dir = path.join(root, REPORTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dayKey}-scan-report.md`);
  fs.writeFileSync(file, markdown.endsWith('\n') ? markdown : markdown + '\n');
  if (opts.html) {
    const htmlFile = path.join(dir, `${dayKey}-scan-report.html`);
    fs.writeFileSync(htmlFile, wrapReportHtml(opts.html, dayKey));
  }
  return file;
}

/**
 * Home locations (spec R1.2c "Houston / Texas") for a search profile, as location_norm values.
 * Extracted from bin/remind.js and the scan_report tool (dashboard PR 1) so the dashboard's report
 * routes resolve the identical set without a third copy.
 * @param {import('pg').ClientBase} client
 * @param {string} profileName
 * @returns {Promise<string[]>}
 */
export async function homeLocationNormsFor(client, profileName) {
  const r = await client.query('SELECT locations FROM ic_search_profiles WHERE name = $1', [profileName]);
  const locations = /** @type {string[]} */ (r.rows[0]?.locations ?? []);
  return [...new Set(locations.map((l) => normalizeLocation(l).location_norm).filter((n) => n && n !== 'absent'))];
}

/**
 * Resolve the (now, sinceOverride) window a report should cover, from either a specific run_id or an
 * explicit YYYY-MM-DD date in the report timezone, or neither. Extracted from the scan_report tool
 * (dashboard PR 1) so the dashboard's report-preview route resolves the identical window.
 *
 * sinceOverride is `undefined` when neither `date` nor `run_id` was given: the caller should then omit
 * `sinceOverride` from buildScanReport() entirely (not pass `undefined` as the key), so buildScanReport
 * falls back to the DB marker (ic_report_state) rather than treating "no bound" as an explicit override.
 * @param {import('pg').ClientBase} client
 * @param {{ date?: string|null, run_id?: number|null, timezone: string }} opts
 * @returns {Promise<{ now: Date, sinceOverride: Date|null|undefined }>}
 */
export async function resolveReportWindow(client, opts) {
  const timezone = opts.timezone;
  if (opts.run_id) {
    const runRow = await client.query('SELECT id, started_at, finished_at FROM ic_scan_runs WHERE id = $1', [opts.run_id]);
    if (runRow.rowCount === 0) throw new JobSearchError('NOT_FOUND', `run ${opts.run_id} not found`);
    const row = runRow.rows[0];
    const sinceOverride = new Date(new Date(row.started_at).getTime() - 1000);
    const now = row.finished_at ? new Date(row.finished_at) : new Date();
    return { now, sinceOverride };
  }
  if (opts.date) {
    const startUtcGuess = new Date(`${opts.date}T00:00:00`);
    // Resolve the requested calendar date's midnight in the report timezone precisely: adjust a UTC
    // guess until dayKeyInTz(guess, timezone) matches the requested date (handles DST without a
    // timezone-arithmetic library).
    let start = startUtcGuess;
    for (let i = 0; i < 30 && dayKeyInTz(start, timezone) !== opts.date; i++) {
      start = new Date(start.getTime() + (dayKeyInTz(start, timezone) < opts.date ? 1 : -1) * 3600000);
    }
    const sinceOverride = new Date(start.getTime() - 1000);
    const endOfDay = new Date(start.getTime() + 24 * 3600000);
    const now = endOfDay.getTime() < Date.now() ? endOfDay : new Date();
    return { now, sinceOverride };
  }
  return { now: new Date(), sinceOverride: undefined };
}

export const REPORT_STATUS_PRIORITY = Object.freeze({ failed: 3, partial: 2, locked: 1, running: 1, ok: 0 });

/**
 * @param {Date} date
 * @param {string} timezone IANA zone
 * @returns {string} YYYY-MM-DD in that zone
 */
export function dayKeyInTz(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * @param {Date} date
 * @param {string} timezone
 * @returns {boolean} true Mon-Fri in that zone
 */
export function isWeekdayInTz(date, timezone) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
  return !['Sat', 'Sun'].includes(wd);
}

/**
 * @param {Date} date
 * @param {string} timezone
 */
export function timeInTz(date, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/** @param {import('pg').ClientBase} client */
export async function getReportState(client) {
  const r = await client.query('SELECT last_report_sent_at, last_run_id_included FROM ic_report_state WHERE id = true');
  const row = r.rows[0] ?? { last_report_sent_at: null, last_run_id_included: null };
  return { lastReportSentAt: row.last_report_sent_at ? new Date(row.last_report_sent_at) : null, lastRunIdIncluded: row.last_run_id_included ?? null };
}

/**
 * Advance the report marker. Called ONLY after a confirmed send (decision 23); the scan_report tool
 * never calls this (decision 24).
 * @param {import('pg').ClientBase} client
 * @param {Date} now
 * @param {number|null} lastRunId
 */
export async function stampReportSent(client, now, lastRunId) {
  await client.query('UPDATE ic_report_state SET last_report_sent_at = $1, last_run_id_included = coalesce($2, last_run_id_included) WHERE id = true', [now, lastRunId]);
}

/**
 * HTML-escape (spec R1.5): every listing text field in the email goes through this before rendering.
 * @param {unknown} s
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Structural (registry: domain + path pattern) urlguard check for report rendering (spec R1.5): does NOT
 * perform the DNS/redirect steps classifyUrl() does for a live outbound request -- a report renders an
 * ALREADY-STORED url_normalized value, it does not fetch it, so re-resolving DNS at report time would add
 * latency and a network dependency for no safety benefit. A URL that fails this check is omitted, never
 * rendered as plain unlinked text (so nothing looks like a dead/broken link either -- see get_job for the
 * real URL if this ever happens).
 * @param {string|null|undefined} urlStr
 * @param {import('./urlguard.js').Registry} registry
 */
export function urlPassesRegistry(urlStr, registry) {
  if (typeof urlStr !== 'string' || !urlStr) return false;
  /** @type {URL} */
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') {
    if (u.protocol !== 'http:' || !registry.httpAllowedHosts.has(host)) return false;
  }
  const pathAndQuery = u.pathname + u.search;
  for (const entry of registry.entries) {
    if (!entry.domains.some((d) => host === d || host.endsWith('.' + d))) continue;
    if (entry.pathPatterns.some((p) => p.test(pathAndQuery))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RunSummary
 * @property {number} run_id
 * @property {string} profile
 * @property {string} status
 * @property {string} started_at ISO
 * @property {string|null} finished_at ISO
 * @property {number|null} duration_seconds
 * @property {Record<string, number>} stats
 * @property {Array<{ source: string|null, code: string, message: string }>} errors
 * @property {Record<string, number>} pages_by_source
 */

/**
 * Run summaries since the marker (spec R1.2a). A run counts as "since last report" by finished_at
 * (a still-running row is not yet reportable).
 * @param {import('pg').ClientBase} client
 * @param {Date|null} since
 */
export async function collectRuns(client, since) {
  const r = since
    ? await client.query(`SELECT id, profile, status, started_at, finished_at, stats, errors, pages_by_source FROM ic_scan_runs WHERE finished_at IS NOT NULL AND finished_at > $1 ORDER BY finished_at ASC`, [since])
    : await client.query(`SELECT id, profile, status, started_at, finished_at, stats, errors, pages_by_source FROM ic_scan_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
  return r.rows.map((row) => ({
    run_id: Number(row.id),
    profile: row.profile,
    status: row.status,
    started_at: new Date(row.started_at).toISOString(),
    finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    duration_seconds: row.finished_at ? Math.round((new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()) / 1000) : null,
    stats: row.stats ?? {},
    errors: Array.isArray(row.errors) ? row.errors : [],
    pages_by_source: row.pages_by_source ?? {},
  }));
}

/**
 * "Look at these" (spec R1.2b): top N by prescore among rows first_seen since the marker, excluding
 * noise-classified rows (R2.4: noise is never hidden from query_jobs/the DB, only this section narrows).
 * Also returns "also seen via <source>" siblings (decision 2): a Lensa/aggregator row sharing
 * company_norm+title_norm with an included ok row is folded under it, not listed separately.
 * @param {import('pg').ClientBase} client
 * @param {Date} since
 * @param {number} limit
 */
export async function collectLookAtThese(client, since, limit) {
  // Strict allow-list, never NULL: an unclassified row (noise_class IS NULL -- should be rare once
  // bin/migrate.js's backfill has run, but a row inserted by a code path outside normal scan/adoption
  // could still land here) is NOT-ok by default (independent-review fix), same as any other non-ok
  // class; it surfaces in collectSuspectAndUnclassified() instead, never silently in "Look at these".
  const top = await client.query(
    `SELECT id, title, company, location, remote_mode, salary_min, salary_max, prescore, source, url_normalized, url, company_norm, title_norm, location_norm
     FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND noise_class IN ('ok','ok_manual')
     ORDER BY prescore DESC NULLS LAST, id DESC LIMIT $2`,
    [since, limit],
  );
  const excludedCount = await client.query(
    `SELECT count(*)::int AS n FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND (noise_class IS NULL OR noise_class NOT IN ('ok','ok_manual'))`,
    [since],
  );
  /** @type {Map<number, string[]>} */
  const siblings = new Map();
  if (top.rows.length) {
    const pairs = top.rows.map((r) => [r.company_norm, r.title_norm]);
    const also = await client.query(
      `SELECT company_norm, title_norm, source FROM ic_job_listings
       WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
         AND (noise_class IS NULL OR noise_class NOT IN ('ok','ok_manual'))
         AND (company_norm, title_norm) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
      [since, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
    );
    for (const row of also.rows) {
      const owner = top.rows.find((t) => t.company_norm === row.company_norm && t.title_norm === row.title_norm);
      if (!owner) continue;
      const list = siblings.get(owner.id) ?? [];
      if (!list.includes(row.source)) list.push(row.source);
      siblings.set(owner.id, list);
    }
  }
  const alsoPosted = await collectAlsoPostedStates(client, top.rows);
  return {
    rows: top.rows.map((r) => ({ ...r, also_seen_via: siblings.get(r.id) ?? [], also_posted_states: alsoPosted.get(r.id) ?? [] })),
    excludedCount: excludedCount.rows[0].n,
  };
}

/**
 * Extracts the lowercase US state abbreviation from a location_norm value produced by normalizeLocation
 * ('remote-<iso>-<st>' or 'state-<st>'); null for every other shape (city-st, country-<iso>, absent,
 * legacy-unknown, unknown:*, or a remote-<iso> value with no state suffix).
 * @param {string|null|undefined} locationNorm
 */
function stateSuffixOf(locationNorm) {
  if (typeof locationNorm !== 'string') return null;
  const m = /^(?:remote-[a-z]{2}-|state-)([a-z]{2})$/.exec(locationNorm);
  return m ? m[1] : null;
}

/**
 * "Also posted" annotation (spec R6.3 verification): when the R6 state/remote backfill has merged one or
 * more same-listing-different-state postings into a row via duplicate_of (e.g. Gartner's "Executive
 * Partner - CIO Advisory" posted separately for Oklahoma and Arkansas), the merged-away rows stop
 * appearing as their own entries -- this recovers the other state(s) so the report shows ONE row
 * annotated with every state it represents, instead of silently dropping the fact that a merge happened.
 * Only rows carrying an extractable state (via stateSuffixOf) contribute; a merge with no parseable state
 * on either side is not annotated (there is nothing state-specific to report).
 * @param {import('pg').ClientBase} client
 * @param {{id: number, location_norm?: string|null}[]} rows
 * @returns {Promise<Map<number, string[]>>}
 */
async function collectAlsoPostedStates(client, rows) {
  /** @type {Map<number, string[]>} */
  const result = new Map();
  const ids = rows.map((r) => r.id);
  if (!ids.length) return result;
  const dup = await client.query(`SELECT id, duplicate_of, location_norm FROM ic_job_listings WHERE duplicate_of = ANY($1::int[])`, [ids]);
  /** @type {Map<number, string[]>} */
  const byRoot = new Map();
  for (const d of dup.rows) {
    const list = byRoot.get(d.duplicate_of) ?? [];
    list.push(d.location_norm);
    byRoot.set(d.duplicate_of, list);
  }
  for (const r of rows) {
    const childLocs = byRoot.get(r.id);
    if (!childLocs || !childLocs.length) continue;
    const states = new Set();
    const ownState = stateSuffixOf(r.location_norm);
    if (ownState) states.add(ownState.toUpperCase());
    for (const loc of childLocs) {
      const st = stateSuffixOf(loc);
      if (st) states.add(st.toUpperCase());
    }
    if (states.size > 1) result.set(r.id, [...states].sort());
  }
  return result;
}

/**
 * Suspect / unclassified (decision 7 + independent-review fix): a short, bounded, visible list of rows
 * that are noise_class='suspect' OR still NULL (unclassified) -- both are "not confirmed ok" and both
 * are surfaced here with their class, rather than silently folded into "Look at these" or left
 * invisible. This is the "separate short list" decision 7 calls for; NULL is included alongside
 * 'suspect' per the independent review, since an unclassified row deserves the same visibility.
 * @param {import('pg').ClientBase} client
 * @param {Date} since
 * @param {number} limit
 */
export async function collectSuspectAndUnclassified(client, since, limit) {
  const r = await client.query(
    `SELECT id, title, company, location, source, noise_class
     FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND (noise_class = 'suspect' OR noise_class IS NULL)
     ORDER BY id DESC LIMIT $2`,
    [since, limit],
  );
  return r.rows.map((row) => ({ ...row, noise_class: row.noise_class ?? 'unclassified' }));
}

/**
 * "Houston / Texas" (spec R1.2c): same first_seen window, filtered to the profile's home locations, with
 * a prescore floor (run.reportHomeMinPrescore, default 40 -- independent review round 2 fix: an
 * unfiltered "any prescore" list surfaced very low-relevance rows, e.g. an RN Clinical Director posting,
 * which the spec's own "any prescore" wording did not anticipate). Excluded count is reported the same
 * way collectLookAtThese() reports its own exclusions, so the operator can see rows were filtered, not
 * silently dropped.
 * @param {import('pg').ClientBase} client
 * @param {Date} since
 * @param {string[]} locationNorms
 * @param {number} minPrescore
 */
export async function collectHomeLocations(client, since, locationNorms, minPrescore) {
  if (!locationNorms.length) return { rows: [], excludedCount: 0 };
  const r = await client.query(
    `SELECT id, title, company, location, remote_mode, salary_min, salary_max, prescore, source, url_normalized, url
     FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND location_norm = ANY($2::text[]) AND coalesce(prescore, 0) >= $3
     ORDER BY prescore DESC NULLS LAST, id DESC LIMIT 25`,
    [since, locationNorms, minPrescore],
  );
  const excluded = await client.query(
    `SELECT count(*)::int AS n FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND location_norm = ANY($2::text[]) AND coalesce(prescore, 0) < $3`,
    [since, locationNorms, minPrescore],
  );
  return { rows: r.rows, excludedCount: excluded.rows[0].n };
}

/** @param {import('pg').ClientBase} client */
export async function collectReviewQueueSummary(client) {
  const total = await client.query(`SELECT count(*)::int AS n FROM ic_job_review_queue WHERE resolved_at IS NULL`);
  const reasons = await client.query(`SELECT reason, count(*)::int AS n FROM ic_job_review_queue WHERE resolved_at IS NULL GROUP BY reason ORDER BY n DESC LIMIT 5`);
  return { total: total.rows[0].n, topReasons: reasons.rows.map((r) => ({ reason: r.reason, count: r.n })) };
}

/** @param {import('pg').ClientBase} client */
export async function collectDisabledSources(client) {
  const r = await client.query(`SELECT source, disabled_until, manual_disable FROM ic_source_state WHERE manual_disable = true OR disabled_until > now() ORDER BY source`);
  return r.rows.map((row) => ({ source: row.source, until: row.manual_disable ? null : row.disabled_until ? new Date(row.disabled_until).toISOString() : null, manual: row.manual_disable }));
}

// ---------------------------------------------------------------------------
// buildScanReport: gathers everything, decides subject prefixes, but does NOT send or stamp anything
// ---------------------------------------------------------------------------

/**
 * @param {import('pg').ClientBase} client
 * @param {{ now?: Date, timezone?: string, topN?: number, homeLocationNorms?: string[], homeMinPrescore?: number, profile?: string, sinceOverride?: Date|null }} [opts]
 *   sinceOverride bypasses the DB marker read entirely (test seam / on-demand scan_report with an explicit
 *   date, spec R1.4): when provided (including explicitly null, meaning "no lower bound"), it is used as
 *   `since` instead of ic_report_state.last_report_sent_at. homeMinPrescore defaults to 40
 *   (run.reportHomeMinPrescore); see collectHomeLocations().
 */
export async function buildScanReport(client, opts = {}) {
  const now = opts.now ?? new Date();
  const timezone = opts.timezone ?? 'America/Chicago';
  const topN = opts.topN ?? 10;
  const homeMinPrescore = opts.homeMinPrescore ?? DEFAULT_REPORT_HOME_MIN_PRESCORE;
  const homeLocationNorms = opts.homeLocationNorms ?? [];
  const overriding = Object.prototype.hasOwnProperty.call(opts, 'sinceOverride');
  const state = overriding ? { lastReportSentAt: null, lastRunIdIncluded: null } : await getReportState(client);
  const effectiveSince = overriding ? opts.sinceOverride : state.lastReportSentAt;
  // Fall back to 24h ago when there is no lower bound (no prior marker and no explicit override), so the
  // first report ever sent is not empty just because there is no history to bound "since" against.
  const since = effectiveSince ?? new Date(now.getTime() - 24 * 3600000);
  const runs = await collectRuns(client, effectiveSince ? since : null);
  const noScan = runs.length === 0 && isWeekdayInTz(now, timezone);
  const lookAtThese = await collectLookAtThese(client, since, topN);
  const suspectUnclassified = await collectSuspectAndUnclassified(client, since, 10);
  const homeLocations = await collectHomeLocations(client, since, homeLocationNorms, homeMinPrescore);
  const reviewQueue = await collectReviewQueueSummary(client);
  const disabledSources = await collectDisabledSources(client);
  const worstStatus = runs.reduce((worst, r) => (REPORT_STATUS_PRIORITY[r.status] ?? 0) > (REPORT_STATUS_PRIORITY[worst] ?? 0) ? r.status : worst, 'ok');
  return {
    now,
    timezone,
    since: since.toISOString(),
    dayKey: dayKeyInTz(now, timezone),
    runs,
    noScan,
    worstStatus,
    lookAtThese,
    suspectUnclassified,
    homeLocations,
    reviewQueue,
    disabledSources,
    lastRunIdIncluded: runs.length ? runs[runs.length - 1].run_id : state.lastRunIdIncluded,
  };
}

// ---------------------------------------------------------------------------
// Rendering: text, HTML, markdown. Followups are rendered by the caller's own section (remind.js already
// has buildDigest); buildReportSubject/renderReportText/Html/Markdown below cover ONLY the scan-report
// content (R1.2 a-e); the caller concatenates its existing follow-ups section (f) after.
// ---------------------------------------------------------------------------

/**
 * @param {Awaited<ReturnType<typeof buildScanReport>>} data
 * @param {{ followupsDue?: number }} [extra]
 */
export function buildReportSubject(data, extra = {}) {
  const prefixes = [];
  if (data.noScan) prefixes.push('[NO SCAN]');
  else if (data.worstStatus !== 'ok') prefixes.push(`[SCAN ${String(data.worstStatus).toUpperCase()}]`);
  const parts = [`Job scan report ${data.dayKey}`];
  const newCount = data.lookAtThese.rows.length;
  parts.push(`${newCount} to look at`);
  if (data.reviewQueue.total) parts.push(`${data.reviewQueue.total} in review`);
  if (extra.followupsDue) parts.push(`${extra.followupsDue} follow-up${extra.followupsDue === 1 ? '' : 's'} due`);
  return [...prefixes, parts.join(', ')].join(' ');
}

/**
 * Short formatted salary string (e.g. "$150k-$200k"), reused verbatim by the auto-triage model prompt
 * (src/core/triage.js's loadListingsForBatch) so the model sees the exact same shape a human reading
 * the daily report would.
 * @param {{ salary_min: number|null, salary_max: number|null }} r
 */
export function salaryText(r) {
  const hasMin = typeof r.salary_min === 'number';
  const hasMax = typeof r.salary_max === 'number';
  if (!hasMin && !hasMax) return 'n/a';
  if (hasMin && hasMax) return `$${Math.round(r.salary_min / 1000)}k-$${Math.round(r.salary_max / 1000)}k`;
  return hasMin ? `$${Math.round(r.salary_min / 1000)}k+` : `to $${Math.round(r.salary_max / 1000)}k`;
}

/**
 * Human-readable text for a rejected auto-triage model batch's reason (mirrors
 * src/core/triage.js's describeTriageFailure(), duplicated here rather than imported to avoid a
 * report.js <-> triage.js circular module dependency for one small pure mapping).
 * @param {string|null|undefined} reason
 */
function triageFailureText(reason) {
  if (typeof reason === 'string' && reason.startsWith('cli_exit_')) return `exited ${reason.slice('cli_exit_'.length)}`;
  if (reason === 'timeout') return 'timed out';
  if (reason === 'malformed_json') return 'returned malformed output';
  if (reason === 'schema_violation') return 'returned invalid results';
  if (reason === 'unknown_id') return 'returned an unrequested id';
  return 'failed';
}

/**
 * One auto-triage report line (slice 3 spec section 6) for a single run's `stats.triage`. Returns null
 * when `triage` is absent (a run from before this feature shipped, or an old row) so the caller omits
 * the line entirely rather than printing a placeholder.
 * @param {any} triage
 */
export function renderTriageLine(triage) {
  if (!triage) return null;
  if (triage.error) return `triage: failed (${triage.error})`;
  if (!triage.configured) return 'triage: not configured (no config/triage.json; deterministic and model triage are off)';
  const d = triage.deterministic ?? {};
  const m = triage.model ?? {};
  const autoSkipped = (d.skip_noise ?? 0) + (d.skip_low ?? 0);
  const autoNew = d.auto_new ?? 0;
  const base = `triage: ${autoSkipped} auto-skipped, ${autoNew} auto-new`;
  if (!m.enabled) {
    const reasonText = m.reason === 'candidate_summary_missing' ? ': candidate summary missing' : '';
    return `${base}, ${d.model_band ?? 0} sent to model (model scoring disabled${reasonText})`;
  }
  const sentToModel = (m.scored ?? 0) + (m.unscored ?? 0);
  if (m.batches_failed > 0) {
    return `${base}, ${sentToModel} sent to model, ${m.scored ?? 0} of ${sentToModel} scored, claude -p ${triageFailureText(m.last_failure_reason)}`;
  }
  if (m.batches_zero_scored > 0) {
    return `${base}, ${sentToModel} sent to model, ${m.scored ?? 0} scored, ${m.batches_zero_scored} of ${m.batches_sent} batches scored nothing (check the prompt)`;
  }
  return `${base}, ${sentToModel} sent to model, ${m.scored ?? 0} scored`;
}

/**
 * Plain-text rendering (spec R1.2, no em-dashes, US English).
 * @param {Awaited<ReturnType<typeof buildScanReport>>} data
 * @param {import('./urlguard.js').Registry} [registry] when given, a listing's url is printed if it passes urlguard (R1.5)
 */
export function renderReportText(data, registry) {
  const lines = [];
  lines.push(`Job scan report for ${data.dayKey} (times ${data.timezone})`);
  lines.push('');
  if (data.noScan) {
    lines.push('NO SCAN: no scan run has completed since the last report, on a day one was expected.');
    lines.push('');
  }
  lines.push('== Runs since last report ==');
  if (data.runs.length === 0) lines.push('(none)');
  for (const r of data.runs) {
    const s = r.stats;
    const banner = r.status !== 'ok' ? `[${String(r.status).toUpperCase()}] ` : '';
    lines.push(`${banner}run #${r.run_id} | profile ${r.profile} | status ${r.status} | started ${r.started_at} | duration ${r.duration_seconds ?? '?'}s`);
    lines.push(`  fetched ${s.fetched ?? 0} | new ${s.new ?? 0} | updated ${s.updated ?? 0} | repost ${s.repost ?? 0} | ambiguous ${s.ambiguous ?? 0} | detail_skipped_budget ${s.detail_skipped_budget ?? 0}`);
    if (Object.keys(r.pages_by_source).length) lines.push(`  pages by source: ${Object.entries(r.pages_by_source).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    const triageLine = renderTriageLine(s.triage);
    if (triageLine) lines.push(`  ${triageLine}`);
    for (const e of r.errors.slice(0, 5)) lines.push(`  error: ${e.source ?? 'run'} ${e.code}: ${String(e.message ?? '').slice(0, 200)}`);
  }
  lines.push('');
  lines.push(`== Look at these (top ${data.lookAtThese.rows.length}) ==`);
  if (data.lookAtThese.excludedCount) lines.push(`(${data.lookAtThese.excludedCount} noise-classified row(s) excluded from this list; they are still in the database)`);
  if (data.lookAtThese.rows.length === 0) lines.push('(none)');
  for (const r of data.lookAtThese.rows) {
    const url = urlPassesRegistry(r.url_normalized ?? r.url, registry ?? { entries: [], httpAllowedHosts: new Set() }) ? (r.url_normalized ?? r.url) : null;
    const also = r.also_seen_via.length ? ` (also seen via ${r.also_seen_via.join(', ')})` : '';
    const alsoPosted = r.also_posted_states && r.also_posted_states.length ? ` (also posted: ${r.also_posted_states.join(', ')})` : '';
    lines.push(`#${r.id} | ${r.title} | ${r.company} | ${r.location ?? 'n/a'} | ${salaryText(r)} | ps ${r.prescore ?? 0} | ${r.source}${also}${alsoPosted}${url ? ` | ${url}` : ''}`);
  }
  lines.push('');
  lines.push(`== Suspect / unclassified (${data.suspectUnclassified.length}) ==`);
  if (data.suspectUnclassified.length === 0) lines.push('(none)');
  for (const r of data.suspectUnclassified) lines.push(`#${r.id} | ${r.title} | ${r.company} | ${r.location ?? 'n/a'} | ${r.source} | ${r.noise_class}`);
  lines.push('');
  lines.push('== Houston / Texas ==');
  if (data.homeLocations.excludedCount) lines.push(`(${data.homeLocations.excludedCount} row(s) below the prescore floor excluded from this list; they are still in the database)`);
  if (data.homeLocations.rows.length === 0) lines.push('(none)');
  for (const r of data.homeLocations.rows) {
    const url = urlPassesRegistry(r.url_normalized ?? r.url, registry ?? { entries: [], httpAllowedHosts: new Set() }) ? (r.url_normalized ?? r.url) : null;
    lines.push(`#${r.id} | ${r.title} | ${r.company} | ${r.location ?? 'n/a'} | ${salaryText(r)} | ps ${r.prescore ?? 0} | ${r.source}${url ? ` | ${url}` : ''}`);
  }
  lines.push('');
  lines.push(`== Review queue: ${data.reviewQueue.total} open ==`);
  for (const t of data.reviewQueue.topReasons) lines.push(`  ${t.reason}: ${t.count}`);
  lines.push('');
  lines.push('== Disabled sources ==');
  if (data.disabledSources.length === 0) lines.push('(none)');
  for (const s of data.disabledSources) lines.push(`  ${s.source}: ${s.manual ? 'manual disable' : `until ${s.until}`}`);
  return lines.join('\n');
}

/**
 * HTML rendering (spec R1.2, every listing text field escaped per R1.5).
 * @param {Awaited<ReturnType<typeof buildScanReport>>} data
 * @param {import('./urlguard.js').Registry} [registry]
 */
export function renderReportHtml(data, registry) {
  const esc = escapeHtml;
  const reg = registry ?? { entries: [], httpAllowedHosts: new Set() };
  const linkOrText = (/** @type {any} */ r) => {
    const url = urlPassesRegistry(r.url_normalized ?? r.url, reg) ? (r.url_normalized ?? r.url) : null;
    return url ? `<a href="${esc(url)}">${esc(r.title)}</a>` : esc(r.title);
  };
  const rowLi = (/** @type {any} */ r, /** @type {boolean} */ withAlso) => {
    const also = withAlso && r.also_seen_via && r.also_seen_via.length ? ` (also seen via ${esc(r.also_seen_via.join(', '))})` : '';
    const alsoPosted = withAlso && r.also_posted_states && r.also_posted_states.length ? ` (also posted: ${esc(r.also_posted_states.join(', '))})` : '';
    return `<li>#${r.id} ${linkOrText(r)} at ${esc(r.company)}, ${esc(r.location ?? 'n/a')}, ${esc(salaryText(r))}, ps ${r.prescore ?? 0}, ${esc(r.source)}${also}${alsoPosted}</li>`;
  };
  const parts = [];
  parts.push(`<h2>Job scan report for ${esc(data.dayKey)} (times ${esc(data.timezone)})</h2>`);
  if (data.noScan) parts.push('<p><strong>NO SCAN</strong>: no scan run has completed since the last report, on a day one was expected.</p>');
  parts.push('<h3>Runs since last report</h3>');
  if (data.runs.length === 0) parts.push('<p>(none)</p>');
  else {
    parts.push('<ul>');
    for (const r of data.runs) {
      const s = r.stats;
      const banner = r.status !== 'ok' ? `<strong>[${esc(String(r.status).toUpperCase())}]</strong> ` : '';
      const errs = r.errors.slice(0, 5).map((e) => `<br>error: ${esc(e.source ?? 'run')} ${esc(e.code)}: ${esc(String(e.message ?? '').slice(0, 200))}`).join('');
      const triageLine = renderTriageLine(s.triage);
      const triageHtml = triageLine ? `<br>${esc(triageLine)}` : '';
      parts.push(`<li>${banner}run #${r.run_id}, profile ${esc(r.profile)}, status ${esc(r.status)}, started ${esc(r.started_at)}, duration ${r.duration_seconds ?? '?'}s<br>fetched ${s.fetched ?? 0}, new ${s.new ?? 0}, updated ${s.updated ?? 0}, repost ${s.repost ?? 0}, ambiguous ${s.ambiguous ?? 0}, detail_skipped_budget ${s.detail_skipped_budget ?? 0}${triageHtml}${errs}</li>`);
    }
    parts.push('</ul>');
  }
  parts.push(`<h3>Look at these (top ${data.lookAtThese.rows.length})</h3>`);
  if (data.lookAtThese.excludedCount) parts.push(`<p>(${data.lookAtThese.excludedCount} noise-classified row(s) excluded from this list; they are still in the database)</p>`);
  parts.push(data.lookAtThese.rows.length ? `<ul>${data.lookAtThese.rows.map((r) => rowLi(r, true)).join('')}</ul>` : '<p>(none)</p>');
  parts.push(`<h3>Suspect / unclassified (${data.suspectUnclassified.length})</h3>`);
  parts.push(data.suspectUnclassified.length ? `<ul>${data.suspectUnclassified.map((r) => `<li>#${r.id} ${esc(r.title)} at ${esc(r.company)}, ${esc(r.location ?? 'n/a')}, ${esc(r.source)}, ${esc(r.noise_class)}</li>`).join('')}</ul>` : '<p>(none)</p>');
  parts.push('<h3>Houston / Texas</h3>');
  if (data.homeLocations.excludedCount) parts.push(`<p>(${data.homeLocations.excludedCount} row(s) below the prescore floor excluded from this list; they are still in the database)</p>`);
  parts.push(data.homeLocations.rows.length ? `<ul>${data.homeLocations.rows.map((r) => rowLi(r, false)).join('')}</ul>` : '<p>(none)</p>');
  parts.push(`<h3>Review queue: ${data.reviewQueue.total} open</h3>`);
  parts.push(data.reviewQueue.topReasons.length ? `<ul>${data.reviewQueue.topReasons.map((t) => `<li>${esc(t.reason)}: ${t.count}</li>`).join('')}</ul>` : '<p>(none)</p>');
  parts.push('<h3>Disabled sources</h3>');
  parts.push(data.disabledSources.length ? `<ul>${data.disabledSources.map((s) => `<li>${esc(s.source)}: ${s.manual ? 'manual disable' : `until ${esc(s.until)}`}</li>`).join('')}</ul>` : '<p>(none)</p>');
  return parts.join('\n');
}

/**
 * Markdown rendering for output/reports/YYYY-MM-DD-scan-report.md (spec R1.3): the same content as the
 * text rendering, in markdown headings, so it reads well both as a file and pasted into a session.
 * @param {Awaited<ReturnType<typeof buildScanReport>>} data
 * @param {import('./urlguard.js').Registry} [registry]
 */
export function renderReportMarkdown(data, registry) {
  const reg = registry ?? { entries: [], httpAllowedHosts: new Set() };
  const lines = [];
  lines.push(`# Job scan report for ${data.dayKey}`);
  lines.push('');
  lines.push(`Times shown in ${data.timezone}.`);
  lines.push('');
  if (data.noScan) {
    lines.push('**NO SCAN**: no scan run has completed since the last report, on a day one was expected.');
    lines.push('');
  }
  lines.push('## Runs since last report');
  lines.push('');
  if (data.runs.length === 0) lines.push('(none)');
  for (const r of data.runs) {
    const s = r.stats;
    const banner = r.status !== 'ok' ? `**[${String(r.status).toUpperCase()}]** ` : '';
    lines.push(`- ${banner}run #${r.run_id}, profile ${r.profile}, status ${r.status}, started ${r.started_at}, duration ${r.duration_seconds ?? '?'}s`);
    lines.push(`  fetched ${s.fetched ?? 0}, new ${s.new ?? 0}, updated ${s.updated ?? 0}, repost ${s.repost ?? 0}, ambiguous ${s.ambiguous ?? 0}, detail_skipped_budget ${s.detail_skipped_budget ?? 0}`);
    if (Object.keys(r.pages_by_source).length) lines.push(`  pages by source: ${Object.entries(r.pages_by_source).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    const triageLine = renderTriageLine(s.triage);
    if (triageLine) lines.push(`  ${triageLine}`);
    for (const e of r.errors.slice(0, 5)) lines.push(`  error: ${e.source ?? 'run'} ${e.code}: ${String(e.message ?? '').slice(0, 200)}`);
  }
  lines.push('');
  lines.push(`## Look at these (top ${data.lookAtThese.rows.length})`);
  lines.push('');
  if (data.lookAtThese.excludedCount) lines.push(`(${data.lookAtThese.excludedCount} noise-classified row(s) excluded from this list; they are still in the database)`);
  if (data.lookAtThese.rows.length === 0) lines.push('(none)');
  for (const r of data.lookAtThese.rows) {
    const url = urlPassesRegistry(r.url_normalized ?? r.url, reg) ? (r.url_normalized ?? r.url) : null;
    const also = r.also_seen_via.length ? ` (also seen via ${r.also_seen_via.join(', ')})` : '';
    const alsoPosted = r.also_posted_states && r.also_posted_states.length ? ` (also posted: ${r.also_posted_states.join(', ')})` : '';
    lines.push(`- #${r.id} ${r.title} at ${r.company}, ${r.location ?? 'n/a'}, ${salaryText(r)}, ps ${r.prescore ?? 0}, ${r.source}${also}${alsoPosted}${url ? ` (${url})` : ''}`);
  }
  lines.push('');
  lines.push(`## Suspect / unclassified (${data.suspectUnclassified.length})`);
  lines.push('');
  if (data.suspectUnclassified.length === 0) lines.push('(none)');
  for (const r of data.suspectUnclassified) lines.push(`- #${r.id} ${r.title} at ${r.company}, ${r.location ?? 'n/a'}, ${r.source}, ${r.noise_class}`);
  lines.push('');
  lines.push('## Houston / Texas');
  lines.push('');
  if (data.homeLocations.excludedCount) lines.push(`(${data.homeLocations.excludedCount} row(s) below the prescore floor excluded from this list; they are still in the database)`);
  if (data.homeLocations.rows.length === 0) lines.push('(none)');
  for (const r of data.homeLocations.rows) {
    const url = urlPassesRegistry(r.url_normalized ?? r.url, reg) ? (r.url_normalized ?? r.url) : null;
    lines.push(`- #${r.id} ${r.title} at ${r.company}, ${r.location ?? 'n/a'}, ${salaryText(r)}, ps ${r.prescore ?? 0}, ${r.source}${url ? ` (${url})` : ''}`);
  }
  lines.push('');
  lines.push(`## Review queue: ${data.reviewQueue.total} open`);
  lines.push('');
  for (const t of data.reviewQueue.topReasons) lines.push(`- ${t.reason}: ${t.count}`);
  lines.push('');
  lines.push('## Disabled sources');
  lines.push('');
  if (data.disabledSources.length === 0) lines.push('(none)');
  for (const s of data.disabledSources) lines.push(`- ${s.source}: ${s.manual ? 'manual disable' : `until ${s.until}`}`);
  return lines.join('\n');
}

// Re-exported so callers building the combined follow-ups + scan-report email do not need a second
// import for the follow-ups helpers report.js itself does not otherwise depend on.
export { formatFollowup, selectDue, unsnoozeDue, formatDate };
