#!/usr/bin/env node
// @ts-check
/**
 * Ready to apply list: tailored resumes for the listed jobs (spec section 9, R6, A5, A10).
 *
 *   node bin/ready-resumes.js
 *
 * Scheduled as the SECOND step of the "job-search auto-apply" task (scripts/register-auto-apply-task.ps1
 * runs bin/auto-apply.js, then this), so it starts only after the morning auto-apply run has finished. When
 * started by hand while an auto-apply run is still live (its running marker), it waits up to
 * readyToApply.resume.autoApplyWaitMinutes, then proceeds with a warning (an unattended job warns and
 * proceeds; it never silently skips).
 *
 * Highest fit first, at most readyToApply.resume.dailyCap (hard ceiling 10) generations per America/Chicago
 * day across this CLI and the dashboard button, reusing any resume already on disk for the listing. Every
 * spawn holds the shared cross-process resume spawn lock; a second copy of this CLI exits 'locked'.
 *
 * Exit 0 for ok/locked/disabled (a normal outcome the summary explains), 1 for a crash. Prints one JSON
 * summary line and writes logs/ready-resumes-last.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getEnv, loadConfig, repoRoot } from '../src/core/config.js';
import { withClient, closePool } from '../src/core/db.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { errFields } from '../src/core/errors.js';
import { runningMarkerPath, readLiveMarker } from '../src/core/running-marker.js';
import { runReadyResumes } from '../src/core/ready-resumes.js';
import { readyConfig } from '../src/core/ready-to-apply.js';
import { createAdvisoryLock, RESUME_SPAWN_LOCK_KEY, READY_RESUME_RUN_LOCK_KEY } from '../src/core/resume-spawn-lock.js';
import { createReadyResumeRunner } from '../src/dashboard/ready-resume-runner.js';

/** @param {string} logDir */
export function readyResumesSummaryFile(logDir) {
  return path.join(logDir, 'ready-resumes-last.json');
}

/**
 * Wait while bin/auto-apply.js's running marker is live, bounded. Returns how it ended.
 * @param {{ markerFile: string, waitMs: number, pollMs?: number, now?: () => Date, sleep?: (ms: number) => Promise<void> }} o
 * @returns {Promise<'not_running'|'finished'|'wait_expired'>}
 */
export async function waitForAutoApply(o) {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  if (!readLiveMarker(o.markerFile, now())) return 'not_running';
  const deadline = now().getTime() + o.waitMs;
  while (now().getTime() < deadline) {
    await sleep(o.pollMs ?? 30000);
    if (!readLiveMarker(o.markerFile, now())) return 'finished';
  }
  return 'wait_expired';
}

async function main() {
  const env = getEnv();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'ready-resumes', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'ready-resumes'), name: 'ready-resumes' });
  const log = (/** @type {Record<string, unknown>} */ f) => logger.info(/** @type {any} */ (f));
  const summaryFile = readyResumesSummaryFile(env.JOBSEARCH_LOG_DIR);
  /** @param {Record<string, unknown>} s */
  const finish = (s) => {
    const body = { ...s, finished_at: new Date().toISOString() };
    try {
      fs.writeFileSync(summaryFile, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      log({ evt: 'ready_resumes_summary_write_failed', ...errFields(err) });
    }
    console.log(JSON.stringify(body));
  };
  try {
    const config = loadConfig();
    const rc = readyConfig(config);
    if (!rc.enabled || config.autoApply.readyToApply.resume.enabled === false) {
      finish({ ok: true, status: 'disabled' });
      return 0;
    }
    const waited = await waitForAutoApply({
      markerFile: runningMarkerPath(env.JOBSEARCH_LOG_DIR, 'auto-apply'),
      waitMs: config.autoApply.readyToApply.resume.autoApplyWaitMinutes * 60000,
    });
    if (waited === 'wait_expired') log({ evt: 'ready_resumes_auto_apply_still_running', severity: 'warning' });
    const root = repoRoot();
    const runner = createReadyResumeRunner({ env, logDir: env.JOBSEARCH_LOG_DIR, repoRoot: root, withClient, spawn, log });
    const r = await runReadyResumes({
      withClient, config, now: () => new Date(), log, runner,
      spawnLock: createAdvisoryLock({ key: RESUME_SPAWN_LOCK_KEY }),
      runLock: createAdvisoryLock({ key: READY_RESUME_RUN_LOCK_KEY }),
      outputRoot: path.join(root, 'output'),
    });
    finish({ ok: true, auto_apply_wait: waited, ...r });
    return 0;
  } catch (err) {
    const f = errFields(err);
    logger.error({ evt: 'ready_resumes_failed', ...f });
    finish({ ok: false, status: 'error', ...f });
    return 1;
  } finally {
    await closePool().catch(() => {});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code), () => process.exit(1));
}
