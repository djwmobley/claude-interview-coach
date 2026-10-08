#!/usr/bin/env node
// @ts-check
/**
 * Restart the local dashboard server (same logic as the restart_dashboard MCP tool).
 *
 *   node bin/restart-dashboard.js [--if-stale] [--help]
 *
 * Prints one JSON line. Exit 0 = restarted or deliberately skipped (--if-stale and not stale);
 * exit 1 = refused or failed (AMBIGUOUS, FOREIGN_LISTENER, KILL_FAILED, TASK_START_FAILED, HEALTH_TIMEOUT).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv, repoRoot } from '../src/core/config.js';
import { restartDashboardReal } from '../src/core/dashboard-restart.js';

const USAGE = 'usage: node bin/restart-dashboard.js [--if-stale] [--help]';

/** @param {string[]} argv */
export function parseArgs(argv) {
  return { ifStale: argv.includes('--if-stale'), help: argv.includes('--help') || argv.includes('-h') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const result = await restartDashboardReal({ ifStale: args.ifStale }, { env: getEnv(), repoRoot: repoRoot() });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
