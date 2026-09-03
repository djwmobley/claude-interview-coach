// @ts-check
/**
 * bin/review-bulk.js: the CLI is a thin argument-parsing wrapper over bulkResolve() (already fully
 * exercised against the real DB in test/review-bulk-resolve.test.js), so this file only checks the CLI's
 * own surface -- argument parsing, exit codes, and that a real run against the test DB works end to end.
 * Spawned as a real child process with `env: process.env` so it inherits the PG_DSN / JOBSEARCH_TEST_GUARD
 * bin/run-tests.js set on THIS test file's own process, keeping it pointed at the isolated "_test" DB.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'review-bulk.js');
const SRC = `zz-test-reviewbulkcli-${process.pid}`;
const CO = `ZZ-TEST-REVIEWBULKCLI-${process.pid}`;

/** @type {pg.Client} */
let client;

/** @param {Partial<{ status: string|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const url = `https://example.test/${SRC}/${n}`;
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, status, url, url_normalized, source, external_id, record_kind, location, posted_at, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('CLI Test',$1,$2,$3,$3,$4,$5,'listing','Houston, TX',current_date,'zz reviewbulkcli co','cli test','houston-tx',md5($3),now()) RETURNING id`,
    [CO, o.status ?? null, url, SRC, `${SRC}:${n}`],
  );
  return Number(r.rows[0].id);
}

/** @param {{ candidateId: number, reason: string }} o */
async function insertQueueItem(o) {
  const r = await client.query(
    `INSERT INTO ic_job_review_queue (candidate_id, matches, reason, status_at_create) VALUES ($1, '{}', $2, 'review') RETURNING id`,
    [o.candidateId, o.reason],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE source = $1', [SRC])).rows.map((r) => r.id);
  if (ids.length) {
    await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
});

after(async () => {
  await cleanup();
  await client.end();
});

/** @param {string[]} args */
function run(args) {
  return execFileAsync(process.execPath, [CLI, ...args], { cwd: PACKAGE_ROOT, env: process.env });
}

describe('bin/review-bulk.js: argument parsing and exit codes', () => {
  test('--help prints usage and exits 0', async () => {
    const { stdout } = await run(['--help']);
    assert.match(stdout, /usage: node bin\/review-bulk\.js/);
  });

  test('missing --mode exits 1 with a clear message', async () => {
    await assert.rejects(run([]), (/** @type {any} */ err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--mode/);
      return true;
    });
  });

  test('an unrecognized argument exits 1', async () => {
    await assert.rejects(run(['--mode', 'stale', '--bogus']), (/** @type {any} */ err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /unrecognized argument/);
      return true;
    });
  });

  test('--no-dry-run without --confirm is refused (bulkResolve\'s own server-side confirm check)', async () => {
    await assert.rejects(run(['--mode', 'stale', '--no-dry-run']), (/** @type {any} */ err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /confirm must be true/);
      return true;
    });
  });

  test('an unknown --reason is refused before touching the DB', async () => {
    await assert.rejects(run(['--mode', 'reason', '--reason', 'not_a_real_reason']), (/** @type {any} */ err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /reason must be one of/);
      return true;
    });
  });
});

describe('bin/review-bulk.js: a real run against the test DB', () => {
  test('dry-run preview, then a live --no-dry-run --confirm run, separates the matching item', async () => {
    const cand = await insertListing({ status: 'review' });
    await insertQueueItem({ candidateId: cand, reason: 'branch1_conflict' });

    const preview = await run(['--mode', 'reason', '--reason', 'branch1_conflict', '--dry-run']);
    assert.match(preview.stdout, /dry_run: true/);
    assert.match(preview.stdout, /separate: 1/);
    const stillOpen = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [cand]);
    assert.equal(stillOpen.rows[0].status, 'review', 'dry run wrote nothing');

    const live = await run(['--mode', 'reason', '--reason', 'branch1_conflict', '--no-dry-run', '--confirm']);
    assert.match(live.stdout, /dry_run: false/);
    assert.match(live.stdout, /separate: 1/);
    const resolved = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [cand]);
    assert.equal(resolved.rows[0].status, null, 'separated candidate returns to untriaged');
  });
});
