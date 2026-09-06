// @ts-check
/**
 * sql/017_detail_outcome.sql (scan-detail-pass fix). bin/run-tests.js already applied this migration
 * once during bootstrap (bin/bootstrap-test-db.js's MIGRATIONS list); this file re-applies the same
 * file's text directly to prove idempotence AND the historical backfill, following
 * test/migration-016.test.js's own pattern.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '017_detail_outcome.sql'), 'utf8');
const CO = `ZZ-TEST-MIG017-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

/** @param {{ description?: string|null, detailSkipped?: boolean, detailOutcome?: string|null }} [opts] */
async function insertListing(opts = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, description, detail_skipped, detail_outcome)
     VALUES ('Migration 017 Test', $1, $2, $3, 'listing', 'mig017 test co', 'mig017 test', 'legacy-unknown', $4, now(), $5, $6, $7) RETURNING id`,
    [CO, `zz-test-mig017-${process.pid}`, `zz-test-mig017-${process.pid}:${n}`, `zz-mig017-hash-${n}`, opts.description ?? null, Boolean(opts.detailSkipped), opts.detailOutcome ?? null],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('sql/017_detail_outcome.sql', () => {
  test('detail_outcome and detail_attempts columns exist on ic_job_listings with the expected type/default', async () => {
    await client.query(SQL);
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'ic_job_listings' AND column_name IN ('detail_outcome', 'detail_attempts')`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    assert.equal(byName.detail_outcome.data_type, 'text');
    assert.equal(byName.detail_outcome.is_nullable, 'YES');
    assert.equal(byName.detail_attempts.data_type, 'integer');
    assert.equal(byName.detail_attempts.is_nullable, 'NO');
  });

  test('applying the file twice in a row raises no error (idempotent)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });

  test('detail_outcome defaults to NULL and detail_attempts to 0 on a fresh row', async () => {
    const id = await insertListing();
    const r = await client.query('SELECT detail_outcome, detail_attempts FROM ic_job_listings WHERE id = $1', [id]);
    assert.equal(r.rows[0].detail_outcome, null);
    assert.equal(r.rows[0].detail_attempts, 0);
  });

  test('detail_outcome accepts each of the classified values', async () => {
    const id = await insertListing();
    for (const outcome of ['fetched', 'empty', 'error', 'skipped_budget', 'skipped_gate', 'skipped_cancelled', 'not_queued']) {
      const r = await client.query('UPDATE ic_job_listings SET detail_outcome = $2 WHERE id = $1 RETURNING detail_outcome', [id, outcome]);
      assert.equal(r.rows[0].detail_outcome, outcome);
    }
  });

  test('historical backfill: a pre-existing detail_skipped=true row becomes skipped_budget', async () => {
    const id = await insertListing({ detailSkipped: true, description: null });
    // Simulate a pre-migration row: reset detail_outcome to NULL (the column already exists in this test
    // DB from bootstrap, so a fresh INSERT above already ran the CASE once with detail_outcome not yet
    // set on the row -- but our own insertListing() passes detailOutcome explicitly as NULL by default,
    // so the column is genuinely NULL here already). Re-run the migration's backfill directly.
    await client.query(`UPDATE ic_job_listings SET detail_outcome = NULL WHERE id = $1`, [id]);
    await client.query(SQL);
    const r = await client.query('SELECT detail_outcome FROM ic_job_listings WHERE id = $1', [id]);
    assert.equal(r.rows[0].detail_outcome, 'skipped_budget');
  });

  test('historical backfill: a row with description >= 300 chars and detail_skipped=false becomes fetched', async () => {
    const id = await insertListing({ description: 'x'.repeat(300), detailSkipped: false });
    await client.query(`UPDATE ic_job_listings SET detail_outcome = NULL WHERE id = $1`, [id]);
    await client.query(SQL);
    const r = await client.query('SELECT detail_outcome FROM ic_job_listings WHERE id = $1', [id]);
    assert.equal(r.rows[0].detail_outcome, 'fetched');
  });

  test('historical backfill: a row with a short (<300) description and detail_skipped=false is left NULL', async () => {
    const id = await insertListing({ description: 'x'.repeat(299), detailSkipped: false });
    await client.query(`UPDATE ic_job_listings SET detail_outcome = NULL WHERE id = $1`, [id]);
    await client.query(SQL);
    const r = await client.query('SELECT detail_outcome FROM ic_job_listings WHERE id = $1', [id]);
    assert.equal(r.rows[0].detail_outcome, null);
  });

  test('historical backfill: a row with no description and detail_skipped=false is left NULL', async () => {
    const id = await insertListing({ description: null, detailSkipped: false });
    await client.query(`UPDATE ic_job_listings SET detail_outcome = NULL WHERE id = $1`, [id]);
    await client.query(SQL);
    const r = await client.query('SELECT detail_outcome FROM ic_job_listings WHERE id = $1', [id]);
    assert.equal(r.rows[0].detail_outcome, null);
  });

  test('backfill never overwrites a row whose detail_outcome is already set (WHERE detail_outcome IS NULL guard)', async () => {
    const id = await insertListing({ description: 'x'.repeat(300), detailSkipped: false, detailOutcome: 'empty' });
    await client.query(SQL);
    const r = await client.query('SELECT detail_outcome FROM ic_job_listings WHERE id = $1', [id]);
    assert.equal(r.rows[0].detail_outcome, 'empty', 'already-classified rows are left alone, never re-derived from description length');
  });
});
