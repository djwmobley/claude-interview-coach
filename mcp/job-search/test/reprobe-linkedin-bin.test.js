// @ts-check
/**
 * bin/reprobe-linkedin.js (spec v1 F1.5, v2 B11): the LinkedIn re-probe backfill. Against the real isolated
 * test DB: the selection guards (runPrepare's status/duplicate/expired guards, source linkedin, apply_ats
 * null, no active application, not already apply_easy_only), --dry-run writes nothing, --limit takes the
 * highest fit first, the shared advisory lock refuses while held, and apply_easy_only is never set true.
 * Every run here is restricted to this file's own seeded ids (the test-only `onlyIds` seam) so other test
 * files' rows in the shared test DB can never be selected or reset.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { LOCK_KEY } from '../src/core/scan-run.js';
import { parseArgs, runReprobe } from '../bin/reprobe-linkedin.js';

const TAG = `ZZ-TEST-REPROBE-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const ids = [];

/**
 * @param {Partial<{ source: string, status: string|null, fit: number, attempts: number, probedAt: Date|null, applyAts: string|null, easyOnly: boolean|null, expired: boolean, duplicateOf: number|null }>} o
 */
async function seed(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const source = o.source ?? 'linkedin';
  const url = source === 'linkedin' ? `https://www.linkedin.com/jobs/view/7${n}/` : `https://boards.greenhouse.io/zzreprobe/jobs/${n}`;
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen,
       url, url_normalized, status, fit_score, probe_attempts, apply_probed_at, apply_ats, apply_easy_only, expired_at, duplicate_of)
     VALUES ('Reprobe Test', $1, $2, $3, 'listing', $4, 'reprobe test', 'country-us', $5, now(), $6, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [TAG, source, `zz-reprobe-${process.pid}:${n}`, `reprobe co ${n}`, `zz-reprobe-hash-${n}`, url, o.status === undefined ? 'new' : o.status, o.fit ?? 80,
      o.attempts ?? 3, o.probedAt === undefined ? new Date('2026-10-01T00:00:00Z') : o.probedAt, o.applyAts ?? null, o.easyOnly ?? false,
      o.expired ? new Date() : null, o.duplicateOf ?? null],
  );
  const id = Number(r.rows[0].id);
  ids.push(id);
  return id;
}

/** @param {number} id */
async function row(id) {
  return (await client.query('SELECT probe_attempts, apply_probed_at, apply_easy_only FROM ic_job_listings WHERE id = $1', [id])).rows[0];
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
});

after(async () => {
  if (ids.length) {
    await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('UPDATE ic_job_listings SET duplicate_of = NULL WHERE id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await client.end();
});

describe('bin/reprobe-linkedin.js: parseArgs', () => {
  test('--dry-run and --limit', () => {
    assert.deepEqual(parseArgs(['--dry-run', '--limit', '5']), { dryRun: true, limit: 5, help: false });
    assert.deepEqual(parseArgs([]), { dryRun: false, limit: null, help: false });
  });
  test('a bad --limit throws', () => {
    assert.throws(() => parseArgs(['--limit', 'x']), /--limit/);
    assert.throws(() => parseArgs(['--limit', '0']), /--limit/);
  });
});

describe('bin/reprobe-linkedin.js: selection, dry run, limit, lock', () => {
  test('only eligible LinkedIn rows are reset; every guard excludes its row; apply_easy_only is never set true', async () => {
    const eligible = await seed({ fit: 90 });
    const root = await seed({ source: 'greenhouse' });
    const excluded = [
      await seed({ easyOnly: true }),
      await seed({ applyAts: 'greenhouse' }),
      await seed({ expired: true }),
      await seed({ duplicateOf: root }),
      await seed({ status: 'applied' }),
      await seed({ status: 'passed' }),
      await seed({ source: 'greenhouse' }),
      await seed({ fit: 10 }),
    ];
    const withApp = await seed();
    await client.query(`INSERT INTO ic_job_applications (listing_id, ats_type, state, apply_url) VALUES ($1, 'linkedin_easy', 'approved', 'https://www.linkedin.com/jobs/view/1/')`, [withApp]);
    excluded.push(withApp);

    const r = await runReprobe(client, { dryRun: false, limit: null, probeFitFloor: 60, onlyIds: [eligible, ...excluded], log: () => {} });
    assert.equal(r.outcome, 'reset');
    assert.deepEqual(r.ids, [eligible]);
    const e = await row(eligible);
    assert.equal(e.probe_attempts, 0);
    assert.equal(e.apply_probed_at, null);
    assert.equal(e.apply_easy_only, false);
    for (const id of excluded) assert.notEqual((await row(id)).probe_attempts, 0, `row ${id} must be untouched`);
    assert.equal((await row(excluded[0])).apply_easy_only, true);
  });

  test('--dry-run lists the rows and writes nothing', async () => {
    const id = await seed();
    const r = await runReprobe(client, { dryRun: true, limit: null, probeFitFloor: 60, onlyIds: [id], log: () => {} });
    assert.equal(r.outcome, 'dry_run');
    assert.deepEqual(r.ids, [id]);
    assert.equal((await row(id)).probe_attempts, 3);
  });

  test('--limit takes the highest fit first', async () => {
    const low = await seed({ fit: 70 });
    const high = await seed({ fit: 95 });
    const r = await runReprobe(client, { dryRun: false, limit: 1, probeFitFloor: 60, onlyIds: [low, high], log: () => {} });
    assert.deepEqual(r.ids, [high]);
    assert.equal((await row(low)).probe_attempts, 3);
  });

  test('refuses while the morning run (or a scan) holds the shared advisory lock', async () => {
    const id = await seed();
    const holder = new pg.Client(pgConnectionConfig());
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
      const r = await runReprobe(client, { dryRun: false, limit: null, probeFitFloor: 60, onlyIds: [id], log: () => {} });
      assert.equal(r.outcome, 'locked');
      assert.equal((await row(id)).probe_attempts, 3);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
      await holder.end();
    }
  });
});
