#!/usr/bin/env node
// @ts-check
/**
 * Auto-apply CLI (auto-apply PR B, docs/auto-apply-spec.md), scheduled 06:55 daily as Windows Scheduled
 * Task "job-search auto-apply" via scripts/register-auto-apply-task.ps1.
 *
 *   node bin/auto-apply.js [--dry-run] [--json [out]]
 *
 * Four phases, in order:
 *   wait -- (fix for the 2026-09-04 race: the scan task's Task Scheduler random delay can push a scan
 *     start well past auto-apply's own fixed 06:55, so auto-apply used to run against stale/unresolved
 *     data and select would report hundreds of rows as below_fit when the real blocker was simply that
 *     top-fit rows had no resolved apply target yet) -- src/core/scan-wait.js's waitForScan() polls
 *     ic_scan_runs against TWO America/Chicago local deadlines (config/auto-apply.json's waitDeadlineLocal,
 *     default 07:40, and waitHardDeadlineLocal, default 07:55). A scan that finished today lets this run
 *     proceed immediately. A scan that never started, already failed, or is unclassifiable is waited on
 *     only until the SOFT deadline, then this run self-heals the scan Chrome (bin/scan.js's own
 *     launchChrome) and proceeds anyway. A scan that IS actively running (or stalled -- heartbeat gone
 *     stale) is waited on until the HARD deadline; if it is still running/stalled there, prepare and apply
 *     are skipped entirely for this run (the scan Chrome and the advisory lock belong to that scan) and
 *     only select runs, read-only, so the report still explains where things stand.
 *   prepare -- re-probes listings whose apply target is still unresolved (or has cooled down for
 *     re-probe), via src/core/apply-target-persist.js, up to config/auto-apply.json's probeRowCap (3, the
 *     LinkedIn subset only) / probeRowCapWithBrowser (40, every non-LinkedIn row -- never needs a browser,
 *     so its cap is never reduced just because the LinkedIn browser session is unavailable this run) extra
 *     rows this run. Before probing, every row is pre-filtered by the SAME apply exclusion gate select uses
 *     (src/apply/exclusions.js) and an hourly-pay check -- an excluded or hourly row is skipped with its
 *     own reason and never consumes a lifetime probe attempt or the wall-clock time budget
 *     (probeTimeBudgetMs), checked only between rows, never mid-row. Attempts (best-effort, never fatal on
 *     failure) to reuse the scan Chrome session (src/browser/session.js's connectSession + target marker)
 *     for parity with scan-run.js's own getSession()/reconcileTargets() pattern; this CLI's own resolution
 *     is URL-only (redirect-chasing via fetch through src/apply/probe-registry.js), never a live browser
 *     click -- see docs/auto-apply-spec.md for that documented blind spot.
 *   select -- src/core/auto-apply-select.js's selectCandidates(): the apply exclusion gate, fit floor,
 *     US-only, salary floor, no active application, description present, apply target resolved to an
 *     exact, allow-listed ATS, not hourly pay, dedup on the resolved (ats, url) pair, then the daily cap.
 *     Also returns a SEQUENTIAL funnel (spec amendment A5) over the exact same single classify() pass --
 *     no second evaluation -- so the report can show where candidates actually fell out instead of the
 *     first gate (fit) misleadingly absorbing every later failure.
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
 * config/auto-apply.json's pollSeconds up to (hardDeadline - now) minutes -- NEVER the configured
 * lockMinutes default (spec amendment A2): once the hard deadline has already been spent waiting on the
 * scan, the lock poll must not add another lockMinutes=40 on top of that. Held ONLY for the duration of the
 * prepare phase (the one phase that shares the scan Chrome with an actual scan) -- released before
 * select/apply begin, since the final submission step (runApplyWorker, imported and called directly here,
 * never a spawned copy of bin/apply.js) already acquires/releases this SAME lock itself, per-application,
 * exactly as it does when the dashboard's apply-runner spawns it. Exit 2 (LOCKED) when the poll window
 * expires without ever acquiring the lock.
 *
 * --dry-run: the prepare phase makes zero database writes (src/core/apply-target-persist.js's own
 * dryRun-first check) and the apply phase is skipped entirely (no createApplication, no resume/review/
 * approve/worker calls) -- select still runs (read-only) so the dry-run summary shows what WOULD have
 * been selected.
 *
 * auto-apply-latest.json (src/core/auto-apply-state.js) is written at process start (phase "waiting") and
 * rewritten at every phase change (spec amendment A2), so bin/remind.js's 08:00 digest always shows THIS
 * run in progress rather than a stale summary from a previous day when auto-apply is still mid-flight at
 * digest time. A separate, never-overwritten logs/auto-apply-YYYY-MM-DD-HHMM.json (America/Chicago local
 * time, HHMM fixed at process start; a same-minute collision gets a -2/-3 suffix, never clobbers the
 * earlier file) is written once, at the very end of the run (spec amendment A6).
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
import { prepareLinkedInListing, adaptPlaywrightPage } from '../src/apply/linkedin-button-prepare.js';
import { selectCandidates, isUsLocation, isHourlyPaySignal } from '../src/core/auto-apply-select.js';
import { exclusionConfigPath, loadExclusionConfig, classifyExclusion } from '../src/apply/exclusions.js';
import { createApplication, approve } from '../src/core/applications.js';
import { createResumeRunner } from '../src/dashboard/resume-runner.js';
import { createReviewRunner } from '../src/dashboard/review-runner.js';
import { runApplyWorker } from '../src/apply/worker.js';
import { connectSession as defaultConnectSession, applyTargetMarkerPath } from '../src/browser/session.js';
import { makeCapability } from '../src/browser/capability.js';
import { buildRegistry } from '../src/core/urlguard.js';
import { defaultAutoApplySummaryFile, writeAutoApplySummary } from '../src/core/auto-apply-state.js';
import { waitForScan, localDeadline, defaultQueryLatestScanRun } from '../src/core/scan-wait.js';
import { launchChrome } from './scan.js';

const USAGE = 'usage: node bin/auto-apply.js [--dry-run] [--json [out]]';

/** Thrown by main()'s prepare phase when acquireLockWithPoll's poll window expires without ever acquiring
 * the lock -- a distinct, catchable signal (rather than a direct console.log/process.exit inline) so the
 * SAME outer routing (runLifecycle below) that catches every other uncaught error also catches this one and
 * always writes a terminal (phase 'done') summary before the process exits. Never thrown anywhere else. */
