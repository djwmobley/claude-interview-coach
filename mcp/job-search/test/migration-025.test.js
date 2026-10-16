// @ts-check
/**
 * sql/025_target_cursors.sql (target finder PR3). Runs against the shared, bootstrapped test database (the
 * pgConnectionConfig() guard refuses any database not ending in _test), where bin/bootstrap-test-db.js
 * already applied 025 once; this file applies it a SECOND time to prove idempotency, then checks the new
 * columns, the widened status CHECK, and registration in all three migration lists.
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
const FILE = '025_target_cursors.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zz-test-mig025-${process.pid}`;
/** @type {pg.Client} */
let client;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(SQL);
  await client.query(SQL);
});
after(async () => {
  await client.query('DELETE FROM ic_target_runs WHERE trigger = $1', [TAG]);
  await client.query('DELETE FROM ic_target_source_state WHERE source = $1', [TAG]);
  await client.end();
});

/** @param {string} table @returns {Promise<string[]>} */
async function columns(table) {
  const r = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  return r.rows.map((x) => x.column_name);
}

describe('sql/025_target_cursors.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS, and bootstrap-test-db.js, after 024', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`));
    assert.ok(AUX_MIGRATIONS.includes(FILE));
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('024_target_sources.sql'));
  });

  test('new columns exist', async () => {
    for (const c of ['cursor_date', 'cursor_detail']) assert.ok((await columns('ic_target_source_state')).includes(c), c);
    for (const c of ['trigger', 'heartbeat_at', 'coverage', 'skip_reasons', 'backlog']) assert.ok((await columns('ic_target_runs')).includes(c), c);
  });

  test('the status CHECK accepts skipped_locked and still refuses anything else', async () => {
    const ins = (/** @type {string} */ status) => client.query(`INSERT INTO ic_target_runs (status, trigger) VALUES ($1, $2) RETURNING id`, [status, TAG]);
    for (const s of ['running', 'ok', 'failed', 'partial', 'skipped_locked']) await ins(s);
    await assert.rejects(ins('skipped'), /ic_target_runs_status_chk|check constraint/);
    await assert.rejects(ins('whatever'), /check constraint/);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN ('ic_target_runs_status_check', 'ic_target_runs_status_chk')`)).rows[0].n, 1, 'exactly one status constraint');
  });

  test('cursor columns round trip', async () => {
    await client.query(`INSERT INTO ic_target_source_state (source, cursor_date, cursor_detail) VALUES ($1, '2026-10-13', '{"config_hash":"h"}'::jsonb)`, [TAG]);
    const r = await client.query(`SELECT to_char(cursor_date, 'YYYY-MM-DD') AS d, cursor_detail FROM ic_target_source_state WHERE source = $1`, [TAG]);
    assert.deepEqual([r.rows[0].d, r.rows[0].cursor_detail], ['2026-10-13', { config_hash: 'h' }]);
    const def = await client.query(`SELECT cursor_detail FROM (SELECT '{}'::jsonb AS cursor_detail) x`);
    assert.deepEqual(def.rows[0].cursor_detail, {});
  });

  test('a running row defaults: heartbeat_at is null until set, coverage and backlog default to {}', async () => {
    const r = await client.query(`INSERT INTO ic_target_runs (status, trigger) VALUES ('running', $1) RETURNING heartbeat_at, coverage, skip_reasons, backlog`, [TAG]);
    assert.deepEqual([r.rows[0].heartbeat_at, r.rows[0].coverage, r.rows[0].skip_reasons, r.rows[0].backlog], [null, {}, {}, {}]);
  });
});
