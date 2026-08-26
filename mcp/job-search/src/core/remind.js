// @ts-check
/**
 * Daily follow-up digest (spec section 6). Pure orchestration so tests can
 * inject the pg client, a fake fetch, and a fixed clock. bin/remind.js is
 * the CLI wrapper.
 *
 * Exit semantics (returned as `code`): 0 ok (including zero due rows, no
 * email), 1 auth or send failure (rows stay un-stamped so tomorrow retries).
 */
import { selectDue, unsnoozeDue, stampReminded, formatFollowup } from './followups.js';
import { googleHttp, gmailSend, buildRfc2822, buildRfc2822Multipart, readTokenFile, tokenInfo } from './google.js';
import { errFields, JobSearchError } from './errors.js';
import { loadConfig, DEFAULT_REPORT_HOME_MIN_PRESCORE } from './config.js';
import { normalizeLocation } from './normalize.js';
import { buildRegistry } from './urlguard.js';
import { buildScanReport, buildReportSubject, renderReportText, renderReportHtml, renderReportMarkdown, writeReportFile, stampReportSent, escapeHtml } from './report.js';

/**
 * One line per item, plain text.
 * @param {import('./followups.js').FollowupRow[]} rows
 * @param {Date} now
 */
export function buildDigest(rows, now) {
  const lines = rows.map((r) => {
    const due = new Date(r.due_at);
    const overdue = due.getTime() < now.getTime() - 86400000 ? ' (overdue)' : '';
    return `- ${formatFollowup(r)}${overdue}`;
  });
  const subject = `Follow-ups due: ${rows.length}`;
  const body = [`${rows.length} follow-up${rows.length === 1 ? '' : 's'} due by ${new Date(now.getTime() + 86400000).toISOString().slice(0, 10)}:`, '', ...lines, '', 'Mark done with followups({action:"complete", id}) in the job-search MCP.'].join('\n');
  return { subject, body };
}

/**
 * HTML rendering of the follow-ups digest, matching buildDigest's content (spec R1.2: the email is plain
 * text plus HTML).
 * @param {import('./followups.js').FollowupRow[]} rows
 * @param {Date} now
 */
export function buildDigestHtml(rows, now) {
  const items = rows.map((r) => {
    const due = new Date(r.due_at);
    const overdue = due.getTime() < now.getTime() - 86400000 ? ' (overdue)' : '';
    return `<li>${escapeHtml(formatFollowup(r))}${overdue}</li>`;
  });
  const parts = [
    `<h3>Follow-ups due: ${rows.length}</h3>`,
    `<p>${rows.length} follow-up${rows.length === 1 ? '' : 's'} due by ${escapeHtml(new Date(now.getTime() + 86400000).toISOString().slice(0, 10))}:</p>`,
    items.length ? `<ul>${items.join('')}</ul>` : '<p>(none)</p>',
    '<p>Mark done with followups({action:"complete", id}) in the job-search MCP.</p>',
  ];
  return parts.join('\n');
}

/**
 * Home locations (spec R1.2c "Houston / Texas") for a search profile, as location_norm values.
 * @param {import('pg').ClientBase} client
 * @param {string} profileName
 */
async function homeLocationNormsFor(client, profileName) {
  const r = await client.query('SELECT locations FROM ic_search_profiles WHERE name = $1', [profileName]);
  const locations = /** @type {string[]} */ (r.rows[0]?.locations ?? []);
  return [...new Set(locations.map((l) => normalizeLocation(l).location_norm).filter((n) => n && n !== 'absent'))];
}

/**
 * @param {{
 *   client: import('pg').ClientBase, tokenFile: string, to: string, from?: string, dryRun?: boolean,
 *   fetch?: typeof fetch, now?: Date, log?: (fields: Record<string, string|number|boolean|null>) => void,
 *   googleHttp?: typeof googleHttp, config?: import('./config.js').LoadedConfig, reportProfile?: string,
 *   reportSinceOverride?: Date|null, writeReportFileRoot?: string, skipReportFile?: boolean,
 * }} opts reportSinceOverride, when the key is present (including explicitly `null`), bypasses the
 *   ic_report_state marker read (test seam; see report.js's buildScanReport)
 * @returns {Promise<{ code: number, due: number, flipped: number, sent: boolean, stamped: number, subject: string|null, body: string|null, reason: string|null, scopes_ok: boolean|null, expiry: string|null, report_file: string|null, no_scan: boolean, worst_status: string|null }>}
 */
