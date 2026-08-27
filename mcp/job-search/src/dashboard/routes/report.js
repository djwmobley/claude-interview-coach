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
import { sendJson } from '../http.js';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/report/preview', async (ctx) => {
    const q = ctx.query;
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
