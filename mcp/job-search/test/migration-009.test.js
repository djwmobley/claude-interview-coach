// @ts-check
/**
 * sql/009_pipeline_events_documents.sql (dashboard PR 1) against the isolated test DB. bin/run-tests.js
 * already applied this migration once during bootstrap (bin/bootstrap-test-db.js's MIGRATIONS list); this
 * file re-applies the same file's text directly to prove idempotence, and exercises the legacy 'active'
 * remap and marked_at backfill passes end to end. Rows carry company `ZZ-TEST-MIG009-<pid>`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '009_pipeline_events_documents.sql'), 'utf8');
const CO = `ZZ-TEST-MIG009-${process.pid}`;
/** @type {pg.Client} */
let client;

/** @param {Partial<{ status: string|null, marked_at: Date|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status, marked_at)
     VALUES ('Migration 009 Test', $1, $2, $3, 'listing', 'mig009 test co', 'mig009 test', 'legacy-unknown', $4, now(), $5, $6) RETURNING id`,
    [CO, `zz-test-mig009-${process.pid}`, `zz-test-mig009-${process.pid}:${n}`, `zz-mig009-hash-${n}`, o.status ?? null, o.marked_at ?? null],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [CO])).rows.map((r) => r.id);
  if (ids.length === 0) return;
  await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('sql/009_pipeline_events_documents.sql', () => {
  test('tables, indexes, and the widened trigger CHECK exist after bootstrap (applied once already)', async () => {
    const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ic_job_events','ic_job_documents')`);
    assert.equal(tables.rowCount, 2);
    const idx = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('ic_job_events','ic_job_documents')`);
    const idxNames = idx.rows.map((r) => r.indexname);
    assert.ok(idxNames.includes('ic_job_events_listing_at_idx'));
    assert.ok(idxNames.includes('ic_job_events_at_idx'));
    assert.ok(idxNames.includes('ic_job_documents_listing_idx'));
    const unique = await client.query(`SELECT conname FROM pg_constraint WHERE conname LIKE '%ic_job_documents%listing_id%rel_path%' OR conname = 'ic_job_documents_listing_id_rel_path_key'`);
    assert.ok(unique.rowCount >= 1, 'UNIQUE(listing_id, rel_path) constraint exists');
  });

  test('ic_scan_runs.trigger accepts dashboard alongside mcp and cli', async () => {
    const r = await client.query(
      `INSERT INTO ic_scan_runs (profile, trigger, status) VALUES ('zz-test-mig009', 'dashboard', 'ok') RETURNING id`,
    );
    await client.query('DELETE FROM ic_scan_runs WHERE id = $1', [r.rows[0].id]);
    await assert.rejects(
      client.query(`INSERT INTO ic_scan_runs (profile, trigger, status) VALUES ('zz-test-mig009', 'bogus', 'ok')`),
      /violates check constraint/,
    );
  });

  test('legacy active status remaps to applied with a migrated event, idempotent on re-apply', async () => {
    const id = await insertListing({ status: 'active' });
    await client.query(SQL);
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [id])).rows[0];
    assert.equal(row.status, 'applied');
    const events = await client.query(`SELECT kind, from_status, to_status, actor, note FROM ic_job_events WHERE listing_id = $1 AND kind = 'migrated'`, [id]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].from_status, 'active');
    assert.equal(events.rows[0].to_status, 'applied');
    assert.equal(events.rows[0].actor, 'migration');
    // Re-apply: no more 'active' rows exist, and the note-text guard prevents a second migrated event.
    await client.query(SQL);
    const again = await client.query(`SELECT count(*)::int AS n FROM ic_job_events WHERE listing_id = $1 AND kind = 'migrated'`, [id]);
    assert.equal(again.rows[0].n, 1, 'idempotent: exactly one migrated event after two applications');
  });

  test('marked_at rows get exactly one backfilled status event, idempotent on re-apply', async () => {
    const markedAt = new Date('2026-05-01T00:00:00Z');
    const id = await insertListing({ status: 'shortlisted', marked_at: markedAt });
    await client.query(SQL);
    const events = await client.query(`SELECT to_status, actor, at FROM ic_job_events WHERE listing_id = $1 AND kind = 'status' AND note = 'backfilled from marked_at by migration 009'`, [id]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].to_status, 'shortlisted');
    assert.equal(events.rows[0].actor, 'migration');
    assert.equal(new Date(events.rows[0].at).toISOString(), markedAt.toISOString());
    await client.query(SQL);
    const again = await client.query(`SELECT count(*)::int AS n FROM ic_job_events WHERE listing_id = $1 AND kind = 'status' AND note = 'backfilled from marked_at by migration 009'`, [id]);
    assert.equal(again.rows[0].n, 1, 'idempotent: exactly one backfilled event after two applications');
  });

  test('a row with neither a legacy active status nor marked_at gets no synthetic event', async () => {
    const id = await insertListing({ status: 'new' });
    await client.query(SQL);
    const events = await client.query(`SELECT count(*)::int AS n FROM ic_job_events WHERE listing_id = $1`, [id]);
    assert.equal(events.rows[0].n, 0);
  });

  test('applying the whole file twice in a row end to end raises no error (full-file idempotence)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });
});
