// @ts-check
/**
 * src/core/manual.js (dashboard PR 1, plan line 56) against the real ic_context test DB. Rows carry
 * company `ZZ-TEST-MANUAL-<pid>` and are deleted afterwards.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createManualListing } from '../src/core/manual.js';
import { listEvents } from '../src/core/events.js';

const CO = `ZZ-TEST-MANUAL-${process.pid} Co`;
/** @type {pg.Client} */
let client;

async function cleanup() {
  const ids = (await client.query(`SELECT id FROM ic_job_listings WHERE company ILIKE $1`, [`%${CO}%`])).rows.map((r) => r.id);
  if (ids.length === 0) return;
  await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('createManualListing', () => {
  test('requires title and company', async () => {
    await assert.rejects(createManualListing(client, { title: '', company: CO }), /title/);
    await assert.rejects(createManualListing(client, { title: 'CTO', company: '' }), /company/);
  });

  test('creates a new row via the real dedup path, noise_class ok_manual, notes/fit forced NULL, created then status events', async () => {
    const out = await createManualListing(client, { title: 'CTO', company: CO, location: 'Houston, TX', status: 'interviewing', via: 'Maren Holloway' });
    assert.equal(out.created, true);
    assert.ok(out.id);
    const row = (await client.query('SELECT status, notes, fit_score, noise_class, source, external_id, record_kind FROM ic_job_listings WHERE id = $1', [out.id])).rows[0];
    assert.equal(row.status, 'interviewing');
    assert.equal(row.notes, null);
    assert.equal(row.fit_score, null);
    assert.equal(row.noise_class, 'ok_manual');
    assert.equal(row.source, 'manual');
    assert.ok(row.external_id.startsWith('manual:'));
    assert.equal(row.record_kind, 'listing');
    const events = await listEvents(client, out.id, { limit: 10 });
    const created = events.find((e) => e.kind === 'created');
    assert.ok(created);
    assert.equal(created.note, 'via Maren Holloway');
    const status = events.find((e) => e.kind === 'status');
    assert.ok(status);
    assert.equal(status.to_status, 'interviewing');
    assert.equal(status.from_status, null);
  });

  test('defaults status to new when omitted; via omitted leaves a generic created note', async () => {
    const out = await createManualListing(client, { title: 'VP Engineering', company: `${CO} B` });
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [out.id])).rows[0];
    assert.equal(row.status, 'new');
    const events = await listEvents(client, /** @type {number} */ (out.id), { limit: 10 });
    assert.ok(events.some((e) => e.kind === 'created' && e.note === 'manual entry'));
  });

  test('a null status is honored as untriaged and writes no status event', async () => {
    const out = await createManualListing(client, { title: 'COO', company: `${CO} C`, status: null });
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [out.id])).rows[0];
    assert.equal(row.status, null);
    const events = await listEvents(client, /** @type {number} */ (out.id), { limit: 10 });
    assert.ok(!events.some((e) => e.kind === 'status'));
  });

  test('a near-duplicate is refused with 409-style candidates unless force; force still creates and queues for review', async () => {
    const first = await createManualListing(client, { title: 'Director of Operations', company: `${CO} D`, location: 'Houston, TX', status: 'new' });
    const dup = await createManualListing(client, { title: 'Director of Operations', company: `${CO} D`, location: 'Houston, TX' });
    assert.equal(dup.created, false);
    assert.equal(dup.id, null);
    assert.ok(dup.candidates.length >= 1);
    const forced = await createManualListing(client, { title: 'Director of Operations', company: `${CO} D`, location: 'Houston, TX', status: 'new' }, { force: true });
    assert.equal(forced.created, true);
    assert.notEqual(forced.id, first.id);
    const queued = await client.query('SELECT reason FROM ic_job_review_queue WHERE candidate_id = $1', [forced.id]);
    assert.equal(queued.rows[0].reason, 'manual_duplicate_forced');
  });

  test('a real job-board URL dedups the same way a scanned row would (external_id from the URL, not fabricated)', async () => {
    // A distinctive title (title_norm shared with no other row in this file, including the acronym-
    // expanded 'CTO' from the earlier test above) so this row's own dedup check never fuzzy-matches a
    // sibling test's row here: every fixture company in this file shares the long 'ZZ-TEST-MANUAL-<pid>'
    // prefix (needed for the ILIKE cleanup at the bottom of this file), which makes them ALL pg_trgm-
    // similar to each other regardless of suffix -- so title_norm, not company, is what has to be unique
    // per row whenever more than one is expected to classify as 'new'.
    const out = await createManualListing(client, {
      title: 'Head of Platform Engineering',
      company: `${CO} E`,
      url: 'https://boards.greenhouse.io/examplecoE/jobs/123456',
    });
    assert.equal(out.created, true, `expected a fresh row, got ${JSON.stringify(out)}`);
    const row = (await client.query('SELECT external_id, url_normalized FROM ic_job_listings WHERE id = $1', [out.id])).rows[0];
    assert.equal(row.external_id, 'greenhouse:examplecoe/123456');
    assert.ok(row.url_normalized.includes('boards.greenhouse.io'));
  });

  test('actor defaults to mcp on both events; a caller can override it', async () => {
    const out = await createManualListing(client, { title: 'Advisor', company: `${CO} F`, status: 'maybe' }, { actor: 'dashboard' });
    const events = await listEvents(client, /** @type {number} */ (out.id), { limit: 10 });
    assert.ok(events.every((e) => e.actor === 'dashboard'));
  });
});
