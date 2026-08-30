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
  //
  // Explicit glob when no file/pattern was given on the command line (bug found authoring slice 3
  // auto-triage): with no positional argument, `node --test`'s own DEFAULT recursive discovery treats
  // EVERY .js/.cjs/.mjs file anywhere under a directory literally named `test` as a test file, not only
  // ones matching `*.test.js` -- including non-test executable fixtures like
  // `test/fixtures/triage/fake-claude.mjs` (a fake `claude` CLI spawned by src/core/triage.js's
  // runModelTriage in a real child process for test/scan-cli-triage.test.js). Node isolates each
  // discovered file into its own subprocess (`node --test-concurrency=1 <file>`), which makes that file
  // process.argv[1] in that subprocess exactly as if it had been run directly -- an `isMain`
  // (`process.argv[1] === fileURLToPath(import.meta.url)`) guard inside the fixture file itself, the
  // usual defense against accidental direct execution elsewhere in this codebase (bin/scan.js,
  // bin/migrate.js), does NOT distinguish that isolated-subprocess case from a real direct invocation, so
  // it cannot fix this on its own. Any test file added directly under `test/` still matches this glob
  // (its own name still ends in `.test.js`); only non-test files under `test/fixtures/`, `test/helpers/`,
  // etc. are excluded, which is exactly the set that should never have been "test files" in the first
  // place. A caller passing an explicit file/pattern via `npm test -- <path>` is unaffected.
  const files = extraArgs.length ? extraArgs : ['test/*.test.js'];
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    // JOBSEARCH_TEST_GUARD=1 backs up src/core/config.js's assertTestDbGuard() in case a future Node
    // version stops setting NODE_TEST_CONTEXT under `node --test` -- the guard trips on any of the
    // three signals, this is just an explicit, first-party one this file controls directly.
    env: { ...process.env, PG_DSN: testDsn, JOBSEARCH_TEST_GUARD: '1' },
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
