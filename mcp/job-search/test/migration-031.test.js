// @ts-check
/**
 * sql/031_mail_listing_provenance.sql. Applied twice more here to prove idempotency, then the new column and
 * registration in all three migration lists.
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
const FILE = '031_mail_listing_provenance.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
/** @type {pg.Client} */
let client;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(SQL);
  await client.query(SQL);
});
after(async () => {
  await client.end();
});

describe('sql/031_mail_listing_provenance.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS and bootstrap-test-db.js, after 030', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`));
    assert.ok(AUX_MIGRATIONS.includes(FILE));
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('030_mail_score.sql'));
  });

  test('ic_job_listings.mail_auto_fields is a nullable jsonb column', async () => {
    const r = (await client.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'ic_job_listings' AND column_name = 'mail_auto_fields'`)).rows[0];
    assert.deepEqual([r.data_type, r.is_nullable], ['jsonb', 'YES']);
  });
});
