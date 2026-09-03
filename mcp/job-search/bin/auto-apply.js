#!/usr/bin/env node
// @ts-check
/**
 * Auto-apply CLI (auto-apply PR B, docs/auto-apply-spec.md), scheduled 06:55 daily as Windows Scheduled
 * Task "job-search auto-apply" via scripts/register-auto-apply-task.ps1.
 *
 *   node bin/auto-apply.js [--dry-run] [--json [out]]
 *
 * Three phases, in order:
 *   prepare -- re-probes listings whose apply target is still unresolved (or has cooled down for
 *     re-probe), via src/core/apply-target-persist.js, up to config/auto-apply.json's probeRowCap extra
 *     rows this run. Attempts (best-effort, never fatal on failure) to reuse the scan Chrome session
 *     (src/browser/session.js's connectSession + target marker) for parity with scan-run.js's own
 *     getSession()/reconcileTargets() pattern; this CLI's own resolution is URL-only (redirect-chasing via
 *     fetch through src/apply/probe-registry.js), never a live browser click -- see docs/auto-apply-spec.md
 *     for that documented blind spot.
 *   select -- src/core/auto-apply-select.js's selectCandidates(): fit floor, US-only, salary floor, no
 *     active application, description present, apply target resolved to an exact, allow-listed ATS, dedup
 *     on the resolved (ats, url) pair, then the daily cap.
 *   apply -- for each selected candidate, in order: createApplication (preferring the resolved
 *     listing.apply_url) -> resume runner -> review runner (VERDICT PASS required) -> approve() ->
 *     runApplyWorker(). A non-PASS review, or any other failure, leaves the application wherever the chain
 *     stopped and moves on to the next candidate -- CLAUDE.md's "unattended soft failures warn and
 *     proceed" -- never aborts the whole run. approve() is called with actor:'auto' specifically so
 *     src/core/auto-apply-select.js's countAutoApprovedToday() (the daily-cap accounting) counts exactly
 *     the applications THIS pipeline actually advanced, and a review FAIL (which never reaches approve())
 *     never consumes a cap slot.
 *
 * Lock: one pg_try_advisory_lock on src/core/scan-run.js's own LOCK_KEY (730193001), polled every
 * config/auto-apply.json's pollSeconds up to lockMinutes total, held ONLY for the duration of the prepare
 * phase (the one phase that shares the scan Chrome with an actual scan) -- released before select/apply
 * begin, since the final submission step (runApplyWorker, imported and called directly here, never a
 * spawned copy of bin/apply.js) already acquires/releases this SAME lock itself, per-application, exactly
 * as it does when the dashboard's apply-runner spawns it. Holding the outer lock across the whole run would
 * make every runApplyWorker() call inside the apply loop report LOCKED against its own caller's connection.
 * Exit 2 (LOCKED) when the poll window expires without ever acquiring the lock.
 *
 * --dry-run: the prepare phase makes zero database writes (src/core/apply-target-persist.js's own
 * dryRun-first check) and the apply phase is skipped entirely (no createApplication, no resume/review/
 * approve/worker calls) -- select still runs (read-only) so the dry-run summary shows what WOULD have
 * been selected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getEnv, loadConfig, repoRoot } from '../src/core/config.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { errFields } from '../src/core/errors.js';
import { connectDedicated, withClient, closePool } from '../src/core/db.js';
import { LOCK_KEY } from '../src/core/scan-run.js';
import { buildProbeRegistryFromAtsApply } from '../src/apply/probe-registry.js';
import { INTERMEDIARY_HOSTS } from '../src/apply/apply-target.js';
import { persistApplyTargetForListing, LIFETIME_PROBE_ATTEMPTS } from '../src/core/apply-target-persist.js';
import { selectCandidates } from '../src/core/auto-apply-select.js';
import { createApplication, approve } from '../src/core/applications.js';
import { createResumeRunner } from '../src/dashboard/resume-runner.js';
import { createReviewRunner } from '../src/dashboard/review-runner.js';
import { runApplyWorker } from '../src/apply/worker.js';
import { connectSession as defaultConnectSession, applyTargetMarkerPath } from '../src/browser/session.js';

const USAGE = 'usage: node bin/auto-apply.js [--dry-run] [--json [out]]';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ dryRun: boolean, json: string|null|undefined, help: boolean }} */
  const out = { dryRun: false, json: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        out.json = v;
        i++;
      } else out.json = null;
    } else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * Poll for the shared advisory lock, mirroring src/core/scan-run.js's own contention semantics but
 * RETRYING instead of failing on the first try -- a scan run can legitimately hold this lock for a while,
 * and auto-apply is a once-a-day unattended job that can afford to wait.
 * @param {import('pg').ClientBase} client
 * @param {{ lockMinutes: number, pollSeconds: number, log: (f: any) => void, sleep?: (ms: number) => Promise<void> }} opts
 * @returns {Promise<boolean>}
 */
