// @ts-check
/**
 * bin/migrate.js's renormalizeListings() (spec R3.2, decision 12), backfillStateRemoteDedup()
 * (spec R6.3), and backfillNoiseClass() (spec R2.1, independent review fix) against the isolated
 * "_test" database bin/run-tests.js points PG_DSN at (see npm test). Rows carry source
 * `zz-test-migrate-<pid>` and company `ZZ-TEST-MIGRATE-<pid>` and are deleted afterwards.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { renormalizeListings, backfillStateRemoteDedup, backfillNoiseClass } from '../bin/migrate.js';
import { dedupHash } from '../src/core/normalize.js';
import { NOISE_CLASSES } from '../src/core/noise.js';

const SRC = `zz-test-migrate-${process.pid}`;
const CO = `ZZ-TEST-MIGRATE-${process.pid}`;
/** @type {pg.Client} */
let client;

/**
 * @param {Partial<{ title: string, title_norm: string, company_norm: string, location: string|null, location_norm: string, remote_declared: boolean, dedup_hash: string, posted_at: string|null }>} o
 */
async function insert(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const title = o.title ?? 'CTO';
  const title_norm = o.title_norm ?? 'chief technology officer';
  const company_norm = o.company_norm ?? CO.toLowerCase();
  const location_norm = o.location_norm ?? 'legacy-unknown';
  const dedup_hash = o.dedup_hash ?? dedupHash(company_norm, title_norm, location_norm);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, url, source, external_id, record_kind, company_norm, title_norm, location, location_norm, remote_declared, dedup_hash, posted_at, last_seen)
     VALUES ($1,$2,$3,$4,$5,'listing',$6,$7,$8,$9,$10,$11,$12,now()) RETURNING id`,
    [title, CO, `https://example.test/${SRC}/${n}`, SRC, `${SRC}:${n}`, company_norm, title_norm, o.location ?? null, location_norm, Boolean(o.remote_declared), dedup_hash, o.posted_at ?? null],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  // Matches on company too (not just source): backfillNoiseClass tests below deliberately use a real
  // adapter name (e.g. 'greenhouse') as source to exercise the terminal "known adapter -> ok" branch,
  // so source=SRC alone would miss them; CO is unique per test run (pid-scoped) either way.
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE source = $1 OR company = $2', [SRC, CO])).rows.map((r) => r.id);
  if (ids.length === 0) return;
  await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
  await client.query('UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE id = ANY($1::int[])', [ids]);
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

describe('renormalizeListings (spec R3.2, decision 12)', () => {
  test('recomputes title_norm for a row whose title_norm predates the repeated-segment strip', async () => {
    const id = await insert({ title: 'Field CTO Enterprise Group Field CTO Enterprise Group with strong background', title_norm: 'field cto enterprise group field cto enterprise group with strong background' });
    const { changed } = await renormalizeListings(client);
    assert.ok(changed >= 1);
    const row = (await client.query('SELECT title_norm FROM ic_job_listings WHERE id = $1', [id])).rows[0];
    assert.ok(!row.title_norm.includes('field cto enterprise group field cto'), 'the duplicated segment is gone after renormalization');
  });

  test('recomputes location_norm from legacy-unknown to a state-only shape', async () => {
    const id = await insert({ location: 'Texas', location_norm: 'legacy-unknown' });
    await renormalizeListings(client);
    const row = (await client.query('SELECT location_norm FROM ic_job_listings WHERE id = $1', [id])).rows[0];
    assert.equal(row.location_norm, 'state-tx');
  });

  test('a dedup_hash collision from renormalization is queued for review, never auto-merged', async () => {
    // Two rows that will renormalize to the SAME title_norm/location_norm/dedup_hash once cleaned.
    const a = await insert({ title: 'CTO Enterprise Boilerplate Segment CTO Enterprise Boilerplate Segment with strong background', title_norm: 'cto enterprise boilerplate segment cto enterprise boilerplate segment with strong background', location: 'Texas', location_norm: 'legacy-unknown' });
    const b = await insert({ title: 'CTO Enterprise Boilerplate Segment CTO Enterprise Boilerplate Segment with strong background', title_norm: 'a-placeholder-different-title-norm', location: 'Texas', location_norm: 'legacy-unknown' });
    const { collisions } = await renormalizeListings(client);
    assert.ok(collisions >= 1);
    const rowA = (await client.query('SELECT dedup_hash, title_norm FROM ic_job_listings WHERE id = $1', [a])).rows[0];
    const rowB = (await client.query('SELECT dedup_hash, title_norm FROM ic_job_listings WHERE id = $1', [b])).rows[0];
    assert.equal(rowA.dedup_hash, rowB.dedup_hash, 'both rows renormalize to the same hash');
    const queued = (await client.query(`SELECT id FROM ic_job_review_queue WHERE resolved_at IS NULL AND reason = 'title_renormalized' AND candidate_id = $1`, [b])).rows;
    assert.ok(queued.length >= 1, 'the collision is queued for review');
    // Never auto-merged: duplicate_of stays NULL.
    const dupCheck = (await client.query('SELECT duplicate_of FROM ic_job_listings WHERE id = $1', [b])).rows[0];
    assert.equal(dupCheck.duplicate_of, null);
  });
});

