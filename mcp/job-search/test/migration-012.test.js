// @ts-check
/**
 * sql/012_applications.sql (apply pipeline slice 1). bin/run-tests.js already applied this migration
 * once during bootstrap (bin/bootstrap-test-db.js's MIGRATIONS list); this file re-applies the same
 * file's text directly to prove idempotence and exercises every constraint it adds end to end, following
 * test/migration-011.test.js's own pattern for the analogous ic_job_events.actor widen.
 *
 * Covers: the two new tables and their indexes/CHECK constraints, the partial unique index on
 * ic_job_applications.listing_id, and the further widen of ic_job_events.kind/actor (every pre-existing
 * value from sql/009 and sql/011 must still insert, plus the two new ones).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', '012_applications.sql'), 'utf8');
const CO = `ZZ-TEST-MIG012-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

/** @param {Partial<{ status: string|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status)
     VALUES ('Migration 012 Test', $1, $2, $3, 'listing', 'mig012 test co', 'mig012 test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-test-mig012-${process.pid}`, `zz-test-mig012-${process.pid}:${n}`, `zz-mig012-hash-${n}`, o.status ?? null],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {string} kind @param {string} actor @param {number} listingId */
async function insertEventRow(kind, actor, listingId) {
  await client.query(`INSERT INTO ic_job_events (listing_id, kind, to_status, actor) VALUES ($1, $2, 'new', $3)`, [listingId, kind, actor]);
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await cleanup();
  // Belt and braces, matching migration-011.test.js's own defensive re-apply before its tests: safe no-op
  // or widen, never a narrow, so it can never race a concurrently running test file.
  await client.query(SQL);
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('sql/012_applications.sql: tables and indexes', () => {
  test('ic_job_applications and ic_job_application_events exist with their indexes', async () => {
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ic_job_applications','ic_job_application_events')`,
    );
    assert.equal(tables.rowCount, 2);
    const idx = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('ic_job_applications','ic_job_application_events')`);
    const names = idx.rows.map((r) => r.indexname);
    assert.ok(names.includes('ic_job_applications_listing_active_uq'));
    assert.ok(names.includes('ic_job_applications_listing_idx'));
    assert.ok(names.includes('ic_job_applications_state_idx'));
    assert.ok(names.includes('ic_job_application_events_application_id_idx'));
  });

  test('applying the file twice in a row raises no error (idempotent)', async () => {
    await client.query(SQL);
    await client.query(SQL);
  });
});

describe('ic_job_applications.state / ats_type CHECK constraints', () => {
  test('every APPLICATION_STATES value is accepted; a bogus one is rejected', async () => {
    const listingId = await insertListing();
    for (const state of ['drafting', 'docs_ready', 'approved', 'submitting', 'submitted', 'confirmed', 'failed', 'needs_human', 'withdrawn']) {
      const r = await client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, $2) RETURNING id`, [listingId, state]);
      await client.query('DELETE FROM ic_job_applications WHERE id = $1', [r.rows[0].id]);
    }
    await assert.rejects(
      client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'bogus-state')`, [listingId]),
      /violates check constraint/i,
    );
  });

  test('every ATS_TYPES value is accepted; a bogus one is rejected', async () => {
    const listingId = await insertListing();
    for (const ats of ['greenhouse', 'lever', 'workday', 'dayforce', 'indeed_easy', 'linkedin_easy', 'icims', 'smartrecruiters', 'unknown']) {
      const r = await client.query(`INSERT INTO ic_job_applications (listing_id, ats_type) VALUES ($1, $2) RETURNING id`, [listingId, ats]);
      await client.query('DELETE FROM ic_job_applications WHERE id = $1', [r.rows[0].id]);
    }
    await assert.rejects(
      client.query(`INSERT INTO ic_job_applications (listing_id, ats_type) VALUES ($1, 'bogus-ats')`, [listingId]),
      /violates check constraint/i,
    );
  });

  test('defaults: state defaults to drafting, ats_type defaults to unknown', async () => {
    const listingId = await insertListing();
    const r = await client.query(`INSERT INTO ic_job_applications (listing_id) VALUES ($1) RETURNING state, ats_type, attempt`, [listingId]);
    assert.equal(r.rows[0].state, 'drafting');
    assert.equal(r.rows[0].ats_type, 'unknown');
    assert.equal(r.rows[0].attempt, 0);
  });
});

describe('ic_job_applications partial unique index (listing_id WHERE state <> withdrawn)', () => {
  test('a second active application for the same listing is rejected', async () => {
    const listingId = await insertListing();
    await client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'drafting')`, [listingId]);
    await assert.rejects(
      client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'docs_ready')`, [listingId]),
      /duplicate key value violates unique constraint/i,
    );
  });

  test('a withdrawn application does not block a fresh active one for the same listing', async () => {
    const listingId = await insertListing();
    await client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'withdrawn')`, [listingId]);
    const r = await client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'drafting') RETURNING id`, [listingId]);
    assert.ok(r.rows[0].id);
    // A second active row is still rejected even with a withdrawn row also present.
    await assert.rejects(
      client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'approved')`, [listingId]),
      /duplicate key value violates unique constraint/i,
    );
  });
});

