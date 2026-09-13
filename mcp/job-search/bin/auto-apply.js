#!/usr/bin/env node
// @ts-check
/**
 * Auto-apply CLI (auto-apply PR B, docs/auto-apply-spec.md), scheduled 06:55 daily as Windows Scheduled
 * Task "job-search auto-apply" via scripts/register-auto-apply-task.ps1.
 *
 *   node bin/auto-apply.js [--dry-run] [--json [out]] [--application <id>]
 *
 * --application <id> (submit-on-resume spec section 4): re-drives ONE existing application by id,
 * entirely bypassing the four phases below -- see runSingleApplication()'s own doc comment for its gate
 * and needs_human handling. Mutually usable with --json; --dry-run has no effect on this path (there is
 * no read-only "would have selected" concept for a single, caller-specified application).
 *
 * Four phases, in order (skipped entirely when --application is given):
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
 *     listing.apply_url) -> resume runner -> review runner (ADVISORY ONLY, submit-on-resume spec section
 *     1: "any application whose resume DOCX gets produced or linked is submitted unattended. Review is
 *     advisory.") -> approve() -> runApplyWorker(). A review FAIL, no verdict at all (a review-runner
 *     throw, an unparseable result, or a timeout), and a PASS are all treated identically here: the chain
 *     always proceeds to approve() + the worker regardless of what review found, recording whatever
 *     verdict/reason it got (`review_verdict`/`review_reason`, both null when review never produced one)
 *     on the outcome. Only a resume-runner failure (never a review-runner one) stops the chain before
 *     approve() -- CLAUDE.md's "unattended soft failures warn and proceed" -- never aborts the whole run.
 *     approve() is called with actor:'auto' specifically so src/core/auto-apply-select.js's
 *     countAutoApprovedToday() (the daily-cap accounting) counts exactly the applications THIS pipeline
 *     actually advanced; a review FAIL now DOES consume a cap slot, because it is submitted (spec section
 *     1: "a review FAIL now consumes a daily-cap slot because it is submitted").
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
import { selectCandidates, isUsLocation, isHourlyPaySignal, classifyCandidate, countAutoApprovedToday } from '../src/core/auto-apply-select.js';
import { exclusionConfigPath, loadExclusionConfig, classifyExclusion } from '../src/apply/exclusions.js';
import { createApplication, approve, getApplication, transition, retry, checkApplicationBlockers } from '../src/core/applications.js';
import { createResumeRunner } from '../src/dashboard/resume-runner.js';
import { createReviewRunner } from '../src/dashboard/review-runner.js';
import { runApplyWorker } from '../src/apply/worker.js';
import { connectSession as defaultConnectSession, applyTargetMarkerPath } from '../src/browser/session.js';
import { makeCapability } from '../src/browser/capability.js';
import { buildRegistry } from '../src/core/urlguard.js';
import { defaultAutoApplySummaryFile, writeAutoApplySummary } from '../src/core/auto-apply-state.js';
import { waitForScan, localDeadline, defaultQueryLatestScanRun } from '../src/core/scan-wait.js';
import { launchChrome } from './scan.js';
import { runningMarkerPath, writeRunningMarker, deleteRunningMarker } from '../src/core/running-marker.js';

const USAGE = 'usage: node bin/auto-apply.js [--dry-run] [--json [out]] [--application <id>]';

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
 *   markerFile?: string activity pill running marker (src/core/running-marker.js); deleted as the very
 *     first action below, BEFORE exitFn/process.exit runs -- process.exit() does not unwind pending
 *     `finally` blocks further up the call stack, so this is the only point in this file guaranteed to
 *     run on every terminal exit (normal, locked, and error) before the process actually terminates.
 *     Omitted (undefined) is a no-op, so existing callers/tests that never pass it are unaffected.
 *   writeSummaryFn?: typeof writeAutoApplySummary, writeDatedFn?: typeof writeRunJsonNoOverwrite,
 *   datedPathFn?: typeof datedRunJsonPath, closePoolFn?: () => Promise<void>, exitFn?: (code: number) => void,
 *   deleteMarkerFn?: typeof deleteRunningMarker,
 * }} opts
 * @returns {(code: number) => Promise<void>}
 */
