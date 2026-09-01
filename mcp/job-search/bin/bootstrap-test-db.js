#!/usr/bin/env node
// @ts-check
/**
 * Test database bootstrap (independent review fix, PR #1 on scan-tuning): creates or refreshes a
 * throwaway "<name>_test" database by `pg_dump --schema-only` of the configured real database, then
 * re-applies this server's own SQL migrations (sql/001-008) against the copy. The migrations are
 * idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS everywhere), so re-running them
 * against a schema that already has them is a no-op that also exercises them end to end, which a bare
 * pg_dump copy alone would not.
 *
 * ic_job_listings and the other pre-existing "ic_context" base tables are NOT created by this
 * server's own SQL (sql/001 only ALTERs ic_job_listings; it never CREATEs it) -- they come from an
 * external schema this repo does not own. That is why pg_dump --schema-only of the real database is
 * the primary mechanism here, with the migrations re-applied on top as a secondary check, not the
 * other way around.
 *
 * HARD SAFETY GATE, no override flag: refuses to DROP, CREATE, dump into, or otherwise touch any
 * database whose name does not end in "_test". This exists because a bug in an earlier version of
 * this exact PR (before this file existed) wrote duplicate rows into the real, shared production
 * ic_context database via a plain `npm test` run; see the PR discussion for the incident.
 *
 *   node bin/bootstrap-test-db.js                  bootstrap using the configured PG_DSN (or the local default)
 *   PG_TEST_DSN=postgresql://... node bin/bootstrap-test-db.js   bootstrap an explicit target instead (e.g. CI)
 *
 * bin/run-tests.js is the normal entry point (`npm test`): it calls bootstrapTestDb() then runs the suite
 * with PG_DSN pointed at the freshly bootstrapped database. This file is also runnable directly for a
 * manual refresh.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getEnv, pgConnectionConfig } from '../src/core/config.js';
import { seedExecDefault } from '../src/core/profile-seed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');
export const MIGRATIONS = Object.freeze([
  '001_extend_ic_job_listings.sql', '002_search_profiles.sql', '003_scan_runs.sql', '004_review_queue.sql',
  '005_budget.sql', '006_followups.sql', '007_mark_meta.sql', '008_noise_and_report.sql',
  '009_pipeline_events_documents.sql', '010_status_event_backfill.sql', '011_triage_actor.sql', '012_applications.sql',
]);

/** Only a plain lowercase identifier is ever used in a DDL string (DROP/CREATE DATABASE cannot be parameterized). */
const SAFE_DB_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/** @param {string} dsn */
function dbNameFromDsn(dsn) {
  const u = new URL(dsn);
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

/**
 * @param {string} dsn
 * @param {string} newDbName
 */
function withDbName(dsn, newDbName) {
  const u = new URL(dsn);
  u.pathname = '/' + newDbName;
  return u.toString();
}

/** The configured real/source database as one connection string (never the test database itself). */
export function sourceDsn() {
  const env = getEnv();
  if (env.PG_DSN) return env.PG_DSN;
  const cfg = pgConnectionConfig(null);
  if ('connectionString' in cfg) return /** @type {{connectionString: string}} */ (cfg).connectionString;
  const c = /** @type {{host: string, port: number, database: string, user: string}} */ (cfg);
  return `postgresql://${c.user}@${c.host}:${c.port}/${c.database}`;
}

/**
 * Resolve the test database's name and connection strings. Total classification: every input either
 * resolves to a name ending in "_test", or this throws -- there is no third, silent-fallback path.
 * @returns {{ sourceDsn: string, sourceDbName: string, testDbName: string, testDsn: string, maintenanceDsn: string }}
 */
export function resolveTestDb() {
  const source = sourceDsn();
  const sourceDbName = dbNameFromDsn(source);
  const explicitTestDsn = process.env.PG_TEST_DSN || null;
  const testDbName = explicitTestDsn ? dbNameFromDsn(explicitTestDsn) : (sourceDbName.endsWith('_test') ? sourceDbName : `${sourceDbName}_test`);
  if (!testDbName.endsWith('_test')) {
    throw new Error(`refusing to bootstrap a test database named "${testDbName}": it does not end in "_test" (set PG_TEST_DSN to an explicit *_test database, or leave it unset to derive one from PG_DSN)`);
  }
  if (!SAFE_DB_NAME_RE.test(testDbName)) {
    throw new Error(`refusing to bootstrap a test database named "${testDbName}": not a safe lowercase identifier`);
  }
  if (testDbName === sourceDbName) {
    throw new Error(`PG_DSN already points at "${sourceDbName}", which itself ends in "_test"; point PG_DSN at the real database (or set PG_TEST_DSN to a name different from PG_DSN's) so the bootstrap has a schema to copy the test database FROM`);
  }
  const testDsn = explicitTestDsn ?? withDbName(source, testDbName);
  const maintenanceDsn = withDbName(testDsn, 'postgres');
  return { sourceDsn: source, sourceDbName, testDbName, testDsn, maintenanceDsn };
}

/**
 * Create (or drop-and-recreate) the test database, empty, connecting to the `postgres` maintenance
 * database on the same server.
 * @param {{ testDbName: string, maintenanceDsn: string }} target
 */
async function recreateDatabase(target) {
  const admin = new pg.Client({ connectionString: target.maintenanceDsn });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [target.testDbName],
    );
    // testDbName is validated by SAFE_DB_NAME_RE in resolveTestDb() before it ever reaches string
    // interpolation here; DROP/CREATE DATABASE cannot take a parameterized identifier.
    await admin.query(`DROP DATABASE IF EXISTS "${target.testDbName}"`);
    await admin.query(`CREATE DATABASE "${target.testDbName}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Copy the real database's schema (spec: `pg_dump --schema-only`) into the freshly created test
 * database via `psql`. Buffered in memory (schema-only dumps are small; no data rows are ever dumped).
 * @param {{ sourceDsn: string, testDsn: string }} target
 */
function copySchema(target) {
  const dump = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', target.sourceDsn], { maxBuffer: 1024 * 1024 * 128 });
  execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', target.testDsn], { input: dump, stdio: ['pipe', 'ignore', 'inherit'] });
  return dump.length;
}

/**
 * Re-apply this server's own migrations against the test database (idempotent; also proves the
 * migrations themselves are sound, per the review's stated preference).
 * @param {{ testDsn: string }} target
 */
async function reapplyMigrations(target) {
  const client = new pg.Client({ connectionString: target.testDsn });
  await client.connect();
  try {
    for (const f of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
      await client.query(sql);
    }
    try {
      const uniqueSql = fs.readFileSync(path.join(SQL_DIR, 'unique_indexes.sql'), 'utf8');
      await client.query(uniqueSql);
    } catch {
      // The copied schema may already carry these from the source database (pg_dump captured them);
      // not fatal for a test database either way.
    }
  } finally {
    await client.end();
  }
}

/**
 * Seed the exec-default search profile the same way a fresh server startup or `bin/migrate.js` apply
 * would, but from a deliberately NONEXISTENT profile.md path so the test database's seed is always the
 * deterministic FALLBACK_PROFILE (spec: profile-seed.js), never whatever personal data/profile.md
 * happens to exist on the machine running the tests.
 * @param {{ testDsn: string }} target
 */
async function seedProfile(target) {
  const client = new pg.Client({ connectionString: target.testDsn });
  await client.connect();
  try {
    await seedExecDefault(client, path.join(HERE, '__no-such-profile-md-forces-fallback__'));
  } finally {
    await client.end();
  }
}

/**
 * Full bootstrap: resolve -> recreate -> copy schema -> re-apply migrations -> seed exec-default.
 * Returns the resolved test DSN for the caller (bin/run-tests.js) to hand to the actual test run.
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function bootstrapTestDb(opts = {}) {
  const log = opts.log ?? (() => {});
  const target = resolveTestDb();
  log(`test-db-setup: source="${target.sourceDbName}" target="${target.testDbName}"`);
  await recreateDatabase(target);
  log(`test-db-setup: recreated database "${target.testDbName}"`);
  const bytes = copySchema(target);
  log(`test-db-setup: schema copied (${bytes} bytes)`);
  await reapplyMigrations(target);
  log('test-db-setup: migrations re-applied (idempotent check)');
  await seedProfile(target);
  log('test-db-setup: exec-default profile seeded (fallback profile, never personal data)');
  return { testDsn: target.testDsn, testDbName: target.testDbName };
}

async function main() {
  try {
    const { testDsn, testDbName } = await bootstrapTestDb({ log: (m) => process.stdout.write(m + '\n') });
    process.stdout.write(`test-db-setup: ready. PG_DSN=${testDsn}\n`);
    void testDbName;
  } catch (err) {
    process.stderr.write(`test-db-setup FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