export async function acquireLockWithPoll(client, opts) {
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + opts.lockMinutes * 60000;
  for (;;) {
    const r = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    if (r.rows[0].ok) return true;
    if (Date.now() >= deadline) return false;
    opts.log({ evt: 'auto_apply_lock_wait', remaining_ms: deadline - Date.now() });
    await sleep(opts.pollSeconds * 1000);
  }
}

/**
 * The prepare phase: re-probe up to `probeRowCap` listings whose apply target is unresolved or due for
 * re-probe. Pure DB + fetch work (src/core/apply-target-persist.js); the scan-Chrome-session reuse is
 * best-effort housekeeping only (see module doc comment) and never affects this function's own outcome.
 * @param {import('pg').ClientBase} client
 * @param {import('../src/core/config.js').LoadedConfig} config
 * @param {{ now: Date, dryRun: boolean, log: (f: any) => void, fetch?: typeof fetch, lookup?: import('../src/core/urlguard.js').Lookup }} opts
 * @returns {Promise<{ attempted: number, resolved: number, unresolved: number, skipped: number }>}
 */
export async function runPrepare(client, config, opts) {
  const probeRegistry = buildProbeRegistryFromAtsApply(config.atsApply, INTERMEDIARY_HOSTS);
  const stats = { attempted: 0, resolved: 0, unresolved: 0, skipped: 0 };
  const cur = await client.query(
    `SELECT id, url, url_normalized, apply_probed_at, probe_attempts
     FROM ic_job_listings
     WHERE coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL AND expired_at IS NULL
       AND (status IS NULL OR status IN ('new', 'maybe', 'shortlisted'))
       AND description IS NOT NULL
       AND probe_attempts < $1
       AND apply_ats_confidence IS DISTINCT FROM 'exact'
       AND (apply_probed_at IS NULL OR apply_probed_at < now() - ($2 || ' hours')::interval)
     ORDER BY apply_probed_at ASC NULLS FIRST, id ASC
     LIMIT $3`,
    [LIFETIME_PROBE_ATTEMPTS, config.autoApply.reprobeAfterHours, config.autoApply.probeRowCap],
  );
  for (const row of cur.rows) {
    const listing = { id: Number(row.id), url: row.url, url_normalized: row.url_normalized, apply_probed_at: row.apply_probed_at, probe_attempts: Number(row.probe_attempts ?? 0) };
    stats.attempted++;
    try {
      const result = await persistApplyTargetForListing(client, listing, null, {
        probeRegistry, reprobeAfterHours: config.autoApply.reprobeAfterHours, now: opts.now, dryRun: opts.dryRun, fetch: opts.fetch, lookup: opts.lookup,
      });
      if (result.outcome === 'resolved') stats.resolved++;
      else if (result.outcome === 'unresolved') stats.unresolved++;
      else stats.skipped++;
    } catch (err) {
      stats.skipped++;
      opts.log({ evt: 'auto_apply_prepare_probe_failed', listing_id: listing.id, ...errFields(err) });
    }
  }
  return stats;
}