export function createFinish(opts) {
  const writeSummaryFn = opts.writeSummaryFn ?? writeAutoApplySummary;
  const writeDatedFn = opts.writeDatedFn ?? writeRunJsonNoOverwrite;
  const datedPathFn = opts.datedPathFn ?? datedRunJsonPath;
  const closePoolFn = opts.closePoolFn ?? closePool;
  const exitFn = opts.exitFn ?? ((code) => process.exit(code));
  const deleteMarkerFn = opts.deleteMarkerFn ?? deleteRunningMarker;
  const persist = () => {
    try {
      writeSummaryFn(opts.summaryFile, opts.summary);
    } catch (err) {
      opts.log({ evt: 'auto_apply_summary_write_failed', ...errFields(err) });
    }
  };
  return async (code) => {
    if (opts.markerFile) deleteMarkerFn(opts.markerFile);
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

/**
 * Second line of defense against the resume-runner.js / review-runner.js event-loop-drain bug (see those
 * files' own doc comments on why `child.unref()` / an unref'd hard timer let Node exit mid-run with no
 * terminal log line and no DB write): installs a `beforeExit` listener active for the lifetime of one
 * `main()` run. `beforeExit` fires only when the event loop has genuinely run out of scheduled work --
 * which never happens on a normal completion, since every normal exit path calls `finish()`, and `finish()`
 * always ends in an explicit `exitFn` (real code: `process.exit()`, which never emits `beforeExit`). So
 * seeing `beforeExit` fire before `finish()` has run is itself the bug signature, from any cause -- this
 * runner's own known unref bug, a future one, or anything else that manages to unref every live handle
 * mid-run -- and is treated as `loop_drained`: NEVER a silent, accidental exit 0.
 *
 * `getInFlight()` reports the one application (if any) actually in progress at the moment the drain is
 * detected, so only THAT application is parked -- never a stale one from an earlier loop iteration, and
 * never one whose state has already moved past 'drafting' by the time this fires (a resume that finished a
 * moment before the drain, or one fail() already parked itself, is left untouched, exactly like
 * resume-runner.js's own fail() re-check).
 *
 * `fired` guards against `beforeExit`'s own documented re-entrancy: the handler below AWAITS a DB
 * transition, which is itself new scheduled work, so once that resolves (or the process has no more work
 * left) Node can emit `beforeExit` again -- only the FIRST emission should do the real log/park/exit work.
 * @param {import('node:events').EventEmitter} proc real `process` in production; a plain EventEmitter in
 *   tests (this function never touches the real `process` object directly beyond taking it as `proc`).
 * @param {{
 *   isFinished: () => boolean,
 *   getInFlight: () => { applicationId: number, phase: string } | null,
 *   log: (f: any) => void,
 *   summary: any,
 *   summaryFile: string,
 *   writeSummaryFn?: typeof writeAutoApplySummary,
 *   withClientFn: typeof withClient,
 *   getApplicationFn?: typeof getApplication,
 *   transitionFn?: typeof transition,
 *   exitFn?: (code: number) => void,
 * }} opts
 * @returns {() => void} uninstall function -- removes the listener; call once the run is otherwise done
 *   (in production this line is never reached because `finish()`'s own `process.exit()` already terminated
 *   the process, but it matters for tests, which stub `exitFn` and keep running afterward).
 */
export function installLoopDrainedGuard(proc, opts) {
  const writeSummaryFn = opts.writeSummaryFn ?? writeAutoApplySummary;
  const exitFn = opts.exitFn ?? ((code) => process.exit(code));
  let fired = false;
  const handler = () => {
    if (opts.isFinished() || fired) return;
    fired = true;
    const inFlight = opts.getInFlight();
    opts.log({
      evt: 'auto_apply_loop_drained', phase: opts.summary.phase,
      application_id: inFlight ? inFlight.applicationId : null,
    });
    opts.summary.phase = 'failed';
    opts.summary.ok = false;
    opts.summary.outcome = 'loop_drained';
    try {
      writeSummaryFn(opts.summaryFile, opts.summary);
    } catch (err) {
      opts.log({ evt: 'auto_apply_summary_write_failed', ...errFields(err) });
    }
    (async () => {
      if (inFlight) {
        try {
          const app = await opts.withClientFn((c) => (opts.getApplicationFn ?? getApplication)(c, inFlight.applicationId));
          if (app.state === 'drafting') {
            await opts.withClientFn((c) => (opts.transitionFn ?? transition)(c, inFlight.applicationId, 'needs_human', {
              actor: 'apply', pending_question: { kind: 'resume_failed', label: 'Resume drafting failed: process loop drained' },
            }));
          }
        } catch (err) {
          opts.log({ evt: 'auto_apply_loop_drained_park_failed', application_id: inFlight.applicationId, ...errFields(err) });
        }
      }
      exitFn(1);
    })();
  };
  proc.on('beforeExit', handler);
  return () => proc.removeListener('beforeExit', handler);
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ dryRun: boolean, json: string|null|undefined, help: boolean, applicationId: number|undefined }} */
  const out = { dryRun: false, json: undefined, help: false, applicationId: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        out.json = v;
        i++;
      } else out.json = null;
    } else if (a === '--application') {
      const v = argv[i + 1];
      const n = Number(v);
      if (!v || v.startsWith('--') || !Number.isInteger(n) || n <= 0) {
        throw new Error(`--application requires a positive integer application id (${USAGE})`);
      }
      out.applicationId = n;
      i++;
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
 * Best-effort scan-Chrome launch (fix for the single-application-path bug where `--application <id>`
 * reached the apply worker without ever launching Chrome, failing within 1.5 s with "cannot connect to
 * scan Chrome at the configured SCAN_CDP_URL"): shared by the multi-candidate path (main(), before the
 * lock/prepare phase) and runSingleApplication (before its one runWorker call, and only once every gate
 * has passed -- there is no point launching Chrome for a re-drive that is about to be refused). Calls
 * scan.js's own launchChrome and NEVER throws -- a launch failure or a self-heal warning is returned as a
 * `CHROME_LAUNCH_FAILED`/launch warning for the caller to push onto its own warnings array and proceed,
 * exactly matching CLAUDE.md's "unattended soft failures warn and proceed" and the multi-candidate path's
 * pre-existing behavior.
 * @param {import('../src/core/config.js').Env} env
 * @param {(f: any) => void} log
 * @param {typeof launchChrome} [launchChromeFn] test seam only -- production callers always use the
 *   default (the real scan.js launchChrome), which itself self-heals; tests never touch real Chrome.
 * @returns {Promise<Array<{ code: string, severity: 'warning', [k: string]: any }>>}
 */
export async function ensureScanChrome(env, log, launchChromeFn = launchChrome) {
  try {
    const chrome = await launchChromeFn(env, log);
    return chrome && chrome.warning ? [chrome.warning] : [];
  } catch (err) {
    const f = errFields(err);
    log({ evt: 'auto_apply_chrome_launch_failed', ...f });
    return [{ code: 'CHROME_LAUNCH_FAILED', severity: 'warning', err_code: f.err_code, err_message: f.err_message }];
  }
}

/**
 * The apply phase for ONE selected candidate: createApplication -> resume -> review (ADVISORY, never a
 * submit gate -- submit-on-resume spec section 1) -> approve (actor:'auto') -> runApplyWorker. Never
 * throws -- every phase's own failure is caught and reported as a closed outcome so the caller's loop
 * always proceeds to the next candidate. Only a resume-runner failure stops the chain before approve();
 * review's outcome (PASS, FAIL, or no verdict at all) is recorded on `review_verdict`/`review_reason` and
 * otherwise ignored by the control flow -- every returned outcome object carries these two fields (both
 * null when review never ran or never produced a verdict), never only the 'applied' ones.
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
    return { outcome: 'create_failed', listingId: row.listingId, review_verdict: null, review_reason: null };
  }
  // Reports the newly created application id back to main()'s loop-drained guard (installLoopDrainedGuard
  // above) so a mid-run event-loop drain parks THIS application, never a stale one -- optional so every
  // existing test/caller that does not pass it is unaffected.
  deps.onApplicationStarted?.(app.id);

  /** @type {any} */
  let resumeResult;
  try {
    resumeResult = await deps.resumeRunner.run(app.id, row.listingId);
  } catch (err) {
    deps.log({ evt: 'auto_apply_resume_runner_threw', application_id: app.id, ...errFields(err) });
    return { outcome: 'resume_failed', listingId: row.listingId, applicationId: app.id, reason: errFields(err).err_code, review_verdict: null, review_reason: null };
  }
  if (!resumeResult.ok || !resumeResult.markdownPath) {
    return { outcome: 'resume_failed', listingId: row.listingId, applicationId: app.id, reason: resumeResult.reason ?? null, review_verdict: null, review_reason: null };
  }

  // Advisory review (spec section 1): review-cv's verdict no longer gates submission. A review-runner
  // throw is no longer its own 'review_failed' outcome that stops the chain here -- it is logged
  // (auto_apply_review_advisory) and the chain proceeds exactly as if review had returned no verdict at
  // all (review-runner.js's own storeReview() already persisted review_verdict/review_findings for
  // whatever DID complete before the throw, if anything; a throw before that point simply leaves both
  // columns at their prior value, and reviewVerdict/reviewReason here stay null either way).
  let reviewVerdict = null;
  let reviewReason = null;
  try {
    const reviewResult = await deps.reviewRunner.run(app.id, resumeResult.markdownPath, row.listingId);
    reviewVerdict = reviewResult.verdict ?? null;
    reviewReason = reviewResult.reason ?? null;
  } catch (err) {
    deps.log({ evt: 'auto_apply_review_advisory', application_id: app.id, ...errFields(err) });
  }

  try {
    await deps.withClientFn((c) => approve(c, app.id, { outputRoot: deps.outputRoot, actor: 'auto' }));
  } catch (err) {
    deps.log({ evt: 'auto_apply_approve_failed', application_id: app.id, ...errFields(err) });
    return {
      outcome: 'approve_failed', listingId: row.listingId, applicationId: app.id, reason: errFields(err).err_code,
      review_verdict: reviewVerdict, review_reason: reviewReason,
    };
  }

  try {
    const workerResult = await deps.runWorker(app.id, { env: deps.env, log: deps.log });
    return {
      outcome: workerResult.ok ? 'applied' : 'apply_failed', listingId: row.listingId, applicationId: app.id,
      workerStatus: workerResult.status, review_verdict: reviewVerdict, review_reason: reviewReason,
    };
  } catch (err) {
    deps.log({ evt: 'auto_apply_worker_threw', application_id: app.id, ...errFields(err) });
    return {
      outcome: 'apply_failed', listingId: row.listingId, applicationId: app.id, reason: errFields(err).err_code,
      review_verdict: reviewVerdict, review_reason: reviewReason,
    };
  }
}

