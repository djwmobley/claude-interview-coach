// @ts-check
/**
 * sql/026_target_decisions.sql (target finder PR4). Runs against the shared, bootstrapped test database, where
 * bin/bootstrap-test-db.js already applied 026 once; this file applies it twice more to prove idempotency, then
 * checks the new columns, the audit table's constraints and registration in all three migration lists.
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
const FILE = '026_target_decisions.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zz-test-mig026-${process.pid}`;
/** @type {pg.Client} */
let client;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(SQL);
  await client.query(SQL);
});
after(async () => {
  await client.query('DELETE FROM ic_targets WHERE company_norm = $1', [TAG]);
  await client.end();
});

/** @param {string} table @returns {Promise<string[]>} */
async function columns(table) {
  const r = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  return r.rows.map((x) => x.column_name);
}

describe('sql/026_target_decisions.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS, and bootstrap-test-db.js, after 025', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`));
    assert.ok(AUX_MIGRATIONS.includes(FILE));
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('025_target_cursors.sql'));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) < AUX_MIGRATIONS.indexOf('027_target_drafts.sql'), 'later migrations come after 026');
  });

  test('new ic_targets columns and the audit table exist', async () => {
    for (const col of ['decision_version', 'decision_reason', 'new_evidence_at', 'stale_evidence_at']) assert.ok((await columns('ic_targets')).includes(col), col);
    for (const col of ['id', 'target_id', 'actor', 'at', 'from_class', 'to_class', 'action', 'reason_code', 'note', 'decision_version']) assert.ok((await columns('ic_target_decisions')).includes(col), col);
  });

  test('decision_version defaults to 0 and is not nullable; the new timestamps default to null', async () => {
    const r = await client.query(`INSERT INTO ic_targets (company, company_norm, class, verdict_rule) VALUES ('X', $1, 'target', 'r') RETURNING id, decision_version, new_evidence_at, stale_evidence_at, decision_reason`, [TAG]);
    assert.deepEqual([r.rows[0].decision_version, r.rows[0].new_evidence_at, r.rows[0].stale_evidence_at, r.rows[0].decision_reason], [0, null, null, null]);
    await assert.rejects(client.query(`UPDATE ic_targets SET decision_version = NULL WHERE id = $1`, [r.rows[0].id]), /null value|not-null/);
  });

  test('exactly one trigger and one unique constraint, even after applying twice', async () => {
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'ic_target_decisions_no_update_trg'`)).rows[0].n, 1);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'ic_target_decisions_version_uq'`)).rows[0].n, 1);
  });

  test('deleting a target removes its audit rows (test cleanup path); updating one is refused', async () => {
    const t = await client.query(`SELECT id FROM ic_targets WHERE company_norm = $1`, [TAG]);
    const id = t.rows[0].id;
    await client.query(`INSERT INTO ic_target_decisions (target_id, action, decision_version) VALUES ($1, 'discard', 1)`, [id]);
    await assert.rejects(client.query(`UPDATE ic_target_decisions SET reason_code = 'x' WHERE target_id = $1`, [id]), /append-only/);
    await client.query(`DELETE FROM ic_targets WHERE id = $1`, [id]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ic_target_decisions WHERE target_id = $1`, [id])).rows[0].n, 0);
  });
});
