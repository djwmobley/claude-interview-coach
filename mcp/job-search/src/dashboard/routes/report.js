// @ts-check
/**
 * Report routes (dashboard PR 2 API table, "Report"). Preview reuses buildScanReport/resolveReportWindow
 * exactly like the scan_report MCP tool and NEVER stamps ic_report_state (same rule); send goes through
 * runRemind on its own dedicated connection so a slow Gmail call never holds a pooled client.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildScanReport, buildReportSubject, renderReportText, renderReportHtml, resolveReportWindow, homeLocationNormsFor, getReportState } from '../../core/report.js';
import { buildRegistry } from '../../core/urlguard.js';
import { runRemind } from '../../core/remind.js';
import { connectDedicated } from '../../core/db.js';
import { DEFAULT_REPORT_HOME_MIN_PRESCORE } from '../../core/config.js';
import { sendJson, applySandboxHtmlHeaders } from '../http.js';

/**
 * Shared preview build, used by both the JSON preview route and the HTML-serving variant added for
 * pr3-spec-decisions.md section 9 item 3 / section 6 item 3 (the sandboxed-iframe front end needs an
 * endpoint that responds with the rendered HTML directly, carrying the sandbox CSP, rather than a JSON
 * string field with nowhere safe to render it). Never touches ic_report_state, same rule as the original.
 * @param {import('../server.js').DashboardDeps} deps
 * @param {Record<string,string>} q
 */
async function buildPreview(deps, q) {
  const config = deps.config;
  const timezone = config?.adapters.run.timezone ?? 'America/Chicago';
  const topN = config?.adapters.run.reportTopN ?? 10;
  const homeMinPrescore = config?.adapters.run.reportHomeMinPrescore ?? DEFAULT_REPORT_HOME_MIN_PRESCORE;
  const registry = config ? buildRegistry(config) : { entries: [], httpAllowedHosts: new Set() };
  const profile = q.profile || 'exec-default';
  const runId = q.run_id ? Number(q.run_id) : null;
  const date = q.date || null;

  const { now, sinceOverride } = await deps.withClient((c) => resolveReportWindow(c, { date, run_id: runId, timezone }));
  const homeLocationNorms = await deps.withClient((c) => homeLocationNormsFor(c, profile));
  const report = await deps.withClient((c) => buildScanReport(c, {
    now, timezone, topN, homeMinPrescore, homeLocationNorms,
    ...(sinceOverride !== undefined ? { sinceOverride } : {}),
  }));
  const subject = buildReportSubject(report, {});
  const text = renderReportText(report, registry);
  const html = renderReportHtml(report, registry);
  return { subject, report, text, html };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/report/preview', async (ctx) => {
    const { subject, report, text, html } = await buildPreview(deps, ctx.query);
    sendJson(ctx.res, 200, {
      ok: true,
      subject,
      day_key: report.dayKey,
      since: report.since,
      no_scan: report.noScan,
      worst_status: report.worstStatus,
      run_count: report.runs.length,
      look_at_these_count: report.lookAtThese.rows.length,
      review_queue_open: report.reviewQueue.total,
      text,
      html,
    });
  });

  // HTML-serving variant (pr3-spec-decisions.md section 9 item 3): same params, same pipeline, but
  // responds with the rendered HTML directly under the sandbox CSP so the front end's iframe can `src=`
  // it, exactly like GET /api/documents/file already does for a saved report file.
  router.register('GET', '/api/report/preview.html', async (ctx) => {
    const { html } = await buildPreview(deps, ctx.query);
    applySandboxHtmlHeaders(ctx.res);
    ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
    ctx.res.statusCode = 200;
    ctx.res.end(html);
  });

  router.register('POST', '/api/report/send', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    const dryRun = Boolean(b.dryRun);
    const to = typeof b.to === 'string' && b.to.trim() ? b.to.trim() : deps.env.REMINDER_TO;
    const client = await connectDedicated();
    try {
      const result = await runRemind({ client, tokenFile: deps.env.GOOGLE_TOKEN_FILE, to, dryRun, config: deps.config ?? undefined, fetch: deps.fetch });
      sendJson(ctx.res, 200, { ok: result.code === 0, ...result });
    } finally {
      await client.end();
    }
  }, { allowEmptyBody: true });

  router.register('GET', '/api/report/history', async (ctx) => {
    const dir = path.join(deps.outputRoot, 'reports');
    /** @type {string[]} */
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('-scan-report.md'));
    } catch {
      files = [];
    }
    const days = files.map((f) => f.replace(/-scan-report\.md$/, '')).sort().reverse();
    const state = await deps.withClient((c) => getReportState(c));
    sendJson(ctx.res, 200, {
      ok: true,
      days,
      last_report_sent_at: state.lastReportSentAt ? state.lastReportSentAt.toISOString() : null,
      last_run_id_included: state.lastRunIdIncluded,
    });
  });
}
