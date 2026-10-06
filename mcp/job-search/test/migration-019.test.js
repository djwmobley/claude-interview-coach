// @ts-check
/**
 * sql/019_assisted_ats.sql (assisted Workday, spec v2 A13 + v1 clause 9). The migration runs inside a
 * throwaway schema placed first on search_path, so the pre-019 state (a singleton breaker row id = 1 that
 * is TRIPPED, a lease row with no ats, an in-flight LinkedIn application) can be built from scratch without
 * touching the shared test database's own tables. Proves: the tripped LinkedIn breaker stays tripped and is
 * keyed 'linkedin_easy'; a second ATS gets its own breaker row; lease rows are backfilled to
 * 'linkedin_easy' and ats becomes NOT NULL with a closed vocabulary; the in-flight index is one slot per
 * ATS (an in-flight LinkedIn row does not block a Workday row, a second row of the same ATS is refused);
 * re-applying the file is a no-op.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_018 = fs.readFileSync(path.join(HERE, '..', 'sql', '018_easy_apply_assisted.sql'), 'utf8');
const SQL_019 = fs.readFileSync(path.join(HERE, '..', 'sql', '019_assisted_ats.sql'), 'utf8');
const SCHEMA = `zz_mig019_${process.pid}`;
/** @type {pg.Client} */
let client;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}, public`);
  // A minimal stand-in for ic_job_applications (only the columns 018/019 read), in the scratch schema.
  await client.query(`CREATE TABLE ${SCHEMA}.ic_job_applications (id serial PRIMARY KEY, ats_type text NOT NULL, state text NOT NULL, pending_question jsonb)`);
  await client.query(SQL_018);
  // Pre-019 data: a tripped singleton breaker, an in-flight LinkedIn application, and its lease row.
  await client.query(`INSERT INTO ic_easy_apply_breaker (id, tripped_until, tripped_at, reason, application_id) VALUES (1, now() + interval '20 hours', now(), 'challenge', NULL)`);
  const app = await client.query(`INSERT INTO ic_job_applications (ats_type, state) VALUES ('linkedin_easy', 'submitting') RETURNING id`);
  await client.query(`INSERT INTO ic_easy_apply_leases (application_id, nonce_hash, trigger, target_id, expires_at) VALUES ($1, 'h', 'dashboard', 'T1', now() + interval '10 minutes')`, [app.rows[0].id]);
  await client.query(SQL_019);
});
after(async () => {
  await client.query('SET search_path TO public');
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

describe('sql/019_assisted_ats.sql', () => {
  test('the tripped LinkedIn breaker stays tripped and is keyed linkedin_easy', async () => {
    const r = await client.query('SELECT ats, reason, tripped_until > now() AS tripped FROM ic_easy_apply_breaker');
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].ats, 'linkedin_easy');
    assert.equal(r.rows[0].reason, 'challenge');
    assert.equal(r.rows[0].tripped, true);
  });

  test('a Workday breaker row is its own key; a duplicate key and an unknown ATS are refused', async () => {
    await client.query(`INSERT INTO ic_easy_apply_breaker (ats, tripped_until, tripped_at, reason) VALUES ('workday', now() + interval '1 hour', now(), 'auth_lost')`);
    const r = await client.query('SELECT ats FROM ic_easy_apply_breaker ORDER BY ats');
    assert.deepEqual(r.rows.map((x) => x.ats), ['linkedin_easy', 'workday']);
    await assert.rejects(client.query(`INSERT INTO ic_easy_apply_breaker (ats, reason) VALUES ('workday', 'x')`), /duplicate key|unique/i);
    await assert.rejects(client.query(`INSERT INTO ic_easy_apply_breaker (ats, reason) VALUES ('greenhouse', 'x')`), /check constraint|violates/i);
  });

  test('lease rows are backfilled to linkedin_easy and ats is NOT NULL with a closed vocabulary', async () => {
    const r = await client.query('SELECT ats FROM ic_easy_apply_leases');
    assert.deepEqual(r.rows.map((x) => x.ats), ['linkedin_easy']);
    const app = await client.query(`INSERT INTO ic_job_applications (ats_type, state) VALUES ('workday', 'approved') RETURNING id`);
    await assert.rejects(client.query(`INSERT INTO ic_easy_apply_leases (application_id, nonce_hash, trigger, expires_at) VALUES ($1, 'h', 'dashboard', now())`, [app.rows[0].id]), /null value|not-null/i);
    await assert.rejects(client.query(`INSERT INTO ic_easy_apply_leases (application_id, nonce_hash, trigger, expires_at, ats) VALUES ($1, 'h', 'dashboard', now(), 'lever')`, [app.rows[0].id]), /check constraint|violates/i);
    await client.query(`INSERT INTO ic_easy_apply_leases (application_id, nonce_hash, trigger, expires_at, ats) VALUES ($1, 'h', 'dashboard', now(), 'workday')`, [app.rows[0].id]);
  });

  test('in-flight is one slot per ATS: the in-flight LinkedIn row does not block Workday; a second of either ATS is refused', async () => {
    await client.query(`INSERT INTO ic_job_applications (ats_type, state) VALUES ('workday', 'submitting')`);
    await assert.rejects(client.query(`INSERT INTO ic_job_applications (ats_type, state) VALUES ('workday', 'submitting')`), /duplicate key|unique/i);
    await assert.rejects(
      client.query(`INSERT INTO ic_job_applications (ats_type, state, pending_question) VALUES ('workday', 'needs_human', '{"kind":"awaiting_submit"}')`),
      /duplicate key|unique/i,
    );
    await assert.rejects(client.query(`INSERT INTO ic_job_applications (ats_type, state) VALUES ('linkedin_easy', 'submitting')`), /duplicate key|unique/i);
    // Other ATS types and parked-for-a-question rows never take a slot.
    await client.query(`INSERT INTO ic_job_applications (ats_type, state) VALUES ('greenhouse', 'submitting'), ('greenhouse', 'submitting')`);
    await client.query(`INSERT INTO ic_job_applications (ats_type, state, pending_question) VALUES ('workday', 'needs_human', '{"kind":"question"}')`);
  });

  test('re-applying the file twice raises nothing and changes nothing', async () => {
    const before = await client.query('SELECT ats, reason FROM ic_easy_apply_breaker ORDER BY ats');
    await client.query(SQL_019);
    await client.query(SQL_019);
    const afterRows = await client.query('SELECT ats, reason FROM ic_easy_apply_breaker ORDER BY ats');
    assert.deepEqual(afterRows.rows, before.rows);
  });
});