export async function runRemind(opts) {
  if (!opts.tokenFile) {
    throw new JobSearchError('VALIDATION', 'GOOGLE_TOKEN_FILE is not set; add it to mcp/job-search/.env');
  }
  if (!opts.to) {
    throw new JobSearchError('VALIDATION', 'REMINDER_TO is not set; add it to mcp/job-search/.env');
  }
  const now = opts.now ?? new Date();
  const say = opts.log ?? (() => {});
  const config = opts.config ?? (() => {
    try {
      return loadConfig();
    } catch {
      return null;
    }
  })();
  const timezone = config?.adapters.run.timezone ?? 'America/Chicago';
  const topN = config?.adapters.run.reportTopN ?? 10;
  const homeMinPrescore = config?.adapters.run.reportHomeMinPrescore ?? DEFAULT_REPORT_HOME_MIN_PRESCORE;
  const registry = config ? buildRegistry(config) : { entries: [], httpAllowedHosts: new Set() };
  const reportProfile = opts.reportProfile ?? 'exec-default';

  const flippedIds = await unsnoozeDue(opts.client, now);
  const rows = await selectDue(opts.client, now);
  const homeLocationNorms = await homeLocationNormsFor(opts.client, reportProfile);
  /** @type {{ sinceOverride?: Date|null }} */
  const sinceOpt = Object.prototype.hasOwnProperty.call(opts, 'reportSinceOverride') ? { sinceOverride: opts.reportSinceOverride } : {};
  const report = await buildScanReport(opts.client, { now, timezone, topN, homeMinPrescore, homeLocationNorms, ...sinceOpt });
  say({
    evt: 'remind_select', due: rows.length, flipped: flippedIds.length, dry_run: Boolean(opts.dryRun),
    scan_runs: report.runs.length, no_scan: report.noScan, worst_status: report.worstStatus,
  });

  // Spec R1.1: sent whenever EITHER follow-ups are due OR at least one scan run finished since the last
  // report OR (decision 26) it is a weekday and no run has been recorded at all.
  const shouldReport = rows.length > 0 || report.runs.length > 0 || report.noScan;
  if (!shouldReport && !opts.dryRun) {
    return { code: 0, due: 0, flipped: flippedIds.length, sent: false, stamped: 0, subject: null, body: null, reason: 'nothing_to_report', scopes_ok: null, expiry: null, report_file: null, no_scan: false, worst_status: null };
  }

  const followupsDigest = buildDigest(rows, now);
  const followupsHtml = buildDigestHtml(rows, now);
  const subject = buildReportSubject(report, { followupsDue: rows.length });
  const reportText = renderReportText(report, registry);
  const reportHtml = renderReportHtml(report, registry);
  const text = [reportText, '', followupsDigest.body].join('\n');
  const html = [reportHtml, followupsHtml].join('\n');
  const markdown = [renderReportMarkdown(report, registry), '', `## Follow-ups due: ${rows.length}`, '', ...rows.map((r) => `- ${formatFollowup(r)}`)].join('\n');

  /** @type {string|null} */
  let reportFile = null;
  if (!opts.skipReportFile) {
    try {
      reportFile = writeReportFile(markdown, report.dayKey, opts.writeReportFileRoot ? { root: opts.writeReportFileRoot } : {});
    } catch (err) {
      say({ evt: 'remind_report_file_failed', ...errFields(err) });
    }
  }

  if (opts.dryRun) {
    // A dry run always exercises the token file (load + in-memory refresh) even with nothing due, so the
    // scheduled job can be proven healthy without sending anything. The marker is never advanced here
    // (decision 23: only a confirmed send advances it).
    let scopesOk = null;
    let expiry = null;
    try {
      const g = await (opts.googleHttp ?? googleHttp)({ tokenFile: opts.tokenFile, fetch: opts.fetch, need: { gmail: true } });
      scopesOk = g.info.gmail_send_ok;
      expiry = g.expiry;
      say({ evt: 'remind_token_ok', scopes_ok: scopesOk, expiry, has_refresh_token: g.info.has_refresh_token });
    } catch (err) {
      const f = errFields(err);
      try {
        scopesOk = tokenInfo(readTokenFile(opts.tokenFile)).gmail_send_ok;
      } catch {
        scopesOk = null;
      }
      say({ evt: 'remind_token_failed', ...f, scopes_ok: scopesOk });
      return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: f.err_message, scopes_ok: scopesOk, expiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus };
    }
    return { code: 0, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: 'dry_run', scopes_ok: scopesOk, expiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus };
  }

  let deps;
  let info;
  let expiry = null;
  try {
    const g = await (opts.googleHttp ?? googleHttp)({ tokenFile: opts.tokenFile, fetch: opts.fetch, need: { gmail: true } });
    deps = g.deps;
    info = g.info;
    expiry = g.expiry;
    say({ evt: 'remind_token_ok', scopes_ok: info.gmail_send_ok, expiry, has_refresh_token: info.has_refresh_token });
  } catch (err) {
    const f = errFields(err);
    say({ evt: 'remind_token_failed', ...f });
    return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: f.err_message, scopes_ok: false, expiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus };
  }
  try {
    const msg = buildRfc2822Multipart({ to: opts.to, from: opts.from, subject, text, html, date: now });
    const id = await gmailSend(deps, msg);
    say({ evt: 'remind_sent', message_id: id, due: rows.length, scan_runs: report.runs.length });
  } catch (err) {
    const f = errFields(err);
    say({ evt: 'remind_send_failed', ...f });
    return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: f.err_message, scopes_ok: info.gmail_send_ok, expiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus };
  }
  const stamped = await stampReminded(opts.client, rows.map((r) => r.id), now);
  // Decision 23: the marker advances only after the confirmed send above, mirroring stampReminded.
  await stampReportSent(opts.client, now, report.lastRunIdIncluded);
  return { code: 0, due: rows.length, flipped: flippedIds.length, sent: true, stamped, subject, body: text, reason: null, scopes_ok: info.gmail_send_ok, expiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus };
}
