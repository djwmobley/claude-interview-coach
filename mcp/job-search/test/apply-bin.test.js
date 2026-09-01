// @ts-check
/**
 * bin/apply.js (apply pipeline slice 5): --application/--run-marker/--json argument parsing, and the
 * startup credential-resume sweep (plan section 5a's "on startup it also checks every needs_human
 * application ... and resumes those whose credential now exists"), against the real isolated test DB.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, transition, getApplication } from '../src/core/applications.js';
import { parseArgs, resumeCredentialReadyApplications } from '../bin/apply.js';

describe('parseArgs', () => {
  test('parses --application, --run-marker, and a bare --json', () => {
    const out = parseArgs(['--application', '42', '--run-marker', '/tmp/x.marker', '--json']);
    assert.equal(out.application, 42);
    assert.equal(out.runMarker, '/tmp/x.marker');
    assert.equal(out.json, null);
  });

  test('parses --json <file>', () => {
    const out = parseArgs(['--application', '1', '--json', 'out.json']);
    assert.equal(out.json, 'out.json');
  });

  test('--help sets help', () => {
    assert.equal(parseArgs(['--help']).help, true);
  });

  test('missing --application leaves it null', () => {
    assert.equal(parseArgs([]).application, null);
  });
});

describe('resumeCredentialReadyApplications', () => {
  const CO = `ZZ-TEST-APPLYBIN-${process.pid}`;
  /** @type {pg.Client} */
  let client;
  /** @type {number[]} */
  const listingIds = [];

  async function seedListing() {
    const n = Math.floor(Math.random() * 1e9);
    const r = await client.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
       VALUES ('Apply Bin Test', $1, $2, $3, 'listing', 'apply bin test co', 'apply bin test', 'legacy-unknown', $4, now()) RETURNING id`,
      [CO, `zz-test-applybin-${process.pid}`, `zz-test-applybin-${process.pid}:${n}`, `zz-applybin-hash-${n}`],
    );
    const id = Number(r.rows[0].id);
    listingIds.push(id);
    return id;
  }

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await ensureAuxSchema(client);
  });
  after(async () => {
    if (listingIds.length) {
      await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
      await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
      await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
      await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
    }
    await client.end();
  });

  test('resumes a needs_human/credential application whose credential now exists', async () => {
    const listingId = await seedListing();
    const created = await createApplication(client, { listingId, actor: 'mcp' });
    await transition(client, created.id, 'needs_human', { actor: 'apply', pending_question: { kind: 'credential', target: 'ic-jobsearch/boards.greenhouse.io', username: 'a@b.com' } });
    const fakeCredentials = { read: async (target) => (target === 'ic-jobsearch/boards.greenhouse.io' ? { username: 'a@b.com', password: 'pw' } : null) };
    const resumed = await resumeCredentialReadyApplications(client, fakeCredentials, () => {});
    assert.equal(resumed, 1);
    const row = await getApplication(client, created.id);
    assert.equal(row.state, 'approved');
  });

  test('leaves a credential-missing application untouched and never throws', async () => {
    const listingId = await seedListing();
    const created = await createApplication(client, { listingId, actor: 'mcp' });
    await transition(client, created.id, 'needs_human', { actor: 'apply', pending_question: { kind: 'credential', target: 'ic-jobsearch/still-missing.test', username: 'a@b.com' } });
    const fakeCredentials = { read: async () => null };
    const resumed = await resumeCredentialReadyApplications(client, fakeCredentials, () => {});
    assert.equal(resumed, 0);
    const row = await getApplication(client, created.id);
    assert.equal(row.state, 'needs_human');
  });
});
