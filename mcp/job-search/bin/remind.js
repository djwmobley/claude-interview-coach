#!/usr/bin/env node
// @ts-check
/**
 * Daily follow-up digest CLI (spec section 6).
 *
 *   node bin/remind.js [--dry-run] [--to addr]
 *
 * Exit 0 ok (zero due rows means no email), 1 auth or send failure.
 * Logs JSONL to logs/remind-YYYY-MM-DD.log (14-day retention) and prints a
 * one-line JSON summary to stdout. Token values are never logged.
 */
import { getEnv } from '../src/core/config.js';
import { connectDedicated } from '../src/core/db.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { runRemind } from '../src/core/remind.js';
import { errFields } from '../src/core/errors.js';

function parseArgs(argv) {
  const out = { dryRun: false, to: /** @type {string|null} */ (null) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--to') out.to = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bin/remind.js [--dry-run] [--to addr]');
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
  } catch (err) {
    const f = errFields(err);
    logger.error({ evt: 'remind_failed', ...f });
    console.log(JSON.stringify({ ok: false, ...f }));
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

main();