/**
 * Best-effort scan-Chrome session reuse for the prepare phase (see module doc comment: this CLI's own
 * resolution never actually drives the browser, so a failure here is logged and swallowed, never fatal).
 * @param {typeof defaultConnectSession} connectSession
 * @param {import('../src/core/config.js').Env} env
 * @param {(f: any) => void} log
 */
export async function touchScanSession(connectSession, env, log) {
  try {
    const session = await connectSession({ cdpUrl: env.SCAN_CDP_URL });
    try {
      await session.reconcileTargets(applyTargetMarkerPath(env.JOBSEARCH_LOG_DIR));
      await session.reconcile();
    } finally {
      await session.closeAll().catch(() => {});
    }
  } catch (err) {
    log({ evt: 'auto_apply_prepare_session_unavailable', ...errFields(err) });
  }
}

/**
 * The apply phase for ONE selected candidate: createApplication -> resume -> review (PASS required) ->
 * approve (actor:'auto') -> runApplyWorker. Never throws -- every phase's own failure is caught and
 * reported as a closed outcome so the caller's loop always proceeds to the next candidate.
 * @param {import('../src/core/auto-apply-select.js').CandidateRow} row
 * @param {{
 *   withClientFn: typeof withClient,
 *   resumeRunner: ReturnType<typeof createResumeRunner>,
 *   reviewRunner: ReturnType<typeof createReviewRunner>,
 *   runWorker: typeof runApplyWorker,
 *   outputRoot: string,
 *   env: import('../src/core/config.js').Env,
 *   log: (f: any) => void,
 * }} deps
 */