/** States runSingleApplication() (below) will re-drive; anything else is refused with `state_<state>`.
 * 'failed' (single-path-chrome fix): re-drives via retry(), never resume/review -- see this function's own
 * doc comment. */
const RE_DRIVE_ALLOWED_STATES = Object.freeze(['drafting', 'needs_human', 'docs_ready', 'failed']);

/**
 * `--application <id>` re-drive (submit-on-resume spec section 4, amendments A1/A2/A3): re-runs the apply
 * chain for ONE existing application, bypassing wait/prepare/select entirely. Never throws for a refusal
 * -- a gate failure is a normal, expected outcome (`{ outcome: 'refused', reason }`), not a crash; the
 * caller (main()) always exits 0 for a refusal, per amendment A1 ("Any skip reason refuses the re-drive
 * with that reason in the summary and exit code 0").
 *
 * Gate (amendment A1), checked in this order, first failure wins:
 *   1. state must be one of RE_DRIVE_ALLOWED_STATES.
 *   2. a needs_human park is only re-driven when `pending_question.kind === 'resume_failed'` (amendment
 *      A3, resume-runner.js's own visible-failure park, spec section 3) -- any other kind (a screening
 *      question, a credential prompt, etc.) is refused pointing at the /apply-answer skill, since
 *      re-running the resume runner would not address what is actually parking the application.
 *   3. the apply exclusion gate (src/apply/exclusions.js's classifyExclusion) -- `excludeApplicationId`
 *      is set to THIS application's own id so it never counts as "already applied" against itself (the
 *      exact hazard checkApplicationBlockers's own doc comment describes for the identical reason).
 *   4. the SAME salary/hourly/fit/US/etc classification auto-apply-select.js's selectCandidates() uses
 *      per candidate row (classifyCandidate: not_scored/below_fit/human_fit_override/not_us/
 *      salary_below_floor/no_description/apply_target_unresolved/easy_apply_only/ats_not_allowed/
 *      confidence_not_exact/hourly_pay) -- `hasActiveApplication` is deliberately forced to `false` here
 *      (gate 3 above already handled "already applied" correctly, excluding this application's own row;
 *      classifyCandidate has no such exclusion parameter, so this is the only way to avoid it reporting
 *      'active_application' against the very application being re-driven).
 *   5. checkApplicationBlockers() -- closed listing status anywhere in the dedup tree, or another sibling
 *      application already actively progressing (SIBLING_ACTIVE_STATES).
 *   6. the daily cap (countAutoApprovedToday vs config.autoApply.dailyCap) -- already exhausted today.
 *
 * needs_human -> drafting -> resume (amendment A2): a resume_failed park is transitioned needs_human ->
 * drafting (actor 'cli', the TRANSITIONS edge amendment A2 adds) BEFORE anything else runs. If the
 * application already carries a linked resume_doc_id at that point (an edge case: a document was linked
 * before whatever parked it), this transitions drafting -> docs_ready directly rather than re-running the
 * resume runner to draft a duplicate. A docs_ready application (from the start, or reached via that
 * shortcut) never runs the resume runner OR the review runner in this call -- there is nothing new to
 * review, and review only runs here against a markdown path THIS run's own resume runner just produced
 * (see this codebase's blind-spot notes for why there is no other way to locate that path).
 *
 * failed -> approved (single-path-chrome fix): a 'failed' application is re-driven via retry() (actor
 * 'cli' -- see the cap-counting comment at that call site), never resume/review/approve() -- a failed
 * application always already carries a linked resume document (see that call site's own comment), so this
 * goes straight to the worker once retried.
 *
 * Chrome (single-path-chrome fix): unlike the multi-candidate path in main() (which launches scan Chrome
 * unconditionally once a scan is not known to have finished today, before prepare even starts), this
 * function only knows a worker step will run once every gate above has passed, so it calls the SAME shared
 * ensureScanChrome() helper exactly once, immediately before its own runWorker call -- never earlier, since
 * refusing a re-drive (a gate failure) or a resume-runner/approve failure has no worker step to launch
 * Chrome for.
 * @param {number} id
 * @param {{
 *   withClientFn: typeof withClient,
 *   resumeRunner: ReturnType<typeof createResumeRunner>,
 *   reviewRunner: ReturnType<typeof createReviewRunner>,
 *   runWorker: typeof runApplyWorker,
 *   outputRoot: string,
 *   env: import('../src/core/config.js').Env,
 *   log: (f: any) => void,
 *   config: import('../src/core/config.js').LoadedConfig,
 *   now: Date,
 *   exclusionConfig?: import('../src/apply/exclusions.js').ExclusionConfig,
 *   classifyExclusionFn?: typeof classifyExclusion,
 *   classifyCandidateFn?: typeof classifyCandidate,
 *   checkApplicationBlockersFn?: typeof checkApplicationBlockers,
 *   countAutoApprovedTodayFn?: typeof countAutoApprovedToday,
 *   retryFn?: typeof retry,
 *   launchChromeFn?: typeof launchChrome,
 * }} deps `classifyExclusionFn`/`classifyCandidateFn`/`checkApplicationBlockersFn`/
 *   `countAutoApprovedTodayFn`/`retryFn`/`launchChromeFn` are test seams ONLY (never set by production
 *   wiring -- main() below leaves every one at its real default), matching this file's own
 *   `opts.classifyExclusion` seam on runPrepare.
 */
