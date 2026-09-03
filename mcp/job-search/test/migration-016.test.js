// @ts-check
/**
 * sql/016_listing_salary_period.sql (hourly-disqualifier ruling). bin/run-tests.js already applied this
 * migration once during bootstrap (bin/bootstrap-test-db.js's MIGRATIONS list); this file re-applies the
 * same file's text directly to prove idempotence, following test/migration-015.test.js's own pattern.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '016_listing_salary_period.sql'), 'utf8');
const CO = `ZZ-TEST-MIG016-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

async function insertListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Migration 016 Test', $1, $2, $3, 'listing', 'mig016 test co', 'mig016 test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-mig016-${process.pid}`, `zz-test-mig016-${process.pid}:${n}`, `zz-mig016-hash-${n}`],
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
  await client.query(SQL);
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('sql/016_listing_salary_period.sql', () => {
  test('salary_period column exists on ic_job_listings with the expected type', async () => {
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'ic_job_listings' AND column_name = 'salary_period'`,
    );
    assert.equal(cols.rowCount, 1);
    assert.equal(cols.rows[0].data_type, 'text');
    assert.equal(cols.rows[0].is_nullable, 'YES');
  });

  test('applying the file twice in a row raises no error (idempotent)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });

  test('salary_period defaults to NULL on a fresh row', async () => {
    const listingId = await insertListing();
    const r = await client.query('SELECT salary_period FROM ic_job_listings WHERE id = $1', [listingId]);
    assert.equal(r.rows[0].salary_period, null);
  });

  test('salary_period accepts each of the classified values', async () => {
    const listingId = await insertListing();
    for (const period of ['hour', 'day', 'week', 'month', 'year', 'unknown']) {
      const r = await client.query('UPDATE ic_job_listings SET salary_period = $2 WHERE id = $1 RETURNING salary_period', [listingId, period]);
      assert.equal(r.rows[0].salary_period, period);
    }
  });
});
