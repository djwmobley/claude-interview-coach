#!/usr/bin/env node
// @ts-check
/**
 * Mail confirmation job CLI (apply pipeline slice 7, plan `let-s-brainstorm-a-bit-humble-umbrella.md`
 * section "6. Confirmation tracking"). Watches the owner's Gmail inbox for application-related mail,
 * flips a `submitted` application to `confirmed` on a matched confirmation, and routes a matched
 * rejection/position-closed mail to the review queue. See src/apply/mail-confirm.js for the full
 * classification and matching contract.
 *
 *   node bin/confirm.js [--dry-run]
 *
 * Exit 0 on a normal run (including zero candidates or zero new mail), 1 on a Google-auth or fatal
 * failure. Logs JSONL to logs/confirm-YYYY-MM-DD.log (14-day retention, same convention as remind.js)
 * and prints a one-line JSON summary to stdout. Token values are never logged.
 *
 * WHERE THIS RUNS (this PR's own design choice, not dictated by the plan text, which left it open):
 * a SEPARATE bin/ entry, not a step folded into bin/remind.js. Reasoning: this job's failure mode is
 * completely different from remind.js's (a broken Gmail query here silently under-classifies mail, it
 * does not need to email anyone or open the dashboard the way remind.js's own auth-health hardening
 * does), it has its own idempotency ledger and its own concept of "done" independent of the daily digest,
 * and every other apply-pipeline job in this codebase (gmail-verify.js's Workday verification poll) is
 * already its own self-contained module rather than threaded through remind.js. Operationally it is
 * intended to run daily, BEFORE remind.js, so a nudge follow-up a confirmation just completed never
 * shows up as "due" in the same day's digest -- see README.md's Task Scheduler section for the exact
 * registration snippet (registered by the operator, same as the existing scan/remind tasks; this PR does
 * not touch a live Task Scheduler).
 *
 * --dry-run: runs the SAME classification and matching logic but rolls back every database write at the
 * end (BEGIN before, ROLLBACK after) instead of committing, so a scheduled run can be rehearsed without
 * risk. The Gmail read itself still happens for real (read-only endpoints only, same as every other Gmail
 * caller in this codebase); nothing is ever written back to Gmail.
 *
 * The outer BEGIN/ROLLBACK above is passed through to runMailConfirm() as `dryRun: args.dryRun` (post-
 * review fix), not left implicit: runMailConfirm()'s own per-message DB boundaries use a real transaction
 * (BEGIN/COMMIT) when NOT told they are already inside one, and a SAVEPOINT when they are -- a per-message
 * real transaction issued while already inside the outer BEGIN above would COMMIT that outer transaction
 * early (Postgres treats a nested BEGIN as a no-op, but NOT the matching COMMIT), leaving this file's own
 * final ROLLBACK with nothing left to undo. Never call runMailConfirm() with `dryRun: true` unless the
 * outer BEGIN above has actually been issued on the same `client` first -- see mail-confirm.js's own
 * module doc comment (DRY-RUN CORRECTNESS) for the full contract.
 */
import { getEnv } from '../src/core/config.js';
import { connectDedicated } from '../src/core/db.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { runMailConfirm } from '../src/apply/mail-confirm.js';
import { errFields } from '../src/core/errors.js';

function parseArgs(argv) {
  const out = { dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bin/confirm.js [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'confirm', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'confirm'), name: 'confirm' });
  let client;
  try {
    client = await connectDedicated();
  } catch (err) {
    const f = errFields(err);
    logger.error({ evt: 'confirm_db_failed', ...f });
    console.log(JSON.stringify({ ok: false, ...f }));
    process.exit(1);
  }
  let code = 1;
  try {
    if (args.dryRun) await client.query('BEGIN');
    const r = await runMailConfirm({
      client,
      tokenFile: env.GOOGLE_TOKEN_FILE,
      log: (fields) => logger.info(fields),
      logError: (fields) => logger.error(fields),
      dryRun: args.dryRun,
    });
    if (args.dryRun) await client.query('ROLLBACK');
    code = r.code;
    console.log(JSON.stringify({ ok: r.ok, dry_run: args.dryRun, ...r }));
  } catch (err) {
    if (args.dryRun) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
    }
    const f = errFields(err);
    logger.error({ evt: 'confirm_failed', ...f });
    console.log(JSON.stringify({ ok: false, ...f }));
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

main();
