// @ts-check
/**
 * sql/021_fit_basis.sql (unblock-auto-apply A2 + A9). Runs inside a throwaway schema placed first on
 * search_path, with minimal stand-ins for ic_job_listings and ic_job_events, so the pre-021 state is built
 * from scratch without touching the shared test database's own tables. Proves: both columns are added with
 * their defaults; fit_basis refuses any value outside the two known ones; the backfill tags exactly the
 * rows whose latest fit came from the model while the description was empty (a human fit, a row with a
 * description, and an unscored row are untouched); re-applying the file is a no-op.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_021 = fs.readFileSync(path.join(HERE, '..', 'sql', '021_fit_basis.sql'), 'utf8');
const SCHEMA = `zz_mig021_${process.pid}`;
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
  await client.query(`CREATE TABLE ${SCHEMA}.ic_job_listings (id serial PRIMARY KEY, fit_score int, description text)`);
  await client.query(`CREATE TABLE ${SCHEMA}.ic_job_events (id serial PRIMARY KEY, listing_id int NOT NULL, kind text NOT NULL, actor text NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
  const ins = `INSERT INTO ic_job_listings (fit_score, description) VALUES ($1, $2) RETURNING id`;
  ids.autoEmpty = Number((await client.query(ins, [72, null])).rows[0].id);
  ids.autoBlank = Number((await client.query(ins, [65, '   '])).rows[0].id);
  ids.autoDesc = Number((await client.query(ins, [80, 'A real description.'])).rows[0].id);
  ids.human = Number((await client.query(ins, [90, null])).rows[0].id);
  ids.humanLater = Number((await client.query(ins, [70, null])).rows[0].id);
  ids.unscored = Number((await client.query(ins, [null, null])).rows[0].id);
  const ev = `INSERT INTO ic_job_events (listing_id, kind, actor, at) VALUES ($1, 'fit', $2, $3)`;
  await client.query(ev, [ids.autoEmpty, 'auto', '2026-10-01T10:00:00Z']);
  await client.query(ev, [ids.autoBlank, 'auto', '2026-10-01T10:00:00Z']);
  await client.query(ev, [ids.autoDesc, 'auto', '2026-10-01T10:00:00Z']);
  await client.query(ev, [ids.human, 'dashboard', '2026-10-01T10:00:00Z']);
  await client.query(ev, [ids.humanLater, 'auto', '2026-10-01T10:00:00Z']);
  await client.query(ev, [ids.humanLater, 'mcp', '2026-10-02T10:00:00Z']);
  await client.query(SQL_021);
});
after(async () => {
  await client.query('SET search_path TO public');
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

/** @param {number} id */
const row = async (id) => (await client.query('SELECT fit_basis, triage_model_failures FROM ic_job_listings WHERE id = $1', [id])).rows[0];

describe('sql/021_fit_basis.sql', () => {
  test('backfill tags only model fits made without a description', async () => {
    assert.equal((await row(ids.autoEmpty)).fit_basis, 'no_description');
    assert.equal((await row(ids.autoBlank)).fit_basis, 'no_description');
    assert.equal((await row(ids.autoDesc)).fit_basis, null);
    assert.equal((await row(ids.human)).fit_basis, null);
    assert.equal((await row(ids.humanLater)).fit_basis, null, 'the latest fit event was a human one');
    assert.equal((await row(ids.unscored)).fit_basis, null);
  });

  test('triage_model_failures defaults to 0', async () => {
    assert.equal((await row(ids.unscored)).triage_model_failures, 0);
  });

  test('fit_basis refuses any value outside description/no_description', async () => {
    await client.query(`UPDATE ic_job_listings SET fit_basis = 'description' WHERE id = $1`, [ids.autoDesc]);
    await assert.rejects(client.query(`UPDATE ic_job_listings SET fit_basis = 'guess' WHERE id = $1`, [ids.autoDesc]), /check/i);
  });

  test('ic_gmail_targets: one row per listing, deleted with the listing (B1)', async () => {
    await client.query(`INSERT INTO ic_gmail_targets (listing_id, original_url, branch, outcome) VALUES ($1, 'https://t.ladders.co/f/a/x', 'network_unwrap', 'resolved')`, [ids.unscored]);
    await assert.rejects(client.query(`INSERT INTO ic_gmail_targets (listing_id, branch, outcome) VALUES ($1, 'x', 'y')`, [ids.unscored]), /duplicate|unique/i);
    await client.query('DELETE FROM ic_job_listings WHERE id = $1', [ids.unscored]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM ic_gmail_targets WHERE listing_id = $1', [ids.unscored])).rows[0].n, 0);
  });

  test('re-applying the file is a no-op', async () => {
    await client.query(SQL_021);
    assert.equal((await row(ids.autoDesc)).fit_basis, 'description');
    assert.equal((await row(ids.autoEmpty)).fit_basis, 'no_description');
  });
});
