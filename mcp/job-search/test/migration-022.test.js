// @ts-check
/**
 * sql/022_ready_to_apply.sql (Ready to apply list). Runs against the shared, bootstrapped test database,
 * where bin/bootstrap-test-db.js already applied 022 once; this file applies it a SECOND time to prove the
 * DDL is idempotent, then checks the columns, the tables, the CHECK constraints, and that 022 is
 * registered in all three migration lists.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { AUX_MIGRATIONS } from '../src/core/schema.js';
import { MIGRATIONS as BOOTSTRAP_MIGRATIONS } from '../bin/bootstrap-test-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = '022_ready_to_apply.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const SRC = `zz-test-mig022-${process.pid}`;
/** @type {pg.Client} */
let client;
let listingId = 0;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(SQL);
  await client.query(SQL);
  const r = await client.query(
    `INSERT INTO ic_job_listings (source, external_id, url, title, company) VALUES ($1, $2, 'https://example.com/j/1', 'CTO', 'Acme') RETURNING id`,
    [SRC, `${SRC}-1`],
  );
  listingId = Number(r.rows[0].id);
});
after(async () => {
  await client.query('DELETE FROM ic_job_listings WHERE source = $1', [SRC]);
  await client.end();
});

describe('sql/022_ready_to_apply.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS, and bootstrap-test-db.js', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`), 'bin/migrate.js MIGRATIONS');
    assert.ok(AUX_MIGRATIONS.includes(FILE), 'AUX_MIGRATIONS');
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE), 'bootstrap MIGRATIONS');
  });

  test('listing columns exist with their defaults', async () => {
    const r = await client.query('SELECT manual_apply_url, manual_apply_host, manual_apply_origin, manual_apply_seen_at, apply_page_branch, apply_page_reason, apply_page_first_seen_at, apply_page_repeat FROM ic_job_listings WHERE id = $1', [listingId]);
    assert.equal(r.rows[0].apply_page_repeat, 0);
    assert.equal(r.rows[0].manual_apply_url, null);
  });

  test('manual_apply_origin and apply_page_branch refuse values outside their vocabularies', async () => {
    await client.query(`UPDATE ic_job_listings SET manual_apply_origin = 'linkedin_href', apply_page_branch = 'no_control' WHERE id = $1`, [listingId]);
    await assert.rejects(client.query(`UPDATE ic_job_listings SET manual_apply_origin = 'guess' WHERE id = $1`, [listingId]), /check/i);
    await assert.rejects(client.query(`UPDATE ic_job_listings SET apply_page_branch = 'maybe' WHERE id = $1`, [listingId]), /check/i);
  });

  test('ic_ready_to_apply: bucket family, resume_status, and channel CHECKs; cascade on listing delete', async () => {
    await client.query(`INSERT INTO ic_ready_to_apply (listing_id, bucket, last_classified_at) VALUES ($1, 'ready_to_apply', now())`, [listingId]);
    const row = (await client.query('SELECT resume_status, resume_attempts FROM ic_ready_to_apply WHERE listing_id = $1', [listingId])).rows[0];
    assert.equal(row.resume_status, 'none');
    assert.equal(row.resume_attempts, 0);
    await assert.rejects(client.query(`UPDATE ic_ready_to_apply SET bucket = 'ready' WHERE listing_id = $1`, [listingId]), /check/i);
    await assert.rejects(client.query(`UPDATE ic_ready_to_apply SET resume_status = 'done' WHERE listing_id = $1`, [listingId]), /check/i);
    await assert.rejects(client.query(`UPDATE ic_ready_to_apply SET channel = 'fax' WHERE listing_id = $1`, [listingId]), /check/i);
    await assert.rejects(client.query(`UPDATE ic_ready_to_apply SET review_verdict = 'MAYBE' WHERE listing_id = $1`, [listingId]), /check/i);
  });

  test('ic_manual_only_locks: one active lock per listing, released rows do not count', async () => {
    await client.query(`INSERT INTO ic_manual_only_locks (listing_id, root_listing_id, bucket) VALUES ($1, $1, 'ready_to_apply')`, [listingId]);
    await assert.rejects(client.query(`INSERT INTO ic_manual_only_locks (listing_id, root_listing_id, bucket) VALUES ($1, $1, 'held_not_probed')`, [listingId]), /duplicate|unique/i);
    await client.query(`UPDATE ic_manual_only_locks SET released_at = now(), released_by = 'dashboard' WHERE listing_id = $1`, [listingId]);
    await client.query(`INSERT INTO ic_manual_only_locks (listing_id, root_listing_id, bucket) VALUES ($1, $1, 'held_not_probed')`, [listingId]);
    const n = (await client.query('SELECT count(*)::int AS n FROM ic_manual_only_locks WHERE listing_id = $1', [listingId])).rows[0].n;
    assert.equal(n, 2);
  });
});
