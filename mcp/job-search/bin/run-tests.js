#!/usr/bin/env node
// @ts-check
/**
 * `npm test` entry point (independent review fix, PR #1 on scan-tuning). Bootstraps (creates/refreshes)
 * a throwaway "_test" database from the real, configured one via bin/bootstrap-test-db.js, then spawns
 * `node --test` with PG_DSN pointed at that database -- set via child_process's `env` option, never a
 * shell-exported variable, so this works identically on Windows and POSIX. Every test file, including
 * test/migrate.test.js and test/remind.test.js, therefore connects to the isolated test database; none
 * of them can reach the real production ic_context database through this entry point.
 *
 * bin/bootstrap-test-db.js's own hard safety gate (refuses any database whose name does not end in
 * "_test") still applies underneath this; this file adds nothing on top of that gate, it only wires
 * the resulting DSN into the child process's environment.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapTestDb } from './bootstrap-test-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

async function main() {
  const { testDsn, testDbName } = await bootstrapTestDb({ log: (m) => process.stdout.write(m + '\n') });
  process.stdout.write(`bin/run-tests.js: running the suite against "${testDbName}"\n`);
  const extraArgs = process.argv.slice(2);
  // --test-concurrency=1: ic_report_state (spec R1) is a real singleton row shared by every test
  // FILE against this one isolated database; node --test running files in parallel would otherwise let
  // two files' marker-writing tests race each other even though production is now fully out of the
  // picture. Serializing file execution trades some wall-clock time for a suite that cannot flake on
  // that shared state.
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...extraArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PG_DSN: testDsn },
  });
  child.on('error', (err) => {
    process.stderr.write(`bin/run-tests.js: failed to start node --test: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((err) => {
  process.stderr.write(`bin/run-tests.js FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
