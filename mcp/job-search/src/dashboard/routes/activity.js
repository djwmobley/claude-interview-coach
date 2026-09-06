// @ts-check
/**
 * GET /api/activity (activity pill spec item 1): what the OPERATOR is doing right now, as opposed to
 * background automation nobody asked the dashboard to watch. Before this route, the topbar pill read
 * GET /api/scans/live, which only ever reflects a scan -- so it showed "Idle" 99% of the time even while
 * the operator had just clicked Apply, because the resume/review/apply chain that click drives isn't a
 * scan at all. This route is a TOTAL classification: every currently-running action this process (or an
 * unattended CLI job with a still-fresh running marker) knows about maps to exactly one of:
 *   - `operator`: the single MOST RECENTLY STARTED operator-driven action (or null if none), with
 *     `operator_extra` counting how many OTHER operator-driven actions are also running right now.
 *   - an entry in `background`: everything else running that the operator did not just click.
 * Nothing running is ever silently dropped from both.
 *
 * Operator candidates are exactly the runners THIS dashboard process itself drives via a button click:
 * resume-runner.js, review-runner.js and apply-runner.js (POST /api/listings/:id/apply-now's chain, and
 * the Approve/Retry-triggered apply-runner) each already expose a `status()` returning
 * `{running, applicationId, startedAt}` (apply-runner.js's also carries `pid`, unused here) -- none of the
 * three needed a `status()` added, they already had one. `listing_id` for each is resolved with a single
 * batched query over every running application id (there are at most 3 candidates, and normally 0 or 1
 * are running at once).
 *
 * The scan case is the one candidate that is NOT a runner status alone: scan-runner.js's own status()
 * only ever reflects a scan THIS process spawned (bin/scan.js is always invoked with `--trigger dashboard`
 * from there -- see scan-runner.js's own doc comment), so "the scanRunner this process is tracking right
 * now" is exactly "a scan the operator started from this dashboard's Run scan button". Every OTHER running
 * `ic_scan_runs` row -- the 06:30 scheduled task (`trigger` 'cli', the CLI default when no --trigger flag
 * is passed), an MCP-tool-started scan (`trigger` 'mcp'), or even a `trigger` 'dashboard' row this process
 * lost track of after a restart -- is classified as background instead. This is deliberately NOT the same
 * thing as "trigger 'dashboard' means operator, anything else means background": classifying by whether
 * THIS process's scanRunner is actively tracking the row is what keeps the classification total, because
 * an orphaned 'dashboard'-trigger row (this process restarted mid-scan) would otherwise fall through both
 * buckets if trigger alone were the rule.
 *
 * Background sources beyond "every other running scan row": a live (non-stale) running marker for
 * auto-apply and confirm (src/core/running-marker.js) -- both are unattended CLI jobs with no dashboard
 * runner and, for confirm, no other interim status file at all.
 */
import { runningMarkerPath, readLiveMarker } from '../../core/running-marker.js';
import { timeInTz } from '../../core/report.js';
import { sendJson } from '../http.js';

const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * @param {import('../server.js').DashboardDeps} deps
 * @param {number[]} applicationIds
 * @returns {Promise<Map<number, number>>} applicationId -> listingId
 */
async function listingIdsForApplications(deps, applicationIds) {
  const ids = [...new Set(applicationIds)].filter((id) => Number.isInteger(id) && id > 0);
  /** @type {Map<number, number>} */
  const map = new Map();
  if (!ids.length) return map;
  const r = await deps.withClient((c) => c.query('SELECT id, listing_id FROM ic_job_applications WHERE id = ANY($1::int[])', [ids]));
  for (const row of r.rows) map.set(Number(row.id), Number(row.listing_id));
  return map;
}

/**
 * Total classification over `ic_scan_runs.trigger`'s CHECK-constrained values ('mcp', 'cli', 'dashboard')
 * plus a defensive default branch for any future value: every trigger maps to SOME background label,
 * never an allow-list that could silently drop a new trigger value into no label at all.
 * @param {string|null} trigger
 * @param {Date} startedAt
 * @param {string} timezone
 */
