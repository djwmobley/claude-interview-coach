// @ts-check
/**
 * sql/015_listing_apply_target.sql (auto-apply PR B). bin/run-tests.js already applied this migration
 * once during bootstrap (bin/bootstrap-test-db.js's MIGRATIONS list); this file re-applies the same
 * file's text directly to prove idempotence, following test/migration-014.test.js's own pattern.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '015_listing_apply_target.sql'), 'utf8');
const CO = `ZZ-TEST-MIG015-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

async function insertListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Migration 015 Test', $1, $2, $3, 'listing', 'mig015 test co', 'mig015 test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-mig015-${process.pid}`, `zz-test-mig015-${process.pid}:${n}`, `zz-mig015-hash-${n}`],
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

describe('sql/015_listing_apply_target.sql', () => {
  test('apply_* columns exist on ic_job_listings with the expected types', async () => {
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'ic_job_listings'
         AND column_name IN ('apply_url', 'apply_ats', 'apply_ats_confidence', 'apply_ats_hint', 'apply_easy_only', 'apply_probed_at', 'probe_attempts')`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    assert.equal(byName.apply_url.data_type, 'text');
    assert.equal(byName.apply_ats.data_type, 'text');
    assert.equal(byName.apply_ats_confidence.data_type, 'text');
    assert.equal(byName.apply_ats_hint.data_type, 'jsonb');
    assert.equal(byName.apply_easy_only.data_type, 'boolean');
    assert.equal(byName.apply_probed_at.data_type, 'timestamp with time zone');
    assert.equal(byName.probe_attempts.data_type, 'integer');
    assert.equal(byName.probe_attempts.is_nullable, 'NO');
  });

  test('applying the file twice in a row raises no error (idempotent)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });

  test('probe_attempts defaults to 0, every other apply_* column defaults to NULL', async () => {
    const listingId = await insertListing();
    const r = await client.query(
      `SELECT apply_url, apply_ats, apply_ats_confidence, apply_ats_hint, apply_easy_only, apply_probed_at, probe_attempts
       FROM ic_job_listings WHERE id = $1`,
      [listingId],
    );
    const row = r.rows[0];
    assert.equal(row.apply_url, null);
    assert.equal(row.apply_ats, null);
    assert.equal(row.apply_ats_confidence, null);
    assert.equal(row.apply_ats_hint, null);
    assert.equal(row.apply_easy_only, null);
    assert.equal(row.apply_probed_at, null);
    assert.equal(row.probe_attempts, 0);
  });

  test('apply_ats_hint accepts arbitrary jsonb, probe_attempts increments', async () => {
    const listingId = await insertListing();
    const r = await client.query(
      `UPDATE ic_job_listings SET apply_url = $2, apply_ats = 'greenhouse', apply_ats_confidence = 'exact',
         apply_ats_hint = $3::jsonb, apply_easy_only = false, apply_probed_at = now(), probe_attempts = probe_attempts + 1
       WHERE id = $1 RETURNING apply_url, apply_ats, apply_ats_confidence, apply_ats_hint, apply_easy_only, probe_attempts`,
      [listingId, 'https://boards.greenhouse.io/acme/jobs/123', JSON.stringify({ applicantTrackingSystemName: 'greenhouse' })],
    );
    assert.equal(r.rows[0].apply_url, 'https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(r.rows[0].apply_ats, 'greenhouse');
    assert.equal(r.rows[0].apply_ats_confidence, 'exact');
    assert.equal(r.rows[0].apply_ats_hint.applicantTrackingSystemName, 'greenhouse');
    assert.equal(r.rows[0].apply_easy_only, false);
    assert.equal(r.rows[0].probe_attempts, 1);
  });
});