export async function applyOneCandidate(row, deps) {
  /** @type {any} */
  let app;
  try {
    app = await deps.withClientFn((c) => createApplication(c, {
      listingId: row.listingId, atsType: row.applyAts ?? 'unknown', applyUrl: row.applyUrl, actor: 'auto',
    }));
  } catch (err) {
    deps.log({ evt: 'auto_apply_create_application_failed', listing_id: row.listingId, ...errFields(err) });
    return { outcome: 'create_failed', listingId: row.listingId };
  }

  /** @type {any} */
  let resumeResult;
  try {
    resumeResult = await deps.resumeRunner.run(app.id, row.listingId);
  } catch (err) {
    deps.log({ evt: 'auto_apply_resume_runner_threw', application_id: app.id, ...errFields(err) });
    return { outcome: 'resume_failed', listingId: row.listingId, applicationId: app.id, reason: errFields(err).err_code };
  }
  if (!resumeResult.ok || !resumeResult.markdownPath) {
    return { outcome: 'resume_failed', listingId: row.listingId, applicationId: app.id, reason: resumeResult.reason ?? null };
  }

  /** @type {any} */
  let reviewResult;
  try {
    reviewResult = await deps.reviewRunner.run(app.id, resumeResult.markdownPath, row.listingId);
  } catch (err) {
    deps.log({ evt: 'auto_apply_review_runner_threw', application_id: app.id, ...errFields(err) });
    return { outcome: 'review_failed', listingId: row.listingId, applicationId: app.id, reason: errFields(err).err_code };
  }
  if (!reviewResult.ok || reviewResult.verdict !== 'PASS') {
    // A review FAIL parks the application at docs_ready with review_verdict/review_findings recorded
    // (review-runner.js's own storeReview) -- Approve stays available for a human. This never calls
    // approve(), so it never consumes a daily-cap slot (spec: "a review FAIL never consumes a slot").
    return { outcome: 'review_failed', listingId: row.listingId, applicationId: app.id, reason: reviewResult.reason ?? 'review_failed' };
  }

  try {
    await deps.withClientFn((c) => approve(c, app.id, { outputRoot: deps.outputRoot, actor: 'auto' }));
  } catch (err) {
    deps.log({ evt: 'auto_apply_approve_failed', application_id: app.id, ...errFields(err) });
    return { outcome: 'approve_failed', listingId: row.listingId, applicationId: app.id, reason: errFields(err).err_code };
  }

  try {
    const workerResult = await deps.runWorker(app.id, { env: deps.env, log: deps.log });
    return { outcome: workerResult.ok ? 'applied' : 'apply_failed', listingId: row.listingId, applicationId: app.id, workerStatus: workerResult.status };
  } catch (err) {
    deps.log({ evt: 'auto_apply_worker_threw', application_id: app.id, ...errFields(err) });
    return { outcome: 'apply_failed', listingId: row.listingId, applicationId: app.id, reason: errFields(err).err_code };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const env = getEnv();
  const config = loadConfig();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'auto-apply', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'auto-apply'), name: 'auto-apply' });
  /** @param {Record<string, string|number|boolean|null>} f */
  const log = (f) => logger.info(f);
  const now = new Date();
  const dryRun = args.dryRun;

  const lockClient = await connectDedicated();
  let locked = false;
  /** @type {any} */
  let prepareStats = null;
  try {
    locked = await acquireLockWithPoll(lockClient, { lockMinutes: config.autoApply.lockMinutes, pollSeconds: config.autoApply.pollSeconds, log });
    if (!locked) {
      log({ evt: 'auto_apply_locked' });
      console.log(JSON.stringify({ ok: false, status: 'locked' }));
      await lockClient.end().catch(() => {});
      process.exit(2);
      return;
    }
    await touchScanSession(defaultConnectSession, env, log);
    prepareStats = await runPrepare(lockClient, config, { now, dryRun, log });
    log({ evt: 'auto_apply_prepare_done', ...prepareStats });
  } finally {
    if (locked) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
      } catch {
        /* connection gone: the lock dies with it */
      }
    }
    try {
      await lockClient.end();
    } catch {
      /* ignore */
    }
  }

  const selectClient = await connectDedicated();
  /** @type {any} */
  let selection;
  try {
    selection = await selectCandidates(selectClient, {
      fitFloor: config.autoApply.fitFloor, floors: config.autoApply.floors, atsAllow: config.autoApply.atsAllow,
      dailyCap: config.autoApply.dailyCap, now, timezone: config.adapters.run.timezone,
    });
  } finally {
    await selectClient.end().catch(() => {});
  }
  log({ evt: 'auto_apply_select_done', cap_used: selection.capUsed, cap_remaining: selection.capRemaining, eligible: selection.eligible.length });

  const outputRoot = path.join(repoRoot(), 'output');
  /** @type {any[]} */
  const applyResults = [];
  if (!dryRun && selection.eligible.length) {
    const runnerDeps = { env, logDir: env.JOBSEARCH_LOG_DIR, repoRoot: repoRoot(), withClient, spawn };
    const resumeRunner = createResumeRunner(runnerDeps);
    const reviewRunner = createReviewRunner(runnerDeps);
    for (const row of selection.eligible) {
      const r = await applyOneCandidate(row, {
        withClientFn: withClient, resumeRunner, reviewRunner, runWorker: runApplyWorker, outputRoot, env, log,
      });
      applyResults.push(r);
      log({ evt: 'auto_apply_candidate_done', ...r });
    }
  }

  const summary = {
    ok: true,
    dry_run: dryRun,
    prepare: prepareStats,
    select: { results: selection.results, cap_used: selection.capUsed, cap_remaining: selection.capRemaining },
    applied: applyResults,
  };

  if (args.json !== undefined) {
    const file = args.json ?? path.join(env.JOBSEARCH_LOG_DIR, `auto-apply-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
    log({ evt: 'auto_apply_json_written', file: path.basename(file) });
  }

  console.log(JSON.stringify(summary));
  await closePool().catch(() => {});
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