function backgroundScanLabel(trigger, startedAt, timezone) {
  if (trigger === 'cli') return `Scheduled scan running since ${timeInTz(startedAt, timezone)}`;
  if (trigger === 'mcp') return 'Scan running (started from the MCP tool)';
  // 'dashboard' here means an ORPHANED row (this process's scanRunner is not tracking it -- see this
  // file's own module doc comment), and `null`/anything else is the closed-list default branch.
  return 'Scan running (background)';
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/activity', async (ctx) => {
    const now = new Date();
    const timezone = deps.config?.adapters?.run?.timezone ?? DEFAULT_TIMEZONE;

    const resumeStatus = deps.resumeRunner?.status();
    const reviewStatus = deps.reviewRunner?.status();
    const applyStatus = deps.applyRunner?.status();
    const scanStatus = deps.scanRunner.status();

    const runningAppIds = /** @type {number[]} */ ([resumeStatus, reviewStatus, applyStatus]
      .filter((s) => s && s.running && Number.isInteger(s.applicationId))
      .map((s) => Number(s.applicationId)));
    const listingByApp = await listingIdsForApplications(deps, runningAppIds);

    /** @type {Array<{ kind: string, label: string, application_id: number|null, listing_id: number|null, phase: string, started_at: string }>} */
    const operatorCandidates = [];

    if (resumeStatus?.running && resumeStatus.applicationId != null) {
      const listingId = listingByApp.get(Number(resumeStatus.applicationId)) ?? null;
      operatorCandidates.push({
        kind: 'resume', phase: 'drafting_resume',
        label: listingId != null ? `Drafting resume for #${listingId}` : 'Drafting resume',
        application_id: Number(resumeStatus.applicationId), listing_id: listingId,
        started_at: /** @type {string} */ (resumeStatus.startedAt),
      });
    }
    if (reviewStatus?.running && reviewStatus.applicationId != null) {
      const listingId = listingByApp.get(Number(reviewStatus.applicationId)) ?? null;
      operatorCandidates.push({
        kind: 'review', phase: 'reviewing',
        label: listingId != null ? `Reviewing #${listingId}` : 'Reviewing draft',
        application_id: Number(reviewStatus.applicationId), listing_id: listingId,
        started_at: /** @type {string} */ (reviewStatus.startedAt),
      });
    }
    if (applyStatus?.running && applyStatus.applicationId != null) {
      const listingId = listingByApp.get(Number(applyStatus.applicationId)) ?? null;
      operatorCandidates.push({
        kind: 'apply', phase: 'submitting',
        label: listingId != null ? `Submitting #${listingId}` : 'Submitting application',
        application_id: Number(applyStatus.applicationId), listing_id: listingId,
        started_at: /** @type {string} */ (applyStatus.startedAt),
      });
    }
    if (scanStatus.running && scanStatus.runId != null) {
      operatorCandidates.push({
        kind: 'scan', phase: 'scanning', label: 'Scanning (manual)',
        application_id: null, listing_id: null, started_at: /** @type {string} */ (scanStatus.startedAt),
      });
    }

    operatorCandidates.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    const operator = operatorCandidates[0] ?? null;
    const operatorExtra = Math.max(0, operatorCandidates.length - 1);

    /** @type {Array<{ kind: string, label: string, run_id: number|string|null, started_at: string }>} */
    const background = [];

    const runningScans = await deps.withClient((c) => c.query(
      `SELECT id, trigger, started_at FROM ic_scan_runs WHERE status = 'running' ORDER BY started_at DESC`,
    ));
    for (const row of runningScans.rows) {
      const runId = Number(row.id);
      // Already the operator entry above (this process's own tracked scan) -- never duplicated here.
      if (scanStatus.running && scanStatus.runId === runId) continue;
      const startedAt = new Date(row.started_at);
      background.push({ kind: 'scan', label: backgroundScanLabel(row.trigger, startedAt, timezone), run_id: runId, started_at: startedAt.toISOString() });
    }

    const autoApplyMarker = readLiveMarker(runningMarkerPath(deps.env.JOBSEARCH_LOG_DIR, 'auto-apply'), now);
    if (autoApplyMarker) {
      background.push({ kind: 'auto-apply', label: 'Auto-apply running', run_id: autoApplyMarker.run_id, started_at: autoApplyMarker.started_at });
    }
    const confirmMarker = readLiveMarker(runningMarkerPath(deps.env.JOBSEARCH_LOG_DIR, 'confirm'), now);
    if (confirmMarker) {
      background.push({ kind: 'confirm', label: 'Checking mail for application confirmations', run_id: confirmMarker.run_id, started_at: confirmMarker.started_at });
    }

    sendJson(ctx.res, 200, { ok: true, operator, operator_extra: operatorExtra, background });
  });
}