describe('ic_job_application_events CHECK constraints', () => {
  test('every APPLICATION_EVENT_KINDS value and every actor value is accepted; bogus values are rejected', async () => {
    const listingId = await insertListing();
    const appRow = await client.query(`INSERT INTO ic_job_applications (listing_id) VALUES ($1) RETURNING id`, [listingId]);
    const appId = appRow.rows[0].id;
    for (const kind of ['state', 'note', 'error', 'progress']) {
      await client.query(`INSERT INTO ic_job_application_events (application_id, kind, actor) VALUES ($1, $2, 'apply')`, [appId, kind]);
    }
    for (const actor of ['dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto', 'apply']) {
      await client.query(`INSERT INTO ic_job_application_events (application_id, kind, actor) VALUES ($1, 'note', $2)`, [appId, actor]);
    }
    await assert.rejects(
      client.query(`INSERT INTO ic_job_application_events (application_id, kind, actor) VALUES ($1, 'bogus-kind', 'apply')`, [appId]),
      /violates check constraint/i,
    );
    await assert.rejects(
      client.query(`INSERT INTO ic_job_application_events (application_id, kind, actor) VALUES ($1, 'note', 'bogus-actor')`, [appId]),
      /violates check constraint/i,
    );
  });

  test('deleting the application cascades to its events', async () => {
    const listingId = await insertListing();
    const appRow = await client.query(`INSERT INTO ic_job_applications (listing_id) VALUES ($1) RETURNING id`, [listingId]);
    const appId = appRow.rows[0].id;
    await client.query(`INSERT INTO ic_job_application_events (application_id, kind, actor) VALUES ($1, 'note', 'apply')`, [appId]);
    await client.query('DELETE FROM ic_job_applications WHERE id = $1', [appId]);
    const remaining = await client.query('SELECT id FROM ic_job_application_events WHERE application_id = $1', [appId]);
    assert.equal(remaining.rowCount, 0);
  });
});

describe('ic_job_events widened further: kind accepts "application", actor accepts "apply"', () => {
  test('a kind="application" row and an actor="apply" row are both accepted', async () => {
    const listingId = await insertListing();
    await insertEventRow('application', 'apply', listingId);
  });

  test('every pre-existing kind value is still accepted', async () => {
    const listingId = await insertListing();
    for (const kind of ['status', 'note', 'fit', 'created', 'document', 'followup', 'reply', 'migrated']) {
      await assert.doesNotReject(insertEventRow(kind, 'mcp', listingId), `kind="${kind}" must still be accepted`);
    }
  });

  test('every pre-existing actor value is still accepted', async () => {
    const listingId = await insertListing();
    for (const actor of ['dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto']) {
      await assert.doesNotReject(insertEventRow('status', actor, listingId), `actor="${actor}" must still be accepted`);
    }
  });

  test('a genuinely bogus kind or actor is still rejected (widened, not dropped)', async () => {
    const listingId = await insertListing();
    await assert.rejects(insertEventRow('not-a-real-kind', 'mcp', listingId), /violates check constraint/i);
    await assert.rejects(insertEventRow('status', 'not-a-real-actor', listingId), /violates check constraint/i);
  });

  test('the widened constraints are named as expected and exactly one CHECK covers each column', async () => {
    const kindConstraints = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'ic_job_events' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%kind%'
    `);
    assert.equal(kindConstraints.rowCount, 1);
    assert.equal(kindConstraints.rows[0].conname, 'ic_job_events_kind_application_check');

    const actorConstraints = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'ic_job_events' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%actor%'
    `);
    assert.equal(actorConstraints.rowCount, 1);
    assert.equal(actorConstraints.rows[0].conname, 'ic_job_events_actor_apply_check');
  });
});
