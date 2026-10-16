// @ts-check
/**
 * sql/027_target_drafts.sql (target finder PR5). Runs against the shared, bootstrapped test database, where
 * bin/bootstrap-test-db.js already applied 027 once; this file applies it twice more to prove idempotency, then
 * checks the new draft columns, the state and origin vocabularies, the uniqueness that backs the cap and the
 * single regeneration, the append-only edits table and the new audit action.
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
const FILE = '027_target_drafts.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zz-test-mig027-${process.pid}`;
/** @type {pg.Client} */
let client;
let targetId = 0;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query(SQL);
  await client.query(SQL);
  targetId = (await client.query(`INSERT INTO ic_targets (company, company_norm, class, verdict_rule) VALUES ('X', $1, 'target', 'r') RETURNING id`, [TAG])).rows[0].id;
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

describe('sql/027_target_drafts.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS and bootstrap-test-db.js, last after 026', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`));
    assert.ok(AUX_MIGRATIONS.includes(FILE));
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('026_target_decisions.sql'));
    assert.equal(AUX_MIGRATIONS.at(-1), FILE);
  });

  test('the new columns and the edits table exist', async () => {
    for (const col of ['attempt', 'origin', 'regen_of', 'cap_day', 'evidence_ids', 'sentences', 'fail_codes', 'draft_version', 'text_hash', 'edited', 'approved_at']) {
      assert.ok((await columns('ic_target_drafts')).includes(col), col);
    }
    for (const col of ['id', 'draft_id', 'actor', 'at', 'before', 'after']) assert.ok((await columns('ic_target_draft_edits')).includes(col), col);
  });

  test('defaults: attempt 1, origin auto_first, version 0, not edited, empty codes and evidence', async () => {
    const r = await client.query(`INSERT INTO ic_target_drafts (target_id) VALUES ($1) RETURNING attempt, origin, draft_version, edited, fail_codes, evidence_ids, state, cap_day`, [targetId]);
    assert.deepEqual(r.rows[0], { attempt: 1, origin: 'auto_first', draft_version: 0, edited: false, fail_codes: [], evidence_ids: [], state: 'draft', cap_day: null });
    await client.query('DELETE FROM ic_target_drafts WHERE target_id = $1', [targetId]);
  });

  test('state vocabulary: queued is accepted, an unknown state is refused', async () => {
    await client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, cap_day) VALUES ($1, 'queued', 'manual', '2031-01-01')`, [targetId]);
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, cap_day) VALUES ($1, 'sent', 'manual', '2031-01-01')`, [targetId]), /check/i);
    await client.query('DELETE FROM ic_target_drafts WHERE target_id = $1', [targetId]);
  });

  test('origin vocabulary; an automatic regeneration never carries a cap day', async () => {
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, origin) VALUES ($1, 'robot')`, [targetId]), /check/i);
    const parent = (await client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, cap_day) VALUES ($1, 'gate_failed', 'auto_first', '2031-01-01') RETURNING id`, [targetId])).rows[0].id;
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, regen_of, cap_day) VALUES ($1, 'queued', 'auto_regen', $2, '2031-01-01')`, [targetId, parent]), /check/i);
    await client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, regen_of, attempt) VALUES ($1, 'gate_failed', 'auto_regen', $2, 2)`, [targetId, parent]);
    await client.query('DELETE FROM ic_target_drafts WHERE target_id = $1', [targetId]);
  });

  test('one first attempt per target, one regeneration per draft, one live draft per target', async () => {
    const a = (await client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, cap_day) VALUES ($1, 'gate_failed', 'auto_first', '2031-01-01') RETURNING id`, [targetId])).rows[0].id;
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, cap_day) VALUES ($1, 'gate_failed', 'auto_first', '2031-01-02')`, [targetId]), /duplicate key/);
    await client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, regen_of, attempt) VALUES ($1, 'gate_failed', 'auto_regen', $2, 2)`, [targetId, a]);
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, regen_of, attempt) VALUES ($1, 'gate_failed', 'auto_regen', $2, 2)`, [targetId, a]), /duplicate key/);
    await client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, cap_day) VALUES ($1, 'queued', 'manual', '2031-01-03')`, [targetId]);
    await assert.rejects(client.query(`INSERT INTO ic_target_drafts (target_id, state, origin, cap_day) VALUES ($1, 'awaiting_approval', 'manual', '2031-01-03')`, [targetId]), /duplicate key/);
    await client.query('DELETE FROM ic_target_drafts WHERE target_id = $1', [targetId]);
  });

  test('edits are append-only and cascade with their draft; the actor is the literal damian', async () => {
    const d = (await client.query(`INSERT INTO ic_target_drafts (target_id) VALUES ($1) RETURNING id`, [targetId])).rows[0].id;
    await client.query(`INSERT INTO ic_target_draft_edits (draft_id, before, after) VALUES ($1, '{}'::jsonb, '{"a":1}'::jsonb)`, [d]);
    await assert.rejects(client.query(`UPDATE ic_target_draft_edits SET after = '{}'::jsonb WHERE draft_id = $1`, [d]), /append-only/);
    await assert.rejects(client.query(`INSERT INTO ic_target_draft_edits (draft_id, actor, before, after) VALUES ($1, 'mallory', '{}'::jsonb, '{}'::jsonb)`, [d]), /check/i);
    await client.query('DELETE FROM ic_target_drafts WHERE id = $1', [d]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ic_target_draft_edits WHERE draft_id = $1`, [d])).rows[0].n, 0);
  });

  test('the audit table accepts the approve action and still refuses unknown ones', async () => {
    await client.query(`INSERT INTO ic_target_decisions (target_id, action, decision_version) VALUES ($1, 'approve', 1)`, [targetId]);
    await assert.rejects(client.query(`INSERT INTO ic_target_decisions (target_id, action, decision_version) VALUES ($1, 'send', 2)`, [targetId]), /check/i);
    await client.query('DELETE FROM ic_target_decisions WHERE target_id = $1', [targetId]).catch(() => {});
  });

  test('exactly one trigger and one of each named constraint, even after applying three times', async () => {
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'ic_target_draft_edits_no_update_trg'`)).rows[0].n, 1);
    for (const name of ['ic_target_drafts_origin_chk', 'ic_target_drafts_claim_chk', 'ic_target_drafts_state_v2_chk', 'ic_target_decisions_action_v2_chk']) {
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1`, [name])).rows[0].n, 1, name);
    }
    const old = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'ic_target_drafts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%awaiting_approval%'`);
    assert.deepEqual(old.rows.map((x) => x.conname), ['ic_target_drafts_state_v2_chk']);
  });
});
