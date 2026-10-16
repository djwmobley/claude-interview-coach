#!/usr/bin/env node
// @ts-check
/**
 * Target finder CLI (plan 17.1). A thin wrapper over runTargets() in src/targets/runner.js, the same code
 * path the daily scan stage uses.
 *
 *   node bin/targets.js [--source gap|form_d|8k|fts|alerts] [--dry-run]
 *
 * Without --source every enabled source runs, in this order: Form D, 8-K, FTS, alerts, gap. A dry run
 * fetches and classifies but writes nothing (no run row, no lock, no cursor) and prints counts. A normal run
 * keeps a heartbeat on its run row, so a long manual run is never reaped as stale.
 *
 * Nothing is ever sent: there is no send, POST or mail path in target code. The SEC contact comes from the
 * gitignored config/target-sec-contact.json; without it the SEC sources skip with sec_contact_missing and
 * make zero requests.
 *
 * Exit 0 ok or skipped (already running), 2 partial, 1 failed or bad arguments.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../src/core/config.js';
import { connectDedicated } from '../src/core/db.js';
import { createLogger, dailyLogPath } from '../src/core/logger.js';
import { runTargets, SOURCE_NAMES } from '../src/targets/runner.js';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { source: /** @type {string|null} */ (null), dryRun: false, help: false, error: /** @type {string|null} */ (null) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') {
      const v = argv[i + 1];
      i += 1;
      if (!v || !SOURCE_NAMES.includes(v)) out.error = `--source must be one of ${SOURCE_NAMES.join(', ')}`;
      else out.source = v;
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.error = `unknown argument ${String(a).slice(0, 40)}`;
  }
  return out;
}

const USAGE = 'usage: node bin/targets.js [--source gap|form_d|8k|fts|alerts] [--dry-run]';

/** @param {{ status?: string }} r @returns {number} */
export function exitCodeFor(r) {
  if (r.status === 'ok' || r.status === 'skipped') return 0;
  if (r.status === 'partial') return 2;
  return 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.error) {
    console.log(JSON.stringify({ ok: false, code: 'VALIDATION', message: args.error, usage: USAGE }));
    process.exit(1);
  }
  const env = getEnv();
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'targets'), name: 'targets' });
  /** @param {Record<string, unknown>} f */
  const log = (f) => logger.info(f);
  /** @type {import('pg').Client|null} */
  let client = null;
  let code = 1;
  try {
    client = await connectDedicated();
    const r = await runTargets(
      { client, configDir: env.JOBSEARCH_CONFIG_DIR, fetch: globalThis.fetch, tokenFile: env.GOOGLE_TOKEN_FILE || null, log },
      { source: args.source, dryRun: args.dryRun, trigger: 'cli' },
    );
    code = exitCodeFor(r);
    console.log(JSON.stringify({ ok: r.status !== 'failed', ...r }));
  } catch (err) {
    log({ evt: 'targets_cli_failed', err: err instanceof Error ? err.message.slice(0, 200) : 'error' });
    console.log(JSON.stringify({ ok: false, code: 'INTERNAL', message: 'targets run failed (see the targets log)' }));
    code = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
  process.exit(code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
