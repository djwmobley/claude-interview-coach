// @ts-check
/**
 * sql/014_application_salary_floor.sql (one-click apply PR A spec item 1). bin/run-tests.js already
 * applied this migration once during bootstrap (bin/bootstrap-test-db.js's MIGRATIONS list); this file
 * re-applies the same file's text directly to prove idempotence, following test/migration-012.test.js's
 * own pattern.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '014_application_salary_floor.sql'), 'utf8');
const CO = `ZZ-TEST-MIG014-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

async function insertListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Migration 014 Test', $1, $2, $3, 'listing', 'mig014 test co', 'mig014 test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-mig014-${process.pid}`, `zz-test-mig014-${process.pid}:${n}`, `zz-mig014-hash-${n}`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
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

describe('sql/014_application_salary_floor.sql', () => {
  test('salary_floor, review_verdict, review_findings columns exist on ic_job_applications', async () => {
    const cols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ic_job_applications' AND column_name IN ('salary_floor', 'review_verdict', 'review_findings')`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.data_type]));
    assert.equal(byName.salary_floor, 'integer');
    assert.equal(byName.review_verdict, 'text');
    assert.equal(byName.review_findings, 'jsonb');
  });

  test('applying the file twice in a row raises no error (idempotent)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });

  test('salary_floor accepts an integer and review_findings accepts arbitrary jsonb', async () => {
    const listingId = await insertListing();
    const r = await client.query(
      `INSERT INTO ic_job_applications (listing_id, salary_floor, review_verdict, review_findings)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING salary_floor, review_verdict, review_findings`,
      [listingId, 225000, 'PASS', JSON.stringify({ verdict: 'PASS', critical_count: 0, important_count: 0, minor_count: 0, findings: [] })],
    );
    assert.equal(r.rows[0].salary_floor, 225000);
    assert.equal(r.rows[0].review_verdict, 'PASS');
    assert.equal(r.rows[0].review_findings.verdict, 'PASS');
  });

  test('all three columns default to NULL', async () => {
    const listingId = await insertListing();
    const r = await client.query(`INSERT INTO ic_job_applications (listing_id) VALUES ($1) RETURNING salary_floor, review_verdict, review_findings`, [listingId]);
    assert.equal(r.rows[0].salary_floor, null);
    assert.equal(r.rows[0].review_verdict, null);
    assert.equal(r.rows[0].review_findings, null);
  });
});
