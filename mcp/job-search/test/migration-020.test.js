// @ts-check
/**
 * sql/020_submit_markers.sql (unattended submit spec v2 C3). Runs inside a throwaway schema placed first on
 * search_path, with minimal stand-ins for ic_job_applications and ic_job_application_events, so the
 * pre-020 state (applications with zero, one, or two legacy 'submit_request_sent' events) is built from
 * scratch without touching the shared test database's own tables. Proves: every application with a legacy
 * marker event gets exactly one marker row dated by its EARLIEST such event; an application without one
 * gets none; the primary key makes a second marker for the same application impossible; deleting the
 * application removes its marker; re-applying the file is a no-op.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_020 = fs.readFileSync(path.join(HERE, '..', 'sql', '020_submit_markers.sql'), 'utf8');
const SCHEMA = `zz_mig020_${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {Record<string, number>} */
const ids = {};

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}, public`);
  await client.query(`CREATE TABLE ${SCHEMA}.ic_job_applications (id serial PRIMARY KEY, ats_type text NOT NULL, state text NOT NULL)`);
  await client.query(`CREATE TABLE ${SCHEMA}.ic_job_application_events (id serial PRIMARY KEY, application_id int NOT NULL REFERENCES ${SCHEMA}.ic_job_applications(id) ON DELETE CASCADE, kind text NOT NULL, actor text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now())`);
  for (const k of ['twice', 'once', 'never']) {
    ids[k] = Number((await client.query(`INSERT INTO ic_job_applications (ats_type, state) VALUES ('greenhouse', 'needs_human') RETURNING id`)).rows[0].id);
  }
  const ev = `INSERT INTO ic_job_application_events (application_id, kind, actor, note, created_at) VALUES ($1, $2, 'apply', $3, $4)`;
  await client.query(ev, [ids.twice, 'progress', 'submit_request_sent', '2026-09-01T10:00:00Z']);
  await client.query(ev, [ids.twice, 'progress', 'submit_request_sent', '2026-09-03T10:00:00Z']);
  await client.query(ev, [ids.once, 'progress', 'submit_request_sent', '2026-09-02T23:30:00Z']);
  await client.query(ev, [ids.never, 'progress', 'assisted_next_clicked', '2026-09-02T10:00:00Z']);
  await client.query(SQL_020);
});
after(async () => {
  await client.query('SET search_path TO public');
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

describe('sql/020_submit_markers.sql', () => {
  test('backfills exactly one marker per application with a legacy marker event, dated by the earliest one', async () => {
    const r = await client.query(`SELECT application_id, ats_type, day::text AS day, created_at FROM ic_job_submit_markers ORDER BY application_id`);
    assert.deepEqual(r.rows.map((x) => Number(x.application_id)), [ids.twice, ids.once]);
    const twice = r.rows.find((x) => Number(x.application_id) === ids.twice);
    assert.equal(new Date(twice.created_at).toISOString(), '2026-09-01T10:00:00.000Z');
    assert.equal(twice.day, '2026-09-01');
    assert.equal(twice.ats_type, 'greenhouse');
    const once = r.rows.find((x) => Number(x.application_id) === ids.once);
    assert.equal(once.day, '2026-09-02', 'the day is the UTC day');
  });

  test('a second marker for the same application is impossible (the one statement only one caller can win)', async () => {
    await assert.rejects(() => client.query(`INSERT INTO ic_job_submit_markers (application_id, day) VALUES ($1, current_date)`, [ids.once]), /duplicate key/);
    const won = await client.query(`INSERT INTO ic_job_submit_markers (application_id, day) VALUES ($1, current_date) ON CONFLICT (application_id) DO NOTHING RETURNING application_id`, [ids.once]);
    assert.equal(won.rowCount, 0);
  });

  test('re-applying the file is a no-op, and deleting an application removes its marker', async () => {
    await client.query(SQL_020);
    assert.equal(Number((await client.query('SELECT count(*)::int AS n FROM ic_job_submit_markers')).rows[0].n), 2);
    await client.query('DELETE FROM ic_job_applications WHERE id = $1', [ids.twice]);
    assert.equal(Number((await client.query('SELECT count(*)::int AS n FROM ic_job_submit_markers WHERE application_id = $1', [ids.twice])).rows[0].n), 0);
  });
});