export async function runSingleApplication(id, deps) {
  const classifyExclusionFn = deps.classifyExclusionFn ?? classifyExclusion;
  const classifyCandidateFn = deps.classifyCandidateFn ?? classifyCandidate;
  const checkApplicationBlockersFn = deps.checkApplicationBlockersFn ?? checkApplicationBlockers;
  const countAutoApprovedTodayFn = deps.countAutoApprovedTodayFn ?? countAutoApprovedToday;

  /** @type {any} */
  let app;
  try {
    app = await deps.withClientFn((c) => getApplication(c, id));
  } catch (err) {
    deps.log({ evt: 'auto_apply_single_not_found', application_id: id, ...errFields(err) });
    return { outcome: 'refused', applicationId: id, listingId: null, reason: 'not_found' };
  }

  if (!RE_DRIVE_ALLOWED_STATES.includes(app.state)) {
    return { outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: `state_${app.state}` };
  }

  if (app.state === 'needs_human') {
    const kind = app.pending_question && typeof app.pending_question.kind === 'string' ? app.pending_question.kind : null;
    if (kind !== 'resume_failed') {
      return {
        outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: 'needs_human_not_resume_failed',
        message: 'Parked on something other than a visible resume failure (e.g. a screening question). Use the /apply-answer skill to resolve it, then re-drive.',
      };
    }
  }

  const listingRes = await deps.withClientFn((c) => c.query(
    `SELECT l.id, l.fit_score, l.duplicate_of, l.location_norm, l.remote_mode, l.salary_max, l.salary_period,
            l.salary_raw, l.description, l.apply_url, l.apply_ats, l.apply_ats_confidence, l.apply_easy_only,
            l.company, l.company_norm, l.title, l.title_norm, coalesce(l.url_normalized, l.url) AS source_url,
            (SELECT actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'fit' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS fit_actor
     FROM ic_job_listings l WHERE l.id = $1`,
    [app.listing_id],
  ));
  if (listingRes.rowCount === 0) {
    return { outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: 'listing_not_found' };
  }
  const l = listingRes.rows[0];

  const exclusionConfig = deps.exclusionConfig ?? loadExclusionConfig(deps.config.configDir);
  const exclusionListing = {
    id: Number(app.listing_id), company: l.company ?? null, companyNorm: l.company_norm ?? null,
    title: l.title ?? null, titleNorm: l.title_norm ?? null, applyUrl: l.apply_url ?? null,
    sourceUrl: l.source_url ?? null, description: l.description ?? null,
  };
  const excl = await deps.withClientFn((c) => classifyExclusionFn(exclusionListing, { client: c, config: exclusionConfig, excludeApplicationId: id }));
  if (excl.branch !== 'eligible') {
    return { outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: `exclusion_${excl.branch}` };
  }

  const candidateRow = {
    listingId: Number(app.listing_id), fitScore: l.fit_score === null ? null : Number(l.fit_score),
    fitActor: l.fit_actor ?? null, duplicateOf: l.duplicate_of === null ? null : Number(l.duplicate_of),
    locationNorm: l.location_norm ?? null, remoteMode: l.remote_mode ?? null,
    salaryMax: l.salary_max === null ? null : Number(l.salary_max), salaryPeriod: l.salary_period ?? null,
    salaryRaw: l.salary_raw ?? null,
    // Deliberately false -- see this function's own doc comment (gate 4).
    hasActiveApplication: false,
    description: l.description ?? null, applyUrl: l.apply_url ?? null, applyAts: l.apply_ats ?? null,
    applyConfidence: l.apply_ats_confidence ?? null, applyEasyOnly: Boolean(l.apply_easy_only),
  };
  const candidateReason = classifyCandidateFn(candidateRow, {
    fitFloor: deps.config.autoApply.fitFloor, floors: deps.config.autoApply.floors, atsAllow: deps.config.autoApply.atsAllow,
  });
  if (candidateReason !== 'eligible') {
    return { outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: candidateReason };
  }

  const blockers = await deps.withClientFn((c) => checkApplicationBlockersFn(c, { id: app.id, listing_id: app.listing_id }, { config: exclusionConfig }));
  if (blockers.blocked) {
    return { outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: blockers.blockedReason };
  }
  if (blockers.siblingActive) {
    return { outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: 'sibling_active' };
  }

  // Amendment A5 (ACCEPTED, no lock work): a scheduled auto-apply run and a manual --application re-drive
  // can race on this exact count between this read and either one's own approve() a moment later, in
  // principle letting the daily cap be exceeded by one slot on an unlucky interleaving. Damian's own
  // ruling on this: accepted as-is, not worth a cross-process lock for a once-a-day operator-triggered
  // action against an already-generous cap.
  const capUsed = await deps.withClientFn((c) => countAutoApprovedTodayFn(c, deps.now, deps.config.adapters.run.timezone));
  if (capUsed >= deps.config.autoApply.dailyCap) {
    return { outcome: 'refused', applicationId: id, listingId: app.listing_id, reason: 'daily_cap' };
  }

  if (app.state === 'needs_human') {
    await deps.withClientFn((c) => transition(c, id, 'drafting', { actor: 'cli', note: 're-drive: resume_failed park cleared for another attempt' }));
    app = await deps.withClientFn((c) => getApplication(c, id));
  }

  // failed -> approved (single-path-chrome fix, spec point 2): a 'failed' application only ever gets there
  // from 'submitting', which only ever gets there from 'approved', which requires docs_ready with a linked
  // resume -- so the document is ALWAYS already linked here, unlike the needs_human/drafting branches
  // above. retryFn (real default: applications.js's own retry()) moves failed -> approved directly,
  // incrementing `attempt`; the resume runner, review runner, and approve() (which requires docs_ready, not
  // failed, and would recompute hashes that have not changed) are all skipped entirely -- straight to the
  // worker below.
  //
  // actor 'cli', not 'auto' (spec point 2's cap-counting choice, stated again in this PR's body):
  // countAutoApprovedToday counts raw `to_state = 'approved' AND actor = 'auto'` EVENT ROWS, not distinct
  // application ids. This same application already recorded one such row when it was first approved (by
  // this same auto-apply pipeline) before it failed. If retry() recorded a SECOND 'auto' row for it today,
  // countAutoApprovedToday would count it twice against one daily-cap slot. Recording this retry with actor
  // 'cli' instead keeps the count accurate without changing countAutoApprovedToday's shared SQL (also read
  // by the multi-candidate select path) to DISTINCT application_id, which would be a larger, riskier change
  // for a narrower benefit.
  const retryFn = deps.retryFn ?? retry;
  let retriedFailed = false;
  if (app.state === 'failed') {
    try {
      await deps.withClientFn((c) => retryFn(c, id, { actor: 'cli', note: 're-drive: retry after failure' }));
    } catch (err) {
      deps.log({ evt: 'auto_apply_single_retry_failed', application_id: id, ...errFields(err) });
      return { outcome: 'retry_failed', applicationId: id, listingId: app.listing_id, reason: errFields(err).err_code, review_verdict: null, review_reason: null };
    }
    app = await deps.withClientFn((c) => getApplication(c, id));
    retriedFailed = true;
  }

  let markdownPath = null;
  let ranResumeRunner = false;
  if (!retriedFailed && app.state !== 'docs_ready') {
    if (app.resume_doc_id) {
      // A document is already linked despite the non-docs_ready state (edge case) -- move directly to
      // docs_ready rather than re-running the resume runner to draft a duplicate.
      await deps.withClientFn((c) => transition(c, id, 'docs_ready', { actor: 'cli', note: 're-drive: resume already linked' }));
    } else {
      /** @type {any} */
      let resumeResult;
      try {
        resumeResult = await deps.resumeRunner.run(id, app.listing_id);
      } catch (err) {
        deps.log({ evt: 'auto_apply_single_resume_runner_threw', application_id: id, ...errFields(err) });
        return { outcome: 'resume_failed', applicationId: id, listingId: app.listing_id, reason: errFields(err).err_code, review_verdict: null, review_reason: null };
      }
      if (!resumeResult.ok || !resumeResult.markdownPath) {
        return { outcome: 'resume_failed', applicationId: id, listingId: app.listing_id, reason: resumeResult.reason ?? null, review_verdict: null, review_reason: null };
      }
      markdownPath = resumeResult.markdownPath;
      ranResumeRunner = true;
    }
  }

  let reviewVerdict = null;
  let reviewReason = null;
  if (ranResumeRunner && markdownPath) {
    try {
      const reviewResult = await deps.reviewRunner.run(id, markdownPath, app.listing_id);
      reviewVerdict = reviewResult.verdict ?? null;
      reviewReason = reviewResult.reason ?? null;
    } catch (err) {
      deps.log({ evt: 'auto_apply_single_review_advisory', application_id: id, ...errFields(err) });
    }
  }

  if (!retriedFailed) {
    try {
      await deps.withClientFn((c) => approve(c, id, { outputRoot: deps.outputRoot, actor: 'auto' }));
    } catch (err) {
      deps.log({ evt: 'auto_apply_single_approve_failed', application_id: id, ...errFields(err) });
      return {
        outcome: 'approve_failed', applicationId: id, listingId: app.listing_id, reason: errFields(err).err_code,
        review_verdict: reviewVerdict, review_reason: reviewReason,
      };
    }
  }

  // Chrome launch (single-path-chrome fix, spec point 1): mirrors main()'s own pre-prepare launch below,
  // called here -- and ONLY here -- because every gate has now passed and a worker step is about to run.
  // Never fatal: a launch failure or self-heal warning is folded into this outcome's own `warnings` (main()
  // merges it into the run's top-level warnings array, same as the multi-candidate path) and the worker is
  // attempted regardless, exactly like the CHROME_LAUNCH_FAILED warn-and-proceed handling below it mirrors.
  const launchChromeFn = deps.launchChromeFn ?? launchChrome;
  const chromeWarnings = await ensureScanChrome(deps.env, deps.log, launchChromeFn);

  try {
    const workerResult = await deps.runWorker(id, { env: deps.env, log: deps.log });
    return {
      outcome: workerResult.ok ? 'applied' : 'apply_failed', applicationId: id, listingId: app.listing_id,
      workerStatus: workerResult.status, review_verdict: reviewVerdict, review_reason: reviewReason, warnings: chromeWarnings,
    };
  } catch (err) {
    deps.log({ evt: 'auto_apply_single_worker_threw', application_id: id, ...errFields(err) });
    return {
      outcome: 'apply_failed', applicationId: id, listingId: app.listing_id, reason: errFields(err).err_code,
      review_verdict: reviewVerdict, review_reason: reviewReason, warnings: chromeWarnings,
    };
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

  // Activity pill running marker (spec item 2): written before any phase work starts, deleted by
  // createFinish() above -- as its first action, before exitFn/process.exit -- on every terminal exit.
  // Best-effort: a write failure here is logged but never fatal to the run itself (see
  // src/core/running-marker.js's doc comment).
  const markerFile = runningMarkerPath(env.JOBSEARCH_LOG_DIR, 'auto-apply');
  try {
    writeRunningMarker(markerFile, { pid: process.pid, startedAt: now, runId: null });
  } catch (err) {
    log({ evt: 'auto_apply_running_marker_write_failed', ...errFields(err) });
  }

  const rawFinish = createFinish({ summary, summaryFile, logDir: env.JOBSEARCH_LOG_DIR, now, timezone, jsonArg: args.json, log, markerFile });
  // `finished`/`inFlight` back the loop-drained guard installed just below: `finished` marks the ONE point
  // (this wrapper) every terminal exit passes through, and `inFlight` is updated at the two places this
  // file actually starts work on a specific application (the --application path, and applyOneCandidate's
  // onApplicationStarted callback in the multi-candidate loop below).
  let finished = false;
  const finish = async (/** @type {number} */ code) => { finished = true; await rawFinish(code); };
  /** @type {{ applicationId: number, phase: string } | null} */
  let inFlight = null;
  const uninstallLoopDrainedGuard = installLoopDrainedGuard(process, {
    isFinished: () => finished, getInFlight: () => inFlight, log, summary, summaryFile, withClientFn: withClient,
  });

  // runLifecycle (spec-adversary finding on the original PR, fixed here; residual gap fixed here too):
  // EVERY exit path from this point on -- the apply exclusion gate config load, normal completion, the
  // still-running-at-deadline early return, a failed lock acquisition (AutoApplyLockedError), and any other
  // uncaught exception from wait/prepare/select/apply -- routes through `finish()` with an explicit
  // `summary.outcome` (ok / scan_still_running / locked / error), so latest.json and the dated run JSON are
  // NEVER left describing a mid-run phase for a process that has already exited. Nothing after this point
  // calls process.exit directly except inside `finish` itself.
  //
  // Residual gap (spec-adversary finding on the follow-up PR): the exclusion-config load used to run BEFORE
  // this call, in its own try/catch that only handled CONFIG_INVALID and bare-rethrew everything else --
  // that bare rethrow escaped runLifecycle entirely and fell all the way to main().catch() at the bottom of
  // this file, which never calls `finish()`, leaving latest.json stuck at a non-'done' phase and skipping
  // the dated run JSON. Moving the load inside `body` (below) means ANY throw from it -- CONFIG_INVALID
  // included -- is now inside runLifecycle's own try, so a non-CONFIG_INVALID failure is caught by
  // runLifecycle's generic catch (outcome 'error', same exit code 1 as before) exactly like every other
  // uncaught error in this body, and CONFIG_INVALID keeps its own distinct `no_apply` outcome and message,
  // just now reached via the SAME `body`/`finish` plumbing instead of a separate exit path above it.
  await runLifecycle(async () => {
    // Apply exclusion gate config (spec section 2, amendment A4): loaded ONCE here, before the wait loop
    // even starts, and reused by BOTH the prepare-phase pre-filter and select -- a missing/invalid
    // config/apply-exclusions.json is a hard error that stops the whole run before prepare OR select ever
    // touch a listing, mirroring [NO SCAN]/[LOCK MISMATCH]'s existing loud-failure shape. CONFIG_INVALID
    // still exits through its own dedicated `finish(1)` and `no_apply` outcome rather than falling through
    // to runLifecycle's own generic 'error' catch below: it is a distinct, well-understood outcome that
    // predates this fix and is deliberately never conflated with the generic 'error' outcome runLifecycle
    // assigns to everything else it did not already handle itself.
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

    // --application <id> re-drive (submit-on-resume spec section 4): entirely bypasses wait/prepare/
    // select -- this run is about ONE specific, already-existing application, never today's candidate
    // pool. Always exits 0 (even a gate refusal, per amendment A1): a refusal here is a normal, expected
    // outcome the operator reads from the summary, not a process failure.
    if (args.applicationId !== undefined) {
      summary.phase = 'applying';
      persist();
      const runnerDeps = { env, logDir: env.JOBSEARCH_LOG_DIR, repoRoot: repoRoot(), withClient, spawn };
      const resumeRunner = createResumeRunner(runnerDeps);
      const reviewRunner = createReviewRunner(runnerDeps);
      const outputRoot = path.join(repoRoot(), 'output');
      // Known target application, set BEFORE the run starts (unlike the multi-candidate loop below, this
      // id is known up front -- there is no createApplication step to wait on first).
      inFlight = { applicationId: args.applicationId, phase: summary.phase };
      const single = await runSingleApplication(args.applicationId, {
        withClientFn: withClient, resumeRunner, reviewRunner, runWorker: runApplyWorker, outputRoot, env, log,
        config, now, exclusionConfig,
      });
      inFlight = null;
      log({ evt: 'auto_apply_single_done', ...single });
      // Chrome-launch warnings (single-path-chrome fix): runSingleApplication returns its own
      // ensureScanChrome() result on `single.warnings` rather than pushing onto the shared array itself
      // (it has no reference to it) -- merged here into the SAME top-level `warnings` array the
      // multi-candidate path uses, so the report's existing CHROME_LAUNCH_FAILED rendering covers both
      // paths identically.
      if (Array.isArray(single.warnings)) warnings.push(...single.warnings);
      summary.ok = true;
      summary.outcome = 'ok';
      summary.single = single;
      await finish(0);
      return;
    }

    const softDeadline = localDeadline(now, timezone, config.autoApply.waitDeadlineLocal);
    const hardDeadline = localDeadline(now, timezone, config.autoApply.waitHardDeadlineLocal);

    let scanState = { state: 'finished_today', detail: { runId: null, status: null } };
    if (config.autoApply.waitForScan) {
      const waitClient = await connectDedicated();
      try {
        scanState = await waitForScan(waitClient, {
          timezone, softDeadline, hardDeadline, pollSeconds: config.autoApply.waitPollSeconds,
          staleHeartbeatMinutes: config.autoApply.waitStaleHeartbeatMinutes,
          // scan-hang-timeouts fix (spec item C): a runaway scan run's heartbeat can keep ticking even
          // while it is wedged, so this wait loop also classifies a 'running' row whose started_at is
          // past the scan's own wall-clock cap + 30 minutes as 'abandoned' (distinct from merely-stale
          // 'stalled') -- waitForScan() resolves that state immediately, with no deadline wait at all, so
          // this run is never waited on into the hard deadline. The branch below that reacts to
          // scanState.state === 'abandoned' is what actually stops auto-apply from waiting further and
          // proceeds with a warning (independent review Finding 3: this option alone only changed state
          // labeling/logging without that branch).
          runCapMinutes: config.adapters.run.runTimeoutMinutes,
          log,
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
    // scan-hang-timeouts fix (spec item C, independent review Finding 3): a run whose started_at is past
    // its own wall-clock cap plus 30 minutes will never finish, so it is treated as NOT in progress --
    // auto-apply stops waiting on it and proceeds through the same Chrome-launch/prepare/apply path as
    // failed/never_started/unknown below, rather than the read-only select-only path above (which is
    // reserved for a run that might still legitimately hold Chrome/the lock).
    else if (scanState.state === 'abandoned') warnings.push({ code: 'SCAN_ABANDONED', severity: 'warning', detail: scanState.detail });

    if (scanState.state !== 'finished_today') {
      warnings.push(...await ensureScanChrome(env, log));
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
          // createApplication runs inside applyOneCandidate, so the id isn't known until it reports back
          // here -- unlike the --application path above, which already has it before the run starts.
          onApplicationStarted: (id) => { inFlight = { applicationId: id, phase: summary.phase }; },
        });
        inFlight = null;
        applyResults.push(r);
        log({ evt: 'auto_apply_candidate_done', ...r });
      }
    }

    summary.ok = true;
    summary.outcome = 'ok';
    summary.applied = applyResults;
    await finish(0);
  }, { summary, finish, log });
  // Production never reaches this line -- finish()'s own process.exit() already terminated the process on
  // every path above. It exists so tests (which stub exitFn) leave no dangling listener on the real
  // `process` object between test cases.
  uninstallLoopDrainedGuard();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
