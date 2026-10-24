// @ts-check
/**
 * sql/029_mail_intake.sql. Runs against the shared, bootstrapped test database, where bin/bootstrap-test-db.js
 * already applied 029 once; this file applies it twice more to prove idempotency, then checks the tables, the
 * closed vocabularies and the registration in all three migration lists.
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
const FILE = '029_mail_intake.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zzmig029${process.pid}`;
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
  await client.end();
});

/** @param {string} table @returns {Promise<string[]>} */
async function columns(table) {
  const r = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  return r.rows.map((x) => x.column_name);
}

describe('sql/029_mail_intake.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS and bootstrap-test-db.js, after 028', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`));
    assert.ok(AUX_MIGRATIONS.includes(FILE));
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('028_source_wall_reason.sql'));
  });

  test('applying it again is a no-op (idempotent DDL)', async () => {
    await client.query(SQL);
    assert.ok((await columns('ic_mail_intake')).length > 10);
  });

  test('ic_mail_intake carries the ledger columns, and is separate from ic_gmail_processed_messages', async () => {
    const cols = await columns('ic_mail_intake');
    for (const c of ['message_id', 'thread_id', 'bucket', 'rules_version', 'first_seen_at', 'surfaced_run_id', 'subject', 'snippet', 'from_addr', 'reply_to', 'labels', 'spam', 'body_unreadable', 'status']) {
      assert.ok(cols.includes(c), c);
    }
    assert.ok(!SQL.includes('ALTER TABLE ic_gmail_processed_messages'), 'the confirm.js ledger is untouched');
  });

  test('message_id is the primary key', async () => {
    await client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version) VALUES ($1, 'unsorted', 'v1')`, [`${TAG}a`]);
    await assert.rejects(client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version) VALUES ($1, 'unsorted', 'v1')`, [`${TAG}a`]), /duplicate key/);
  });

  test('bucket and status vocabularies are closed; defaults are open, not spam, no labels', async () => {
    await assert.rejects(client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version) VALUES ($1, 'junk', 'v1')`, [`${TAG}b`]), /check/i);
    await assert.rejects(client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version, status) VALUES ($1, 'unsorted', 'v1', 'later')`, [`${TAG}c`]), /check/i);
    const r = (await client.query(`SELECT status, spam, labels, body_unreadable, surfaced_run_id FROM ic_mail_intake WHERE message_id = $1`, [`${TAG}a`])).rows[0];
    assert.deepEqual([r.status, r.spam, r.labels, r.body_unreadable, r.surfaced_run_id], ['open', false, [], false, null]);
    for (const b of ['self', 'registered_alert', 'application_mail', 'internal', 'thread_reply', 'recruiter_like', 'bulk_noise', 'unsorted']) {
      await client.query(`INSERT INTO ic_mail_intake (message_id, bucket, rules_version) VALUES ($1, $2, 'v1')`, [`${TAG}-${b}`, b]);
    }
  });

  test('ic_google_capability: one row per read, send, calendar only', async () => {
    assert.ok((await columns('ic_google_capability')).includes('broken_since'));
    await client.query(`DELETE FROM ic_google_capability WHERE capability = 'calendar'`);
    await client.query(`INSERT INTO ic_google_capability (capability) VALUES ('calendar')`);
    await assert.rejects(client.query(`INSERT INTO ic_google_capability (capability) VALUES ('calendar')`), /duplicate key/);
    await assert.rejects(client.query(`INSERT INTO ic_google_capability (capability) VALUES ('fax')`), /check/i);
    await client.query(`DELETE FROM ic_google_capability WHERE capability = 'calendar'`);
  });
});
