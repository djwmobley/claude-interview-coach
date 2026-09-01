// @ts-check
/**
 * sql/011_triage_actor.sql (slice 3 auto-triage, docs/slice3-auto-triage-spec.md section 8): widens
 * ic_job_events.actor's CHECK constraint to accept 'auto'. Pure idempotent DDL, following the exact
 * pattern test/migration-009.test.js already uses for the analogous ic_scan_runs.trigger widen: assert
 * the widened state (already applied once by bin/bootstrap-test-db.js's MIGRATIONS list, per finding 12)
 * accepts 'auto' and still rejects a genuinely bogus value, and that re-applying the file is a no-op.
 *
 * Deliberately never narrows the constraint back to its pre-migration shape to "test the before state":
 * `node --test` runs files in parallel, and test/triage.test.js in this same suite inserts real
 * actor='auto' events concurrently -- narrowing the shared constraint mid-suite here would race that
 * file's inserts. migration-009.test.js's own test for the analogous trigger widen follows the same
 * rule (see its "ic_scan_runs.trigger accepts dashboard" test): assert the current, already-migrated
 * state, never roll the shared schema backward.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '011_triage_actor.sql'), 'utf8');
const CO = `ZZ-TEST-MIG011-${process.pid}`;
/** @type {pg.Client} */
let client;

/** @param {string} actor */
async function insertEventRow(actor) {
  const n = Math.floor(Math.random() * 1e9);
  const listing = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Migration 011 Test', $1, $2, $3, 'listing', 'mig011 test co', 'mig011 test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-mig011-${process.pid}`, `zz-test-mig011-${process.pid}:${n}`, `zz-mig011-hash-${n}`],
  );
  const listingId = Number(listing.rows[0].id);
  await client.query(`INSERT INTO ic_job_events (listing_id, kind, to_status, actor) VALUES ($1, 'status', 'new', $2)`, [listingId, actor]);
  return listingId;
}

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [CO])).rows.map((r) => r.id);
  if (ids.length === 0) return;
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await cleanup();
  // Ensure the widened constraint is present regardless of bootstrap ordering (belt and braces: this
  // file's own responsibility for its own coverage, matching migration-010.test.js's own defensive
  // CREATE TABLE IF NOT EXISTS before its ledger tests). Applying it is always a safe no-op or a widen,
  // never a narrow, so this can never race a concurrently running test file.
  await client.query(SQL);
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('sql/011_triage_actor.sql', () => {
  test('an actor="auto" row is accepted', async () => {
    const id = await insertEventRow('auto');
    const row = await client.query('SELECT actor FROM ic_job_events WHERE listing_id = $1', [id]);
    assert.equal(row.rows[0].actor, 'auto');
  });

  test('every pre-existing actor value is still accepted', async () => {
    for (const actor of ['dashboard', 'mcp', 'cli', 'migration', 'seed']) {
      await assert.doesNotReject(insertEventRow(actor), `actor="${actor}" must still be accepted`);
    }
  });

  test('a genuinely bogus actor value is still rejected (the CHECK is widened, not dropped)', async () => {
    await assert.rejects(insertEventRow('not-a-real-actor'), /violates check constraint/i);
  });

  test('applying the file twice in a row raises no error (idempotent)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });

  test('the constraint is named ic_job_events_actor_auto_check and there is exactly one CHECK constraint on actor', async () => {
    await client.query(SQL);
    const constraints = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'ic_job_events' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%actor%'
    `);
    assert.equal(constraints.rowCount, 1);
    assert.equal(constraints.rows[0].conname, 'ic_job_events_actor_auto_check');
  });
});
