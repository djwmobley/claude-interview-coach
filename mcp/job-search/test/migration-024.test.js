// @ts-check
/**
 * sql/024_target_sources.sql (target finder PR2). Runs against the shared, bootstrapped test database (the
 * pgConnectionConfig() guard refuses any database not ending in _test), where bin/bootstrap-test-db.js
 * already applied 024 once; this file applies it a SECOND time to prove idempotency, then checks the new
 * columns, the CHECK constraint, and registration in all three migration lists.
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
const FILE = '024_target_sources.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zz-test-mig024-${process.pid}`;
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
  await client.query('DELETE FROM ic_target_source_state WHERE source = $1', [TAG]);
  await client.query('DELETE FROM ic_targets WHERE company_norm LIKE $1', [`${TAG}%`]);
  await client.end();
});

/** @param {string} table @returns {Promise<string[]>} */
async function columns(table) {
  const r = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  return r.rows.map((x) => x.column_name);
}

describe('sql/024_target_sources.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS, and bootstrap-test-db.js', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`), 'bin/migrate.js MIGRATIONS');
    assert.ok(AUX_MIGRATIONS.includes(FILE), 'AUX_MIGRATIONS');
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE), 'bootstrap MIGRATIONS');
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('023_targets.sql'), 'runs after 023');
  });

  test('new columns exist on ic_targets, ic_target_signals, and ic_target_runs; the source-state table exists', async () => {
    assert.ok((await columns('ic_targets')).includes('size_verified'));
    for (const c of ['parse_outcome', 'parse_reason', 'content_hash', 'signal', 'contact']) assert.ok((await columns('ic_target_signals')).includes(c), c);
    for (const c of ['items_raw', 'items_parsed', 'items_unparseable', 'items_out_of_scope', 'source_stats']) assert.ok((await columns('ic_target_runs')).includes(c), c);
    for (const c of ['source', 'last_success_at', 'last_attempt_at', 'last_status', 'watermark']) assert.ok((await columns('ic_target_source_state')).includes(c), c);
  });

  test('size_verified is nullable (not computed), true, or false', async () => {
    const r = await client.query(
      `INSERT INTO ic_targets (company, company_norm, class, verdict_rule) VALUES ('T', $1, 'target', 'target_all_checks_passed') RETURNING size_verified`, [`${TAG}-sv`],
    );
    assert.equal(r.rows[0].size_verified, null);
    await client.query(`UPDATE ic_targets SET size_verified = false WHERE company_norm = $1`, [`${TAG}-sv`]);
    const r2 = await client.query(`SELECT size_verified FROM ic_targets WHERE company_norm = $1`, [`${TAG}-sv`]);
    assert.equal(r2.rows[0].size_verified, false);
  });

  test('parse_outcome accepts only the three outcomes', async () => {
    for (const o of ['parsed', 'unparseable', 'out_of_scope']) {
      await client.query(`INSERT INTO ic_target_signals (url_hash, source, parse_outcome) VALUES ($1, $2, $3)`, [`${TAG}-${o}`, TAG, o]);
    }
    await assert.rejects(client.query(`INSERT INTO ic_target_signals (url_hash, source, parse_outcome) VALUES ($1, $2, 'bogus')`, [`${TAG}-bogus`, TAG]), /check/i);
  });

  test('source state is one row per source with a nullable last-success watermark', async () => {
    await client.query(`INSERT INTO ic_target_source_state (source, last_attempt_at, last_status) VALUES ($1, now(), 'ok')`, [TAG]);
    await assert.rejects(client.query(`INSERT INTO ic_target_source_state (source) VALUES ($1)`, [TAG]), /unique|duplicate/i);
    const r = await client.query(`SELECT last_success_at, watermark FROM ic_target_source_state WHERE source = $1`, [TAG]);
    assert.equal(r.rows[0].last_success_at, null);
  });

  test('runs: the new counters default to zero and source_stats to an empty object', async () => {
    const r = await client.query(`INSERT INTO ic_target_runs DEFAULT VALUES RETURNING id, items_raw, items_parsed, items_unparseable, items_out_of_scope, source_stats`);
    assert.deepEqual([r.rows[0].items_raw, r.rows[0].items_parsed, r.rows[0].items_unparseable, r.rows[0].items_out_of_scope], [0, 0, 0, 0]);
    assert.deepEqual(r.rows[0].source_stats, {});
    await client.query('DELETE FROM ic_target_runs WHERE id = $1', [r.rows[0].id]);
  });

  test('the migration stays pure DDL: no DML, no send state', () => {
    assert.ok(!/\b(?:INSERT|UPDATE|DELETE)\b/i.test(SQL.replace(/--.*$/gm, '')));
    assert.ok(!/'sent'/.test(SQL));
  });
});
