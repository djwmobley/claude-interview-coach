// @ts-check
/**
 * sql/030_mail_score.sql. Applied twice more here to prove idempotency, then the new columns, defaults, the
 * score_status vocabulary, the budget table, and registration in all three migration lists.
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
const FILE = '030_mail_score.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zzmig030${process.pid}`;
/** @type {pg.Client} */
let client;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(SQL);
  await client.query(SQL);
});
after(async () => {
  await client.query('DELETE FROM ic_mail_intake WHERE message_id LIKE $1', [`${TAG}%`]);
  await client.query(`DELETE FROM ic_mail_score_budget WHERE day = '2031-01-01'`);
  await client.end();
});

describe('sql/030_mail_score.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS and bootstrap-test-db.js, after 029', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`));
    assert.ok(AUX_MIGRATIONS.includes(FILE));
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('029_mail_intake.sql'));
  });

  test('the scoring columns exist with defaults: pending, no attempts, no flags', async () => {
    await client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version) VALUES ($1, 'recruiter_like', 'v1')`, [`${TAG}a`]);
    const r = (await client.query('SELECT score_status, score, score_flags, score_attempts, score_text, scored_at, listing_id FROM ic_mail_intake WHERE message_id = $1', [`${TAG}a`])).rows[0];
    assert.deepEqual([r.score_status, r.score, r.score_flags, r.score_attempts, r.score_text, r.scored_at, r.listing_id], ['pending', null, [], 0, null, null, null]);
  });

  test('score_status is a closed vocabulary', async () => {
    await assert.rejects(client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version, score_status) VALUES ($1, 'recruiter_like', 'v1', 'maybe')`, [`${TAG}b`]), /check/i);
    for (const st of ['pending', 'scored', 'failed']) await client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version, score_status) VALUES ($1, 'recruiter_like', 'v1', $2)`, [`${TAG}-${st}`, st]);
  });

  test('ic_mail_score_budget: one row per day', async () => {
    await client.query(`DELETE FROM ic_mail_score_budget WHERE day = '2031-01-01'`);
    await client.query(`INSERT INTO ic_mail_score_budget (day) VALUES ('2031-01-01')`);
    await assert.rejects(client.query(`INSERT INTO ic_mail_score_budget (day) VALUES ('2031-01-01')`), /duplicate key/);
    assert.equal((await client.query(`SELECT used FROM ic_mail_score_budget WHERE day = '2031-01-01'`)).rows[0].used, 0);
  });
});
