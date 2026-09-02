#!/usr/bin/env node
// @ts-check
/**
 * Dashboard self-healing watchdog CLI (self-healing watchdog + logging feature). The "job-search
 * dashboard" scheduled task (scripts/register-dashboard-task.ps1) runs this every 5 minutes and at
 * logon, instead of running bin/dashboard.js directly: this probes the dashboard's health, and
 * (re)starts it with full stdout/stderr log capture when it is not healthy. See
 * src/dashboard/watchdog.js for the total-classification probe/restart/kill-guard logic this wraps.
 *
 *   node bin/watchdog.js [--help]
 *
 * Exit codes: 0 = healthy, successfully restarted, or a start was already in progress (fresh lock).
 *             1 = failed to restore health, a kill-guard mismatch (stuck_foreign_process), or an
 *                 unexpected error. Task Scheduler's RestartOnFailure (3x / 1 minute) retries an exit-1
 *                 run; the 5-minute cadence bounds any storm this could otherwise cause.
 *
 * Logs JSONL to logs/watchdog-YYYY-MM-DD.log (14-day retention, same convention as every other bin/
 * CLI in this package) and prints a one-line JSON summary to stdout. The dashboard's own stdout+stderr
 * (previously unread by scripts/register-dashboard-task.ps1's hidden PowerShell wrapper) are now
 * captured into the SAME dated dashboard-YYYY-MM-DD.log file bin/dashboard.js's own pino logger already
 * writes JSONL to -- two independent file descriptors appending to one file is safe (each write is a
 * single small buffered append), so nothing here changes bin/dashboard.js itself.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../src/core/config.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { errFields } from '../src/core/errors.js';
import { resolvePort, SERVICE_NAME } from './dashboard.js';
import { runWatchdog } from '../src/dashboard/watchdog.js';
import { defaultWatchdogStateFile } from '../src/core/watchdog-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

const USAGE = 'usage: node bin/watchdog.js [--help]';

function parseArgs(argv) {
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
  }
  return {};
}

/** @param {string} logDir */
export function watchdogLockFile(logDir) {
  return path.join(logDir, 'watchdog-start.lock');
}

async function main() {
  parseArgs(process.argv.slice(2));
  const env = getEnv();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'watchdog', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'watchdog'), name: 'watchdog' });
  /** @param {Record<string, string|number|boolean|null>} f */
  const log = (f) => logger.info(f);

  const { port, warning: portWarning } = resolvePort(undefined, env.DASHBOARD_PORT, log);
  if (portWarning) log({ evt: 'watchdog_port_warning', message: portWarning });

  const dashboardScript = path.join(PACKAGE_ROOT, 'bin', 'dashboard.js');
  const dashboardLogFile = dailyLogPath(env.JOBSEARCH_LOG_DIR, 'dashboard');
  const lockFile = watchdogLockFile(env.JOBSEARCH_LOG_DIR);
  const stateFile = defaultWatchdogStateFile(env.JOBSEARCH_LOG_DIR);

  let result;
  try {
    result = await runWatchdog({
      port,
      service: SERVICE_NAME,
      dashboardScript,
      dashboardLogFile,
      lockFile,
      stateFile,
      env: { ...process.env, ...env },
      log,
    });
  } catch (err) {
    // runWatchdog() itself is designed never to throw (its own try/catch is the (d) branch), but this
    // outer guard exists so a defect in that contract still exits 1 with a logged reason instead of an
    // unhandled rejection with no state file written and no code.
    const f = errFields(err);
    logger.error({ evt: 'watchdog_fatal', ...f });
    console.log(JSON.stringify({ ok: false, ...f }));
    process.exit(1);
    return;
  }

  console.log(JSON.stringify({ ok: result.code === 0, status: result.status, detail: result.detail }));
  process.exit(result.code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
