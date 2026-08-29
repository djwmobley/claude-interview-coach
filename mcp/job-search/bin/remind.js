#!/usr/bin/env node
// @ts-check
/**
 * Daily follow-up digest CLI (spec section 6).
 *
 *   node bin/remind.js [--dry-run] [--to addr] [--open-dashboard]
 *
 * Exit 0 ok (zero due rows means no email), 1 auth or send failure.
 * Logs JSONL to logs/remind-YYYY-MM-DD.log (14-day retention) and prints a
 * one-line JSON summary to stdout. Token values are never logged.
 *
 * --open-dashboard: after runRemind finishes (email sent, skipped for zero due rows, or failed -- this
 * always runs, and never changes the exit code below), open or refresh the job-search dashboard
 * (bin/dashboard.js, http://127.0.0.1:${DASHBOARD_PORT || 7311}/) in the operator's browser. The email
 * this CLI sends regularly gets lost in spam, so the dashboard showing up on screen is the fallback
 * delivery. Tries the operator's daily-driver Chrome via CDP first (env DAILY_CDP_URL, default
 * http://127.0.0.1:9222 -- distinct from SCAN_CDP_URL, the separate dedicated scan browser profile on
 * port 9333, which this must never touch): reload an already-open dashboard tab, or open a new one in
 * that same Chrome. Falls back to the OS default browser when that CDP endpoint is unreachable or any
 * step fails. See src/core/open-dashboard.js for the full mode/fallback contract.
 */
import { spawn } from 'node:child_process';
import { getEnv } from '../src/core/config.js';
import { connectDedicated } from '../src/core/db.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { runRemind } from '../src/core/remind.js';
import { errFields } from '../src/core/errors.js';
import { openDashboard } from '../src/core/open-dashboard.js';
import { resolvePort } from './dashboard.js';

function parseArgs(argv) {
  const out = { dryRun: false, to: /** @type {string|null} */ (null), openDashboard: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--to') out.to = argv[++i] ?? null;
    else if (a === '--open-dashboard') out.openDashboard = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bin/remind.js [--dry-run] [--to addr] [--open-dashboard]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'remind', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'remind'), name: 'remind' });
  let client;
  try {
    client = await connectDedicated();
  } catch (err) {
    const f = errFields(err);
    logger.error({ evt: 'remind_db_failed', ...f });
    console.log(JSON.stringify({ ok: false, ...f }));
    process.exit(1);
  }
  let code = 1;
  try {
    const r = await runRemind({
      client,
      tokenFile: env.GOOGLE_TOKEN_FILE,
      to: args.to ?? env.REMINDER_TO,
      dryRun: args.dryRun,
      log: (fields) => logger.info(fields),
    });
    code = r.code;
    console.log(JSON.stringify({ ok: r.code === 0, ...r }));
    if (args.dryRun && r.body) {
      // The scan-report + follow-ups plain-text body a real send would carry, so the operator can see
      // exactly what tomorrow's email looks like without sending it.
      console.log('----- report body (plain text) -----');
      console.log(r.body);
      console.log('----- end report body -----');
    }
  } catch (err) {
    const f = errFields(err);
    logger.error({ evt: 'remind_failed', ...f });
    console.log(JSON.stringify({ ok: false, ...f }));
    code = 1;
  } finally {
    if (args.openDashboard) {
      // Runs regardless of the outcome above (sent, skipped for zero due rows, or failed) and never
      // touches `code` -- openDashboard() itself is designed to never throw, but this is wrapped anyway
      // so a defect in that contract can never take the exit code down with it or skip client.end().
      const { port, warning } = resolvePort(undefined, env.DASHBOARD_PORT, (fields) => logger.info(fields));
      if (warning) logger.info({ evt: 'open_dashboard_port_warning', message: warning });
      try {
        await openDashboard({
          dashboardUrl: `http://127.0.0.1:${port}/`,
          cdpUrl: env.DAILY_CDP_URL,
          spawnImpl: spawn,
          log: (fields) => logger.info(fields),
        });
      } catch (err) {
        logger.error({ evt: 'open_dashboard_failed', ...errFields(err) });
      }
    }
    await client.end();
  }
  process.exit(code);
}

main();
