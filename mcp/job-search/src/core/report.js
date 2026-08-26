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
import { repoRoot } from './config.js';

/** Directory the markdown report is written to (spec R1.3), relative to the repo root; covered by the existing `/output/` .gitignore entry. */
export const REPORTS_DIR = path.join('output', 'reports');

/**
 * Write the markdown report to output/reports/YYYY-MM-DD-scan-report.md (spec R1.3), overwriting a
 * same-day file on a re-run.
 * @param {string} markdown
 * @param {string} dayKey YYYY-MM-DD
 * @param {{ root?: string }} [opts]
 * @returns {string} the file path written
 */
export function writeReportFile(markdown, dayKey, opts = {}) {
  const root = opts.root ?? repoRoot();
  const dir = path.join(root, REPORTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dayKey}-scan-report.md`);
  fs.writeFileSync(file, markdown.endsWith('\n') ? markdown : markdown + '\n');
  return file;
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
  const top = await client.query(
    `SELECT id, title, company, location, remote_mode, salary_min, salary_max, prescore, source, url_normalized, url, company_norm, title_norm
     FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND (noise_class IS NULL OR noise_class IN ('ok','ok_manual'))
     ORDER BY prescore DESC NULLS LAST, id DESC LIMIT $2`,
    [since, limit],
  );
  const excludedCount = await client.query(
    `SELECT count(*)::int AS n FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND noise_class IS NOT NULL AND noise_class NOT IN ('ok','ok_manual')`,
    [since],
  );
  /** @type {Map<number, string[]>} */
  const siblings = new Map();
  if (top.rows.length) {
    const pairs = top.rows.map((r) => [r.company_norm, r.title_norm]);
    const also = await client.query(
      `SELECT company_norm, title_norm, source FROM ic_job_listings
       WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
         AND noise_class IS NOT NULL AND noise_class NOT IN ('ok','ok_manual')
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
  return {
    rows: top.rows.map((r) => ({ ...r, also_seen_via: siblings.get(r.id) ?? [] })),
    excludedCount: excludedCount.rows[0].n,
  };
}

/**
 * "Houston / Texas" (spec R1.2c): same first_seen window, filtered to the profile's home locations, ANY
 * prescore (no ranking cut). location_norm values are derived from the profile's own `locations` list.
 * @param {import('pg').ClientBase} client
 * @param {Date} since
 * @param {string[]} locationNorms
 */
export async function collectHomeLocations(client, since, locationNorms) {
  if (!locationNorms.length) return [];
  const r = await client.query(
    `SELECT id, title, company, location, remote_mode, salary_min, salary_max, prescore, source, url_normalized, url
     FROM ic_job_listings
     WHERE first_seen > $1 AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       AND location_norm = ANY($2::text[])
     ORDER BY prescore DESC NULLS LAST, id DESC LIMIT 25`,
    [since, locationNorms],
  );
  return r.rows;
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
 * @param {{ now?: Date, timezone?: string, topN?: number, homeLocationNorms?: string[], profile?: string, sinceOverride?: Date|null }} [opts]
 *   sinceOverride bypasses the DB marker read entirely (test seam / on-demand scan_report with an explicit
 *   date, spec R1.4): when provided (including explicitly null, meaning "no lower bound"), it is used as
 *   `since` instead of ic_report_state.last_report_sent_at.
 */
export async function buildScanReport(client, opts = {}) {
  const now = opts.now ?? new Date();
  const timezone = opts.timezone ?? 'America/Chicago';
  const topN = opts.topN ?? 10;
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
  const homeLocations = await collectHomeLocations(client, since, homeLocationNorms);
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

/** @param {{ salary_min: number|null, salary_max: number|null }} r */
function salaryText(r) {
  const hasMin = typeof r.salary_min === 'number';
  const hasMax = typeof r.salary_max === 'number';
  if (!hasMin && !hasMax) return 'n/a';
  if (hasMin && hasMax) return `$${Math.round(r.salary_min / 1000)}k-$${Math.round(r.salary_max / 1000)}k`;
  return hasMin ? `$${Math.round(r.salary_min / 1000)}k+` : `to $${Math.round(r.salary_max / 1000)}k`;
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
    for (const e of r.errors.slice(0, 5)) lines.push(`  error: ${e.source ?? 'run'} ${e.code}: ${String(e.message ?? '').slice(0, 200)}`);
  }
  lines.push('');
  lines.push(`== Look at these (top ${data.lookAtThese.rows.length}) ==`);
  if (data.lookAtThese.excludedCount) lines.push(`(${data.lookAtThese.excludedCount} noise-classified row(s) excluded from this list; they are still in the database)`);
  if (data.lookAtThese.rows.length === 0) lines.push('(none)');
  for (const r of data.lookAtThese.rows) {
    const url = urlPassesRegistry(r.url_normalized ?? r.url, registry ?? { entries: [], httpAllowedHosts: new Set() }) ? (r.url_normalized ?? r.url) : null;
    const also = r.also_seen_via.length ? ` (also seen via ${r.also_seen_via.join(', ')})` : '';
    lines.push(`#${r.id} | ${r.title} | ${r.company} | ${r.location ?? 'n/a'} | ${salaryText(r)} | ps ${r.prescore ?? 0} | ${r.source}${also}${url ? ` | ${url}` : ''}`);
  }
  lines.push('');
  lines.push('== Houston / Texas ==');
  if (data.homeLocations.length === 0) lines.push('(none)');
  for (const r of data.homeLocations) {
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
    return `<li>#${r.id} ${linkOrText(r)} at ${esc(r.company)}, ${esc(r.location ?? 'n/a')}, ${esc(salaryText(r))}, ps ${r.prescore ?? 0}, ${esc(r.source)}${also}</li>`;
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
      parts.push(`<li>${banner}run #${r.run_id}, profile ${esc(r.profile)}, status ${esc(r.status)}, started ${esc(r.started_at)}, duration ${r.duration_seconds ?? '?'}s<br>fetched ${s.fetched ?? 0}, new ${s.new ?? 0}, updated ${s.updated ?? 0}, repost ${s.repost ?? 0}, ambiguous ${s.ambiguous ?? 0}, detail_skipped_budget ${s.detail_skipped_budget ?? 0}${errs}</li>`);
    }
    parts.push('</ul>');
  }
  parts.push(`<h3>Look at these (top ${data.lookAtThese.rows.length})</h3>`);
  if (data.lookAtThese.excludedCount) parts.push(`<p>(${data.lookAtThese.excludedCount} noise-classified row(s) excluded from this list; they are still in the database)</p>`);
  parts.push(data.lookAtThese.rows.length ? `<ul>${data.lookAtThese.rows.map((r) => rowLi(r, true)).join('')}</ul>` : '<p>(none)</p>');
  parts.push('<h3>Houston / Texas</h3>');
  parts.push(data.homeLocations.length ? `<ul>${data.homeLocations.map((r) => rowLi(r, false)).join('')}</ul>` : '<p>(none)</p>');
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
    lines.push(`- #${r.id} ${r.title} at ${r.company}, ${r.location ?? 'n/a'}, ${salaryText(r)}, ps ${r.prescore ?? 0}, ${r.source}${also}${url ? ` (${url})` : ''}`);
  }
  lines.push('');
  lines.push('## Houston / Texas');
  lines.push('');
  if (data.homeLocations.length === 0) lines.push('(none)');
  for (const r of data.homeLocations) {
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
