// @ts-check
/**
 * src/core/events.js (dashboard PR 1) against the real ic_context test DB. Rows carry company
 * `ZZ-TEST-EVENTS-<pid>` and are deleted afterwards.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { recordEvent, listEvents, recentEvents, EVENT_KINDS, EVENT_ACTORS } from '../src/core/events.js';

const SRC = `zz-test-events-${process.pid}`;
const CO = `ZZ-TEST-EVENTS-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number} */
let listingId;

async function insert() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Events Test', $1, $2, $3, 'listing', 'events test co', 'events test', 'legacy-unknown', 'zz-events-hash', now()) RETURNING id`,
    [CO, SRC, `${SRC}:${n}`],
  );
  return Number(r.rows[0].id);
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
  await ensureAuxSchema(client);
  await cleanup();
  listingId = await insert();
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('recordEvent: closed kind/actor lists, total classification', () => {
  test('rejects an unknown kind or actor before touching the database', async () => {
    await assert.rejects(recordEvent(client, { listingId, kind: /** @type {any} */ ('bogus') }), /event kind/);
    await assert.rejects(recordEvent(client, { listingId, kind: 'status', actor: /** @type {any} */ ('robot') }), /event actor/);
    await assert.rejects(recordEvent(client, { listingId: /** @type {any} */ (undefined), kind: 'status' }), /listingId/);
  });

  test('defaults actor to mcp and at to now(); every EVENT_KINDS value round-trips', async () => {
    const before = new Date();
    const row = await recordEvent(client, { listingId, kind: 'note', note: 'hello' });
    assert.equal(row.actor, 'mcp');
    assert.ok(new Date(row.at).getTime() >= before.getTime() - 1000);
    for (const kind of EVENT_KINDS) {
      const r = await recordEvent(client, { listingId, kind, actor: 'seed' });
      assert.equal(r.kind, kind);
    }
    for (const actor of EVENT_ACTORS) {
      const r = await recordEvent(client, { listingId, kind: 'status', actor });
      assert.equal(r.actor, actor);
    }
  });

  test('an explicit at is honored (seed replay uses this)', async () => {
    const at = new Date('2026-03-18T00:00:00Z');
    const row = await recordEvent(client, { listingId, kind: 'status', toStatus: 'applied', actor: 'seed', at });
    assert.equal(new Date(row.at).toISOString(), at.toISOString());
  });
});

describe('listEvents / recentEvents', () => {
  test('listEvents returns most-recent-first for one listing, respects limit', async () => {
    const otherId = await insert();
    await recordEvent(client, { listingId: otherId, kind: 'created', actor: 'mcp' });
    const rows = await listEvents(client, listingId, { limit: 3 });
    assert.equal(rows.length, 3);
    for (let i = 1; i < rows.length; i++) assert.ok(new Date(rows[i - 1].at).getTime() >= new Date(rows[i].at).getTime());
    assert.ok(rows.every((r) => r.listing_id === listingId), 'never leaks another listing\'s events');
  });

  test('recentEvents with since only returns events strictly after the timestamp; without since returns the most recent overall', async () => {
    const watermark = new Date();
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await recordEvent(client, { listingId, kind: 'reply', actor: 'mcp' });
    const since = await recentEvents(client, { since: watermark, limit: 50 });
    assert.ok(since.some((e) => e.id === fresh.id));
    const noSince = await recentEvents(client, { limit: 1 });
    assert.equal(noSince.length, 1);
    assert.equal(noSince[0].id, fresh.id, 'most recent event overall with no lower bound');
  });
});