describe('backfillStateRemoteDedup (spec R6.3)', () => {
  test('merges an open review item once its location_norm is state-only, closes the queue row', async () => {
    const root = await insert({ location: 'Texas', location_norm: 'state-tx', posted_at: '2026-08-10' });
    const dup = await insert({ location: 'Oklahoma', location_norm: 'state-ok', posted_at: '2026-08-12' });
    await client.query(
      `INSERT INTO ic_job_review_queue (candidate_id, matches, reason, status_at_create) VALUES ($1, $2::int[], 'hash_location_unknown', NULL)`,
      [dup, [root]],
    );
    const { merged, details } = await backfillStateRemoteDedup(client);
    assert.ok(merged >= 1);
    const found = details.find((d) => d.candidate_id === dup);
    assert.ok(found, 'the dup row appears in the backfill details');
    assert.equal(found.root_id, root);
    const row = (await client.query('SELECT duplicate_of FROM ic_job_listings WHERE id = $1', [dup])).rows[0];
    assert.equal(row.duplicate_of, root);
    const queue = (await client.query('SELECT resolved_at, resolution FROM ic_job_review_queue WHERE candidate_id = $1', [dup])).rows[0];
    assert.ok(queue.resolved_at, 'the queue row is resolved');
    assert.equal(queue.resolution, 'merge');
  });

  test('a city-level open review item is left untouched (does not match R6)', async () => {
    const a = await insert({ location: 'Houston, TX', location_norm: 'houston-tx', posted_at: '2026-08-10' });
    const b = await insert({ location: 'Austin, TX', location_norm: 'austin-tx', posted_at: '2026-08-10' });
    await client.query(
      `INSERT INTO ic_job_review_queue (candidate_id, matches, reason, status_at_create) VALUES ($1, $2::int[], 'title_similar_same_company', NULL)`,
      [b, [a]],
    );
    const { details } = await backfillStateRemoteDedup(client);
    assert.ok(!details.some((d) => d.candidate_id === b));
    const queue = (await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE candidate_id = $1', [b])).rows[0];
    assert.equal(queue.resolved_at, null, 'left open for a human');
  });
});

describe('backfillNoiseClass (spec R2.1, independent review fix)', () => {
  /**
   * @param {{ title: string, company_norm?: string, url_normalized?: string|null, description?: string|null, salary_raw?: string|null }} o
   */
  async function insertUnclassified(o) {
    const n = Math.floor(Math.random() * 1e9);
    // source is a real, known adapter name ('greenhouse') so the terminal "known adapter -> ok" branch
    // of classifyNoise's total classification is actually exercised here; external_id/url still carry
    // the SRC test marker, and company (CO) is what cleanup() matches on for these rows.
    const r = await client.query(
      `INSERT INTO ic_job_listings (title, company, url, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, url_normalized, description, salary_raw, noise_class, last_seen)
       VALUES ($1,$2,$3,'greenhouse',$4,'listing',$5,lower($1),'legacy-unknown',md5($3),$6,$7,$8,NULL,now()) RETURNING id`,
      [o.title, CO, `https://example.test/${SRC}/${n}`, `${SRC}:${n}`, o.company_norm ?? CO.toLowerCase(), o.url_normalized ?? null, o.description ?? null, o.salary_raw ?? null],
    );
    return Number(r.rows[0].id);
  }

  test('classifies every row whose noise_class is NULL, batched, and reports a per-class count', async () => {
    const ok = await insertUnclassified({ title: 'Chief Technology Officer' });
    const suspect = await insertUnclassified({ title: 'Virtual CTO' });
    const already = await insert({ title: 'Already Classified' });
    await client.query(`UPDATE ic_job_listings SET noise_class = 'ok' WHERE id = $1`, [already]);
    // A small batchSize forces multiple batches even with only two pending rows, exercising the loop.
    const { total, counts } = await backfillNoiseClass(client, { batchSize: 1 });
    assert.ok(total >= 2, 'both pending rows were classified');
    for (const cls of Object.keys(counts)) assert.ok(NOISE_CLASSES.includes(cls), `unexpected class ${cls}`);
    const rows = (await client.query('SELECT id, noise_class FROM ic_job_listings WHERE id = ANY($1::int[])', [[ok, suspect, already]])).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.noise_class]));
    assert.equal(byId[ok], 'ok');
    assert.equal(byId[suspect], 'suspect');
    assert.equal(byId[already], 'ok', 'a row already classified is left untouched, never re-queried or re-counted');
    // Idempotent: a second run finds nothing left to classify.
    const second = await backfillNoiseClass(client);
    assert.equal(second.total, 0);
  });
});
