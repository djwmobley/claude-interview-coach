// @ts-check
/**
 * sql/010_status_event_backfill.sql (defect 7 fix, split out of sql/009_pipeline_events_documents.sql).
 * This file is intentionally NOT part of src/core/schema.js's AUX_MIGRATIONS list -- it must only ever
 * run from `node bin/migrate.js apply` (bin/migrate.js's own MIGRATIONS list, and
 * bin/bootstrap-test-db.js's copy of that list for the isolated test database), never from
 * ensureAuxSchema()/startupDb() on every ordinary dashboard/MCP server startup. bin/run-tests.js already
 * applied this migration once during bootstrap; this file re-applies the same file's text directly to
 * prove idempotence and to exercise the corrected guard end to end. Rows carry company
 * `ZZ-TEST-MIG010-<pid>`.
 *
 * Root cause this migration fixes: the original backfill (formerly in sql/009) was guarded by NOT EXISTS
 * keyed on an exact note-text match ("no event with this exact backfill note yet"), which is not the
 * same thing as "no status event of any kind yet". Because the file carrying that guard ran on every
 * server startup via ensureAuxSchema(), any row that later acquired marked_at -- an entirely ordinary,
 * everyday event, not a one-time historical backfill case -- matched the guard again and got a spurious
 * synthetic 'migration'-actor status event. Observed in the real database: a second run of
 * bin/seed-opportunities.js wrote a spurious backfill event onto every one of that run's freshly seeded,
 * freshly marked rows, in addition to each row's own real status event, because a dashboard/MCP server
 * had started up (re-running ensureAuxSchema -> the old backfill) between the two seed runs.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { applyMark } from '../src/tools/mark_jobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '010_status_event_backfill.sql'), 'utf8');
const CO = `ZZ-TEST-MIG010-${process.pid}`;
/** @type {pg.Client} */
let client;

/** @param {Partial<{ status: string|null, marked_at: Date|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status, marked_at)
     VALUES ('Migration 010 Test', $1, $2, $3, 'listing', 'mig010 test co', 'mig010 test', 'legacy-unknown', $4, now(), $5, $6) RETURNING id`,
    [CO, `zz-test-mig010-${process.pid}`, `zz-test-mig010-${process.pid}:${n}`, `zz-mig010-hash-${n}`, o.status ?? null, o.marked_at ?? null],
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

describe('sql/010_status_event_backfill.sql', () => {
  test('a genuinely legacy row (marked_at set, no status event at all) gets exactly one backfilled status event, idempotent on re-apply', async () => {
    const markedAt = new Date('2026-05-01T00:00:00Z');
    const id = await insertListing({ status: 'shortlisted', marked_at: markedAt });
    await client.query(SQL);
    const events = await client.query(`SELECT to_status, actor, at FROM ic_job_events WHERE listing_id = $1 AND kind = 'status'`, [id]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].to_status, 'shortlisted');
    assert.equal(events.rows[0].actor, 'migration');
    assert.equal(new Date(events.rows[0].at).toISOString(), markedAt.toISOString());
    await client.query(SQL);
    const again = await client.query(`SELECT count(*)::int AS n FROM ic_job_events WHERE listing_id = $1 AND kind = 'status'`, [id]);
    assert.equal(again.rows[0].n, 1, 'idempotent: exactly one status event after two applications');
  });

  // This is the exact scenario that produced the real-database defect: a listing created and marked
  // (via applyMark, which records its own real 'status' event and sets marked_at) well after migration
  // 009/010 first ran. The corrected guard ("no status event of any kind") must never add a second,
  // synthetic event here, no matter how many times the migration is re-applied -- unlike the old
  // note-text guard, which would have matched this row every time and kept stamping a spurious one.
  test('a row with a real status event already recorded via applyMark gets no synthetic backfill event, even on repeated application', async () => {
    const id = await insertListing({ status: 'new' });
    const mark = await applyMark(client, { id, status: 'shortlisted' }, { explicit: true, now: new Date(), actor: 'dashboard' });
    assert.equal(mark.applied, true);
    const beforeCount = await client.query(`SELECT count(*)::int AS n FROM ic_job_events WHERE listing_id = $1 AND kind = 'status'`, [id]);
    assert.equal(beforeCount.rows[0].n, 1, 'sanity: applyMark itself recorded exactly one real status event');

    await client.query(SQL);
    await client.query(SQL);

    const after1 = await client.query(`SELECT count(*)::int AS n, array_agg(actor) AS actors FROM ic_job_events WHERE listing_id = $1 AND kind = 'status'`, [id]);
    assert.equal(after1.rows[0].n, 1, 'exactly one status event after two migration applications, not three');
    assert.deepEqual(after1.rows[0].actors, ['dashboard'], 'the surviving event is still applyMark\'s real one, not a migration-actor duplicate');
  });

  test('marked_at with status IS NULL gets no synthetic event (total classification: status IS NOT NULL is required)', async () => {
    const id = await insertListing({ status: null, marked_at: new Date('2026-05-01T00:00:00Z') });
    await client.query(SQL);
    const events = await client.query(`SELECT count(*)::int AS n FROM ic_job_events WHERE listing_id = $1`, [id]);
    assert.equal(events.rows[0].n, 0);
  });

  test('a row with neither a status nor marked_at gets no synthetic event', async () => {
    const id = await insertListing({ status: null });
    await client.query(SQL);
    const events = await client.query(`SELECT count(*)::int AS n FROM ic_job_events WHERE listing_id = $1`, [id]);
    assert.equal(events.rows[0].n, 0);
  });

  test('applying the whole file twice in a row raises no error (full-file idempotence)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });
});
