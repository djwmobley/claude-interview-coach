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
import { buildRegistry } from './urlguard.js';
import {
  buildScanReport, buildReportSubject, renderReportText, renderReportHtml, renderReportMarkdown, writeReportFile,
  stampReportSent, escapeHtml, homeLocationNormsFor, dashboardHealthLineText, collectAutoApply,
  renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown,
} from './report.js';
import { readWatchdogState, ackWatchdogRestarts } from './watchdog-state.js';
import { readAutoApplySummary } from './auto-apply-state.js';

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

// homeLocationNormsFor moved to report.js (dashboard PR 1, extracted for the dashboard's own report
// routes); imported above.

/**
 * @param {{
 *   client: import('pg').ClientBase, tokenFile: string, to: string, from?: string, dryRun?: boolean,
 *   fetch?: typeof fetch, now?: Date, log?: (fields: Record<string, string|number|boolean|null>) => void,
 *   logError?: (fields: Record<string, string|number|boolean|null>) => void, googleHttp?: typeof googleHttp,
 *   config?: import('./config.js').LoadedConfig, reportProfile?: string,
 *   reportSinceOverride?: Date|null, writeReportFileRoot?: string, skipReportFile?: boolean,
 *   watchdogStateFile?: string|null, autoApplySummaryFile?: string|null,
 * }} opts reportSinceOverride, when the key is present (including explicitly `null`), bypasses the
 *   ic_report_state marker read (test seam; see report.js's buildScanReport). logError defaults to `log`
 *   when omitted; bin/remind.js wires it to logger.error so the auth-health broken-grant line (see
 *   below) is distinguishable from the ordinary info-level events. watchdogStateFile (self-healing
 *   watchdog feature): absolute path to bin/watchdog.js's JSON state file; bin/remind.js wires it to
 *   defaultWatchdogStateFile(env.JOBSEARCH_LOG_DIR). Omitted or unreadable means "no watchdog state to
 *   report" (readWatchdogState already returns null for a missing/corrupt file), never a fabricated
 *   healthy status. autoApplySummaryFile (auto-apply PR B, GAP 2): absolute path to bin/auto-apply.js's
 *   stable JSON summary file; bin/remind.js wires it to defaultAutoApplySummaryFile(env.JOBSEARCH_LOG_DIR).
 *   Omitted or unreadable means "no auto-apply run to report", rendered as a distinct empty state, never
 *   omitted (report.js's collectAutoApply/renderAutoApply*).
 * @returns {Promise<{ code: number, due: number, flipped: number, sent: boolean, stamped: number, subject: string|null, body: string|null, reason: string|null, scopes_ok: boolean|null, expiry: string|null, report_file: string|null, no_scan: boolean, worst_status: string|null, google_auth_state: string|null }>}
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
  const sayError = opts.logError ?? say;
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

  // Self-healing watchdog feature: read bin/watchdog.js's state file (I/O lives here, not in report.js,
  // which stays pure) and pre-compute whether it has anything worth a banner line. dashboardHealthLine
  // being non-null is itself a reason to send today's email even with nothing else due (down/stuck/error
  // is a real operator-facing problem, and a nonzero restart count is exactly what this feature exists to
  // surface) -- see the shouldReport check just below.
  const dashboardHealthState = opts.watchdogStateFile ? readWatchdogState(opts.watchdogStateFile) : null;
  const dashboardHealthLine = dashboardHealthLineText(dashboardHealthState);
  if (dashboardHealthLine) say({ evt: 'remind_dashboard_health', line: dashboardHealthLine, status: dashboardHealthState?.status ?? null });

  // Spec R1.1: sent whenever EITHER follow-ups are due OR at least one scan run finished since the last
  // report OR (decision 26) it is a weekday and no run has been recorded at all OR (self-healing watchdog
  // feature) the dashboard watchdog has something to report (down, stuck, error, or unacknowledged
  // restarts) -- "healthy, no restarts" already renders as a null line above, so this never fires a send
  // on a quiet watchdog day.
  const shouldReport = rows.length > 0 || report.runs.length > 0 || report.noScan || Boolean(dashboardHealthLine);
  if (!shouldReport && !opts.dryRun) {
    // The token layer is not even consulted here (unchanged from before the auth-health hardening): the
    // single Google auth attempt below only runs once shouldReport (or dryRun) is confirmed.
    return { code: 0, due: 0, flipped: flippedIds.length, sent: false, stamped: 0, subject: null, body: null, reason: 'nothing_to_report', scopes_ok: null, expiry: null, report_file: null, no_scan: false, worst_status: null, google_auth_state: null };
  }

  // Single live Google auth attempt per invocation (auth-health hardening, spec Change 3): its outcome
  // feeds the report's "Google auth" line rendered below AND the dry-run/real-send branches further
  // down -- never a second live refresh in this call. googleHttp()'s own success return and thrown
  // errors both carry a `tokenState` classification built from this SAME attempt (see google.js); a
  // test-injected `opts.googleHttp` double that does not set `.tokenState` falls back to a generic
  // classification rather than throwing.
  /** @type {import('./google.js').HttpDeps|null} */
  let googleDeps = null;
  /** @type {boolean|null} */
  let googleScopesOk = null;
  /** @type {string|null} */
  let googleExpiry = null;
  /** @type {import('./google.js').GoogleTokenState} */
  let googleAuthState;
  /** @type {{ err_code: string, err_message: string }|null} */
  let googleAuthError = null;
  try {
    const g = await (opts.googleHttp ?? googleHttp)({ tokenFile: opts.tokenFile, fetch: opts.fetch, need: { gmail: true } });
    googleDeps = g.deps;
    googleScopesOk = g.info.gmail_send_ok;
    googleExpiry = g.expiry;
    googleAuthState = /** @type {any} */ (g).tokenState ?? { state: 'ok', expiry: g.expiry };
    say({ evt: 'remind_token_ok', scopes_ok: googleScopesOk, expiry: googleExpiry, has_refresh_token: g.info.has_refresh_token });
  } catch (err) {
    googleAuthError = errFields(err);
    googleAuthState = /** @type {any} */ (err)?.tokenState ?? { state: 'broken_refresh_error', code: 'unknown' };
    try {
      googleScopesOk = tokenInfo(readTokenFile(opts.tokenFile)).gmail_send_ok;
    } catch {
      googleScopesOk = null;
    }
    say({ evt: 'remind_token_failed', ...googleAuthError, scopes_ok: googleScopesOk, state: googleAuthState.state });
  }

  // Auto-apply PR B, GAP 2: read bin/auto-apply.js's stable summary file (I/O lives here, not in
  // report.js, which stays pure -- mirrors the watchdog state file read above) and shape it via
  // collectAutoApply. A missing/unreadable file (the feature has never run, or ran before this file
  // existed) is NOT itself a reason to send today's email (unlike dashboardHealthLine above): an absent
  // auto-apply run is the normal, expected state on most days, not an operator-facing problem -- but the
  // section is still ALWAYS rendered into the body below (never silently omitted), per report.js's own
  // collectAutoApply/renderAutoApply* contract.
  const autoApplySummary = opts.autoApplySummaryFile ? readAutoApplySummary(opts.autoApplySummaryFile) : null;
  const autoApplyData = await collectAutoApply(opts.client, autoApplySummary);

  const followupsDigest = buildDigest(rows, now);
  const followupsHtml = buildDigestHtml(rows, now);
  const subject = buildReportSubject(report, { followupsDue: rows.length });
  const reportText = renderReportText(report, registry, googleAuthState, dashboardHealthState);
  const reportHtml = renderReportHtml(report, registry, googleAuthState, dashboardHealthState);
  const autoApplyText = renderAutoApplyText(autoApplyData, registry);
  const autoApplyHtml = renderAutoApplyHtml(autoApplyData, registry);
  const autoApplyMarkdown = renderAutoApplyMarkdown(autoApplyData, registry);
  const text = [reportText, '', autoApplyText, '', followupsDigest.body].join('\n');
  const html = [reportHtml, autoApplyHtml, followupsHtml].join('\n');
  const markdown = [renderReportMarkdown(report, registry, googleAuthState, dashboardHealthState), '', autoApplyMarkdown, '', `## Follow-ups due: ${rows.length}`, '', ...rows.map((r) => `- ${formatFollowup(r)}`)].join('\n');

  /** @type {string|null} */
  let reportFile = null;
  if (!opts.skipReportFile) {
    try {
      reportFile = writeReportFile(markdown, report.dayKey, { ...(opts.writeReportFileRoot ? { root: opts.writeReportFileRoot } : {}), html: reportHtml });
    } catch (err) {
      say({ evt: 'remind_report_file_failed', ...errFields(err) });
    }
  }

  if (opts.dryRun) {
    // A dry run always exercises the token file (load + in-memory refresh) even with nothing due, so the
    // scheduled job can be proven healthy without sending anything. The marker is never advanced here
    // (decision 23: only a confirmed send advances it).
    if (googleAuthError) {
      return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: googleAuthError.err_message, scopes_ok: googleScopesOk, expiry: googleExpiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus, google_auth_state: googleAuthState.state };
    }
    return { code: 0, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: 'dry_run', scopes_ok: googleScopesOk, expiry: googleExpiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus, google_auth_state: googleAuthState.state };
  }

  if (googleAuthError || !googleDeps) {
    // Auth-health hardening (spec Change 3): a broken classification here still attempted the send (this
    // WAS the live attempt) and gets a dedicated ERROR-level line, distinct from the info-level
    // remind_token_failed event above -- never a token value, only the classification.
    if (googleAuthState.state !== 'ok') {
      sayError({
        evt: 'google_auth_broken', state: googleAuthState.state,
        code: googleAuthState.state === 'broken_refresh_error' ? googleAuthState.code : null,
        missing_scopes: googleAuthState.state === 'broken_missing_scopes' ? googleAuthState.missing.join(',') : null,
      });
    }
    return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: googleAuthError ? googleAuthError.err_message : 'google auth unavailable', scopes_ok: false, expiry: googleExpiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus, google_auth_state: googleAuthState.state };
  }
  try {
    const msg = buildRfc2822Multipart({ to: opts.to, from: opts.from, subject, text, html, date: now });
    const id = await gmailSend(googleDeps, msg);
    say({ evt: 'remind_sent', message_id: id, due: rows.length, scan_runs: report.runs.length });
  } catch (err) {
    const f = errFields(err);
    say({ evt: 'remind_send_failed', ...f });
    return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, body: text, reason: f.err_message, scopes_ok: googleScopesOk, expiry: googleExpiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus, google_auth_state: googleAuthState.state };
  }
  const stamped = await stampReminded(opts.client, rows.map((r) => r.id), now);
  // Decision 23: the marker advances only after the confirmed send above, mirroring stampReminded.
  await stampReportSent(opts.client, now, report.lastRunIdIncluded);
  // Self-healing watchdog feature: the restarts_since_ack count just rendered above in the confirmed send
  // is acknowledged here, the same "only after a confirmed send" rule stampReportSent follows -- a send
  // failure above already returned before this line, leaving the count intact for tomorrow's attempt.
  if (opts.watchdogStateFile && dashboardHealthState && dashboardHealthState.restarts_since_ack > 0) {
    ackWatchdogRestarts(opts.watchdogStateFile, now);
  }
  return { code: 0, due: rows.length, flipped: flippedIds.length, sent: true, stamped, subject, body: text, reason: null, scopes_ok: googleScopesOk, expiry: googleExpiry, report_file: reportFile, no_scan: report.noScan, worst_status: report.worstStatus, google_auth_state: googleAuthState.state };
}