export class AutoApplyLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AutoApplyLockedError';
  }
}

/**
 * Builds the `finish(code)` closure every terminal exit routes through (see runLifecycle below and
 * main()'s own usage): marks the run done, writes the always-overwritten latest.json, writes the
 * never-overwritten dated run JSON (spec amendment A6, unconditional -- not only under --json), optionally
 * ALSO writes the user-requested --json file, prints the summary, closes the pool, exits. Every external
 * effect (file writes, pool close, process exit) is injected so this is fully testable without a real
 * filesystem-adjacent side effect surface beyond a caller-supplied temp directory, and without ever calling
 * the real process.exit (which would kill the test process).
 * @param {{
 *   summary: any, summaryFile: string, logDir: string, now: Date, timezone: string, jsonArg: string|null|undefined,
 *   log: (f: any) => void,
 *   writeSummaryFn?: typeof writeAutoApplySummary, writeDatedFn?: typeof writeRunJsonNoOverwrite,
 *   datedPathFn?: typeof datedRunJsonPath, closePoolFn?: () => Promise<void>, exitFn?: (code: number) => void,
 * }} opts
 * @returns {(code: number) => Promise<void>}
 */
export function createFinish(opts) {
  const writeSummaryFn = opts.writeSummaryFn ?? writeAutoApplySummary;
  const writeDatedFn = opts.writeDatedFn ?? writeRunJsonNoOverwrite;
  const datedPathFn = opts.datedPathFn ?? datedRunJsonPath;
  const closePoolFn = opts.closePoolFn ?? closePool;
  const exitFn = opts.exitFn ?? ((code) => process.exit(code));
  const persist = () => {
    try {
      writeSummaryFn(opts.summaryFile, opts.summary);
    } catch (err) {
      opts.log({ evt: 'auto_apply_summary_write_failed', ...errFields(err) });
    }
  };
  return async (code) => {
    opts.summary.phase = 'done';
    persist();
    try {
      const dated = writeDatedFn(datedPathFn(opts.logDir, opts.now, opts.timezone), opts.summary);
      opts.log({ evt: 'auto_apply_run_json_written', file: path.basename(dated) });
    } catch (err) {
      opts.log({ evt: 'auto_apply_run_json_write_failed', ...errFields(err) });
    }
    if (opts.jsonArg !== undefined) {
      const file = opts.jsonArg ?? path.join(opts.logDir, `auto-apply-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(opts.summary, null, 2) + '\n');
        opts.log({ evt: 'auto_apply_json_written', file: path.basename(file) });
      } catch (err) {
        opts.log({ evt: 'auto_apply_json_write_failed', ...errFields(err) });
      }
    }
    console.log(JSON.stringify(opts.summary));
    await closePoolFn().catch(() => {});
    exitFn(code);
  };
}

/**
 * The single routing point EVERY terminal exit passes through (spec-adversary finding on the original PR:
 * a failed lock acquisition and any uncaught exception both used to bypass `finish()` entirely, leaving
 * latest.json stuck at a non-'done' phase and skipping the dated run JSON for a process that had already
 * exited). Runs `body()`; on success, `body` itself is responsible for calling `finish(0)` at whatever point
 * it decides the run is complete (the still-running-at-deadline early return included) -- this wrapper only
 * exists to catch what `body` does NOT catch itself: an AutoApplyLockedError (outcome 'locked', exit 2) or
 * any other thrown error (outcome 'error', exit 1), setting `summary.outcome`/`summary.ok`/`summary.error`
 * and routing to `finish` either way, so a `phase: 'done'` summary is written no matter how the run ends.
 * @param {() => Promise<void>} body
 * @param {{ summary: any, finish: (code: number) => Promise<void>, log: (f: any) => void }} opts
 * @returns {Promise<void>}
 */
export async function runLifecycle(body, opts) {
  try {
    await body();
  } catch (err) {
    if (err instanceof AutoApplyLockedError) {
      opts.log({ evt: 'auto_apply_locked' });
      opts.summary.ok = false;
      opts.summary.outcome = 'locked';
      await opts.finish(2);
      return;
    }
    const f = errFields(err);
    opts.log({ evt: 'auto_apply_uncaught_error', ...f });
    opts.summary.ok = false;
    opts.summary.outcome = 'error';
    opts.summary.error = { message: String(f.err_message ?? (err instanceof Error ? err.message : String(err))), code: f.err_code ?? null };
    await opts.finish(1);
  }
}

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
  const deadline = Date.now() + Math.max(0, opts.lockMinutes) * 60000;
  for (;;) {
    const r = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    if (r.rows[0].ok) return true;
    if (Date.now() >= deadline) return false;
    opts.log({ evt: 'auto_apply_lock_wait', remaining_ms: deadline - Date.now() });
    await sleep(opts.pollSeconds * 1000);
  }
}

/**
 * The prepare phase: re-probe candidate listings whose apply target is unresolved or due for re-probe.
 * Two independent per-source caps (spec amendment A1): the LinkedIn subset never exceeds
 * `config.autoApply.probeRowCap` (3) regardless of browser availability, while every non-LinkedIn row --
 * which never needs a browser -- always gets up to `config.autoApply.probeRowCapWithBrowser` (40),
 * unaffected by whether the LinkedIn browser session could be opened this run. Before a row is actually
 * probed it passes two pre-filters (spec amendment A4): the apply exclusion gate
 * (src/apply/exclusions.js's classifyExclusion, the SAME gate select uses) and the hourly-pay signal
 * (auto-apply-select.js's isHourlyPaySignal); a row failing either is skipped with its own reason and never
 * consumes a lifetime probe attempt (ic_job_listings.probe_attempts) or the wall-clock time budget
 * (probeTimeBudgetMs, checked only between rows that reach real probe work, never mid-row and never for a
 * pre-filtered row).
 * @param {import('pg').ClientBase} client
 * @param {import('../src/core/config.js').LoadedConfig} config
 * @param {{
 *   now: Date, dryRun: boolean, log: (f: any) => void, fetch?: typeof fetch, lookup?: import('../src/core/urlguard.js').Lookup,
 *   linkedInBrowser?: { cap: { goto: (url: string) => Promise<any>, readJson: (name: string, arg?: unknown) => Promise<unknown> }, probeSession: { page: import('../src/apply/linkedin-button-probe.js').ButtonProbePage, session: import('../src/apply/linkedin-button-probe.js').ButtonProbeSession } } | null,
 *   exclusionConfig?: import('../src/apply/exclusions.js').ExclusionConfig,
 *   classifyExclusion?: (listing: any, ctx: any) => Promise<{ branch: string }>,
 *   clock?: () => number,
 * }} opts
 * @returns {Promise<{ attempted: number, resolved: number, unresolved: number, skipped: number, skippedByReason: Record<string, number>, stoppedBy: string|null, remaining: number }>}
 */
export async function runPrepare(client, config, opts) {
  const probeRegistry = buildProbeRegistryFromAtsApply(config.atsApply, INTERMEDIARY_HOSTS);
  const stats = { attempted: 0, resolved: 0, unresolved: 0, skipped: 0, skippedByReason: /** @type {Record<string, number>} */ ({}), stoppedBy: /** @type {string|null} */ (null), remaining: 0 };
  const bumpSkip = (/** @type {string} */ reason) => {
    stats.skipped++;
    stats.skippedByReason[reason] = (stats.skippedByReason[reason] ?? 0) + 1;
  };

  const linkedinCap = Math.max(0, config.autoApply.probeRowCap ?? 3);
  const nonLinkedinCap = Math.max(0, config.autoApply.probeRowCapWithBrowser ?? linkedinCap);
  const probeFitFloor = config.autoApply.probeFitFloor ?? 0;
  // Over-fetch relative to the two caps -- isUsLocation() is a total JS classification reused here rather
  // than re-implemented in SQL (single source of truth), so US-location filtering happens after the query;
  // the multiplier just needs to comfortably outrun the fraction of non-US rows in typical fit-desc order.
  const fetchLimit = Math.max(200, (linkedinCap + nonLinkedinCap) * 10);

  const cur = await client.query(
    `SELECT id, url, url_normalized, source, apply_probed_at, probe_attempts, fit_score, location_norm,
            company, company_norm, title, title_norm, description, salary_period, salary_raw,
            coalesce(url_normalized, url) AS source_url
     FROM ic_job_listings
     WHERE coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL AND expired_at IS NULL
       AND (status IS NULL OR status IN ('new', 'maybe', 'shortlisted'))
       AND probe_attempts < $1
       AND apply_ats_confidence IS DISTINCT FROM 'exact'
       AND (apply_probed_at IS NULL OR apply_probed_at < now() - ($2 || ' hours')::interval)
       AND fit_score >= $3
     ORDER BY fit_score DESC NULLS LAST, apply_probed_at ASC NULLS FIRST, id ASC
     LIMIT $4`,
    [LIFETIME_PROBE_ATTEMPTS, config.autoApply.reprobeAfterHours, probeFitFloor, fetchLimit],
  );

  /** @type {any[]} */
  const selectedRows = [];
  let linkedinTaken = 0;
  let otherTaken = 0;
  for (const row of cur.rows) {
    if (!isUsLocation(row.location_norm)) continue;
    if (row.source === 'linkedin') {
      if (linkedinTaken >= linkedinCap) continue;
      linkedinTaken++;
    } else {
      if (otherTaken >= nonLinkedinCap) continue;
      otherTaken++;
    }
    selectedRows.push(row);
  }

  const classifyExcl = opts.classifyExclusion ?? ((listingLike, ctx) => classifyExclusion(listingLike, ctx));
  const exclusionConfig = opts.classifyExclusion ? null : (opts.exclusionConfig ?? loadExclusionConfig(config.configDir));
  const clock = opts.clock ?? (() => Date.now());
  const timeBudgetMs = config.autoApply.probeTimeBudgetMs ?? Infinity;
  const startTs = clock();

  for (let i = 0; i < selectedRows.length; i++) {
    const row = selectedRows[i];
    const listing = {
      id: Number(row.id), url: row.url, url_normalized: row.url_normalized,
      apply_probed_at: row.apply_probed_at, probe_attempts: Number(row.probe_attempts ?? 0),
    };

    /** @type {string} */
    let exclBranch;
    try {
      const excl = await classifyExcl(
        {
          id: listing.id, company: row.company ?? null, companyNorm: row.company_norm ?? null,
          title: row.title ?? null, titleNorm: row.title_norm ?? null, applyUrl: null,
          sourceUrl: row.source_url ?? null, description: row.description ?? null,
        },
        { client, config: exclusionConfig },
      );
      exclBranch = excl.branch;
    } catch (err) {
      bumpSkip('exclusion_check_error');
      opts.log({ evt: 'auto_apply_prepare_prefilter_failed', listing_id: listing.id, ...errFields(err) });
      continue;
    }
    if (exclBranch !== 'eligible') {
      bumpSkip(`exclusion_${exclBranch}`);
      continue;
    }
    if (isHourlyPaySignal(row.salary_period ?? null, row.salary_raw ?? null)) {
      bumpSkip('hourly_pay');
      continue;
    }

    if (row.source === 'linkedin' && !opts.linkedInBrowser) {
      // No scan Chrome session available this run: never attempted, retried next run -- and never counted
      // against the time budget, matching every other pre-filter skip above.
      bumpSkip('no_browser');
      continue;
    }

    if (clock() - startTs > timeBudgetMs) {
      stats.stoppedBy = 'time_budget';
      stats.remaining = selectedRows.length - i;
      break;
    }

    stats.attempted++;
    try {
      /** @type {{ outcome: string }} */
      let result;
      if (row.source === 'linkedin') {
        result = await prepareLinkedInListing(client, listing, {
          cap: /** @type {any} */ (opts.linkedInBrowser).cap,
          probeSession: /** @type {any} */ (opts.linkedInBrowser).probeSession,
          adapterCfg: { dailyPages: config.adapters.adapters.linkedin?.dailyPages ?? 0, dailyDetails: config.adapters.adapters.linkedin?.dailyDetails ?? 0 },
          probeRegistry, reprobeAfterHours: config.autoApply.reprobeAfterHours, now: opts.now, dryRun: opts.dryRun, fetch: opts.fetch, lookup: opts.lookup,
          log: opts.log,
        });
      } else {
        result = await persistApplyTargetForListing(client, listing, null, {
          probeRegistry, reprobeAfterHours: config.autoApply.reprobeAfterHours, now: opts.now, dryRun: opts.dryRun, fetch: opts.fetch, lookup: opts.lookup,
        });
      }
      if (result.outcome === 'resolved') stats.resolved++;
      else if (result.outcome === 'unresolved') stats.unresolved++;
      else bumpSkip(result.outcome ?? 'skipped');
    } catch (err) {
      bumpSkip(errFields(err).err_code ? String(errFields(err).err_code) : 'probe_error');
      opts.log({ evt: 'auto_apply_prepare_probe_failed', listing_id: listing.id, ...errFields(err) });
    }
  }
  return stats;
}

/**
 * Best-effort scan-Chrome session reuse for the prepare phase. Connects, reconciles the shared apply
 * target marker (parity with scan-run.js's own getSession()/reconcileTargets() pattern), attaches ONE page
 * scoped to the 'linkedin' scan source, and returns everything runPrepare's LinkedIn branch needs: the
 * existing safe, read-only Capability (goto/readJson) plus the raw-page adapter GAP 1's click probe uses.
 * Returns null on ANY failure (session unreachable, attach failure) -- never throws, never blocks the run;
 * a null result simply means every LinkedIn row this run is left unresolved for next time (see
 * runPrepare's own doc comment).
 * @param {typeof defaultConnectSession} connectSession
 * @param {import('../src/core/config.js').Env} env
 * @param {import('../src/core/config.js').LoadedConfig} config
 * @param {(f: any) => void} log
 * @returns {Promise<{ cap: any, probeSession: any, close: () => Promise<void> } | null>}
 */
export async function openLinkedInBrowser(connectSession, env, config, log) {
  try {
    const session = await connectSession({ cdpUrl: env.SCAN_CDP_URL });
    try {
      await session.reconcileTargets(applyTargetMarkerPath(env.JOBSEARCH_LOG_DIR));
      await session.reconcile();
      const signal = new AbortController().signal;
      const page = await session.attachPage({ signal });
      const registry = buildRegistry(config);
      const cap = makeCapability(page, { registry, source: 'linkedin', signal });
      const { page: probePage, session: probeSessionAdapter } = adaptPlaywrightPage(page);
      return {
        cap, probeSession: { page: probePage, session: probeSessionAdapter },
        close: async () => { await session.closeAll().catch(() => {}); },
      };
    } catch (err) {
      await session.closeAll().catch(() => {});
      throw err;
    }
  } catch (err) {
    log({ evt: 'auto_apply_prepare_session_unavailable', ...errFields(err) });
    return null;
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

/**
 * `logs/auto-apply-YYYY-MM-DD-HHMM.json` (America/Chicago local time, HHMM fixed at process start -- spec
 * amendment A6). Distinct from the always-overwritten auto-apply-latest.json.
 * @param {string} logDir
 * @param {Date} now
 * @param {string} timezone
 * @returns {string}
 */
export function datedRunJsonPath(logDir, now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? '00';
  const stamp = `${get('year')}-${get('month')}-${get('day')}-${get('hour')}${get('minute')}`;
  return path.join(logDir, `auto-apply-${stamp}.json`);
}

/**
 * Write `summary` to `basePath`, NEVER overwriting an existing file -- a same-minute collision (two runs
 * starting in the same local minute) gets a `-2`, `-3`, ... suffix inserted before `.json` instead (spec
 * amendment A6). Returns the path actually written.
 * @param {string} basePath
 * @param {any} summary
 * @returns {string}
 */
export function writeRunJsonNoOverwrite(basePath, summary) {
  let candidate = basePath;
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = basePath.replace(/\.json$/, `-${n}.json`);
    n++;
  }
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, JSON.stringify(summary, null, 2) + '\n');
  return candidate;
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
  const timezone = config.adapters.run.timezone;
  const summaryFile = defaultAutoApplySummaryFile(env.JOBSEARCH_LOG_DIR);

  /** @type {Array<{ code: string, severity: 'warning', [k: string]: any }>} */
  const warnings = [];
  /** @type {any} */
  const summary = { ok: null, phase: 'waiting', started_at: now.toISOString(), dry_run: dryRun, warnings, prepare: null, select: null, applied: [] };
  const persist = () => {
    try {
      writeAutoApplySummary(summaryFile, summary);
    } catch (err) {
      log({ evt: 'auto_apply_summary_write_failed', ...errFields(err) });
    }
  };
  persist();

  const finish = createFinish({ summary, summaryFile, logDir: env.JOBSEARCH_LOG_DIR, now, timezone, jsonArg: args.json, log });

  // Apply exclusion gate config (spec section 2, amendment A4): loaded ONCE here, before the wait loop even
  // starts, and reused by BOTH the prepare-phase pre-filter and select -- a missing/invalid
  // config/apply-exclusions.json is a hard error that stops the whole run before prepare OR select ever
  // touch a listing, mirroring [NO SCAN]/[LOCK MISMATCH]'s existing loud-failure shape. This one still exits
  // through its own dedicated `finish(1)` rather than runLifecycle below: it is a distinct, well-understood
  // outcome (no_apply) that predates this fix and is deliberately never conflated with the generic 'error'
  // outcome runLifecycle assigns to everything else.
  /** @type {import('../src/apply/exclusions.js').ExclusionConfig} */
  let exclusionConfig;
  try {
    exclusionConfig = loadExclusionConfig(config.configDir);
  } catch (err) {
    const f = errFields(err);
    if (f.err_code !== 'CONFIG_INVALID') throw err;
    log({ evt: 'auto_apply_no_apply_config_invalid', ...f });
    Object.assign(summary, { ok: false, no_apply: { file: exclusionConfigPath(config.configDir), message: f.err_message } });
    await finish(1);
    return;
  }

  // runLifecycle (spec-adversary finding on the original PR, fixed here): EVERY remaining exit path --
  // normal completion, the still-running-at-deadline early return, a failed lock acquisition
  // (AutoApplyLockedError), and any other uncaught exception from wait/prepare/select/apply -- now routes
  // through `finish()` with an explicit `summary.outcome` (ok / scan_still_running / locked / error), so
  // latest.json and the dated run JSON are NEVER left describing a mid-run phase for a process that has
  // already exited. Nothing after this point calls process.exit directly except inside `finish` itself.
  await runLifecycle(async () => {
    const softDeadline = localDeadline(now, timezone, config.autoApply.waitDeadlineLocal);
    const hardDeadline = localDeadline(now, timezone, config.autoApply.waitHardDeadlineLocal);

    let scanState = { state: 'finished_today', detail: { runId: null, status: null } };
    if (config.autoApply.waitForScan) {
      const waitClient = await connectDedicated();
      try {
        scanState = await waitForScan(waitClient, {
          timezone, softDeadline, hardDeadline, pollSeconds: config.autoApply.waitPollSeconds,
          staleHeartbeatMinutes: config.autoApply.waitStaleHeartbeatMinutes, log,
          queryLatestScanRun: defaultQueryLatestScanRun,
        });
      } finally {
        await waitClient.end().catch(() => {});
      }
      log({ evt: 'auto_apply_wait_done', state: scanState.state, deadline_hit: /** @type {any} */ (scanState).deadlineHit ?? null });
    }
    summary.wait = { state: scanState.state, soft_deadline: softDeadline.toISOString(), hard_deadline: hardDeadline.toISOString() };

    // Bounded by (hard deadline - now) in EVERY state, finished_today included: nothing should wait past
    // the hard deadline for the advisory lock no matter why we got here -- even a scan that finished
    // cleanly could still find the lock held by some other process, and that wait must not extend past the
    // same hard deadline the scan-still-running path itself respects.
    const boundedLockMinutes = Math.max(0, (hardDeadline.getTime() - Date.now()) / 60000);

    if (scanState.state === 'running' || scanState.state === 'stalled') {
      // Hard deadline reached while the scan is still actively in progress: the scan owns Chrome and the
      // advisory lock, so prepare and apply are skipped entirely this run -- only select runs, read-only, so
      // the report still explains where things stand (spec amendment A2).
      warnings.push({ code: 'SCAN_STILL_RUNNING_AT_DEADLINE', severity: 'warning', state: scanState.state, detail: scanState.detail });
      summary.outcome = 'scan_still_running';
      summary.phase = 'selecting';
      persist();
      const selectClient = await connectDedicated();
      try {
        const selection = await selectCandidates(selectClient, {
          fitFloor: config.autoApply.fitFloor, floors: config.autoApply.floors, atsAllow: config.autoApply.atsAllow,
          dailyCap: config.autoApply.dailyCap, now, timezone, exclusionConfig,
        });
        log({ evt: 'auto_apply_select_done', cap_used: selection.capUsed, cap_remaining: selection.capRemaining, eligible: selection.eligible.length });
        Object.assign(summary, {
          ok: true,
          select: { results: selection.results, cap_used: selection.capUsed, cap_remaining: selection.capRemaining, dailyCap: selection.dailyCap, funnel: selection.funnel },
        });
      } finally {
        await selectClient.end().catch(() => {});
      }
      await finish(0);
      return;
    }

    if (scanState.state === 'failed') warnings.push({ code: 'SCAN_FAILED', severity: 'warning', detail: scanState.detail });
    else if (scanState.state === 'never_started') warnings.push({ code: 'SCAN_NOT_FINISHED', severity: 'warning', detail: scanState.detail });
    else if (scanState.state === 'unknown') warnings.push({ code: 'SCAN_STATE_UNKNOWN', severity: 'warning', detail: scanState.detail });

    if (scanState.state !== 'finished_today') {
      try {
        const chrome = await launchChrome(env, log);
        if (chrome.warning) warnings.push(/** @type {any} */ (chrome.warning));
      } catch (err) {
        const f = errFields(err);
        log({ evt: 'auto_apply_chrome_launch_failed', ...f });
        warnings.push({ code: 'CHROME_LAUNCH_FAILED', severity: 'warning', err_code: f.err_code, err_message: f.err_message });
      }
    }

    summary.phase = 'preparing';
    persist();

    const lockClient = await connectDedicated();
    let locked = false;
    /** @type {any} */
    let prepareStats = null;
    try {
      locked = await acquireLockWithPoll(lockClient, { lockMinutes: boundedLockMinutes, pollSeconds: config.autoApply.pollSeconds, log });
      if (!locked) {
        // Thrown, never exited inline here -- runLifecycle's own catch is the ONLY place that turns this
        // into a terminal, phase:'done' summary (outcome 'locked', exit 2). See AutoApplyLockedError's doc.
        throw new AutoApplyLockedError('could not acquire the advisory lock before the deadline');
      }
      const linkedInBrowser = await openLinkedInBrowser(defaultConnectSession, env, config, log);
      try {
        prepareStats = await runPrepare(lockClient, config, { now, dryRun, log, linkedInBrowser, exclusionConfig });
      } finally {
        if (linkedInBrowser) await linkedInBrowser.close();
      }
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
    summary.prepare = prepareStats;
    summary.phase = 'selecting';
    persist();

    const selectClient = await connectDedicated();
    /** @type {any} */
    let selection;
    try {
      selection = await selectCandidates(selectClient, {
        fitFloor: config.autoApply.fitFloor, floors: config.autoApply.floors, atsAllow: config.autoApply.atsAllow,
        dailyCap: config.autoApply.dailyCap, now, timezone, exclusionConfig,
      });
    } finally {
      await selectClient.end().catch(() => {});
    }
    log({ evt: 'auto_apply_select_done', cap_used: selection.capUsed, cap_remaining: selection.capRemaining, eligible: selection.eligible.length });
    summary.select = { results: selection.results, cap_used: selection.capUsed, cap_remaining: selection.capRemaining, dailyCap: selection.dailyCap, funnel: selection.funnel };

    const outputRoot = path.join(repoRoot(), 'output');
    /** @type {any[]} */
    const applyResults = [];
    if (!dryRun && selection.eligible.length) {
      summary.phase = 'applying';
      persist();
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

    summary.ok = true;
    summary.outcome = 'ok';
    summary.applied = applyResults;
    await finish(0);
  }, { summary, finish, log });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
