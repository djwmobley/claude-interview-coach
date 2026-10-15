// @ts-check
/**
 * sql/023_targets.sql (target finder). Runs against the shared, bootstrapped test database (the
 * pgConnectionConfig() guard refuses any database not ending in _test), where bin/bootstrap-test-db.js
 * already applied 023 once; this file applies it a SECOND time to prove idempotency, then checks tables,
 * CHECK constraints, unique indexes, and registration in all three migration lists.
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
const FILE = '023_targets.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zz-test-mig023-${process.pid}`;
/** @type {pg.Client} */
let client;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(SQL);
  await client.query(SQL);
});
after(async () => {
  await client.query('DELETE FROM ic_target_signals WHERE source = $1', [TAG]);
  await client.query('DELETE FROM ic_targets WHERE company_norm LIKE $1', [`${TAG}%`]);
  await client.end();
});

/** @param {string} norm @param {Record<string, any>} [o] */
async function insertTarget(norm, o = {}) {
  const r = await client.query(
    `INSERT INTO ic_targets (company, company_norm, class, verdict_rule, trigger_kind, size_confidence)
     VALUES ($1, $2, $3, 'target_all_checks_passed', $4, $5) RETURNING id`,
    ['Test Co', `${TAG}-${norm}`, o.class ?? 'target', o.trigger_kind ?? 'pe_deal', o.size_confidence ?? 'high'],
  );
  return Number(r.rows[0].id);
}

describe('sql/023_targets.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS, and bootstrap-test-db.js', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`), 'bin/migrate.js MIGRATIONS');
    assert.ok(AUX_MIGRATIONS.includes(FILE), 'AUX_MIGRATIONS');
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE), 'bootstrap MIGRATIONS');
  });

  test('all four tables exist and none reuses the ic_gmail_targets name', async () => {
    const r = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('ic_targets','ic_target_signals','ic_target_drafts','ic_target_runs')`);
    assert.equal(r.rowCount, 4);
    assert.ok(!SQL.includes('CREATE TABLE IF NOT EXISTS ic_gmail_targets'));
  });

  test('ic_targets refuses classes, trigger kinds, and confidences outside the vocabularies', async () => {
    await insertTarget('ok');
    await assert.rejects(insertTarget('bad-class', { class: 'maybe' }), /check/i);
    await assert.rejects(insertTarget('bad-kind', { trigger_kind: 'rumor' }), /check/i);
    await assert.rejects(insertTarget('bad-conf', { size_confidence: 'certain' }), /check/i);
  });

  test('company_norm is unique: one row per company group', async () => {
    await insertTarget('dup');
    await assert.rejects(insertTarget('dup'), /unique|duplicate/i);
  });

  test('signals: url_hash is unique and a deleted target nulls the link', async () => {
    const id = await insertTarget('sig');
    await client.query(`INSERT INTO ic_target_signals (url_hash, source, target_id) VALUES ($1, $2, $3)`, [`${TAG}-h1`, TAG, id]);
    await assert.rejects(client.query(`INSERT INTO ic_target_signals (url_hash, source) VALUES ($1, $2)`, [`${TAG}-h1`, TAG]), /unique|duplicate/i);
    await client.query('DELETE FROM ic_targets WHERE id = $1', [id]);
    const r = await client.query('SELECT target_id FROM ic_target_signals WHERE url_hash = $1', [`${TAG}-h1`]);
    assert.equal(r.rows[0].target_id, null);
    await client.query('DELETE FROM ic_target_signals WHERE url_hash = $1', [`${TAG}-h1`]);
  });

  test('drafts: review verdict and state vocabularies are enforced; deleting the target cascades', async () => {
    const id = await insertTarget('draft');
    await client.query(`INSERT INTO ic_target_drafts (target_id, hook, review_verdict, state) VALUES ($1, 'h', 'PASS', 'awaiting_approval')`, [id]);
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, review_verdict) VALUES ($1, 'MAYBE')`, [id]), /check/i);
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, state) VALUES ($1, 'sent')`, [id]), /check/i);
    await client.query('DELETE FROM ic_targets WHERE id = $1', [id]);
    const r = await client.query('SELECT 1 FROM ic_target_drafts WHERE target_id = $1', [id]);
    assert.equal(r.rowCount, 0);
  });

  test('there is no sent state anywhere in the draft vocabulary', () => {
    assert.ok(!/'sent'/.test(SQL));
  });

  test('runs: defaults and status vocabulary', async () => {
    const r = await client.query(`INSERT INTO ic_target_runs DEFAULT VALUES RETURNING id, status, signals_seen`);
    assert.equal(r.rows[0].status, 'running');
    assert.equal(r.rows[0].signals_seen, 0);
    await assert.rejects(client.query(`UPDATE ic_target_runs SET status = 'weird' WHERE id = $1`, [r.rows[0].id]), /check/i);
    await client.query('DELETE FROM ic_target_runs WHERE id = $1', [r.rows[0].id]);
  });
});
