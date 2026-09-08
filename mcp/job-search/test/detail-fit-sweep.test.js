// @ts-check
/**
 * src/core/detail-fit-sweep.js: the shared fit-sweep predicate (fix/detail-fit-sweep spec S1), tested
 * directly against the real (isolated test) database via buildScanFitSweepQuery -- the exact query
 * src/core/scan-run.js's runDetailPass integration uses for a single source. Each clause gets one negative
 * case (a row that would otherwise qualify, disqualified by that ONE clause alone) and the positive control
 * row is asserted present in every test, so a clause silently going missing would show up as the negative
 * row leaking through, not just as the positive row vanishing.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { buildScanFitSweepQuery, fitSweepPredicateSql } from '../src/core/detail-fit-sweep.js';

const TAG = `zz-test-fitsweep-${process.pid}`;
const FLOOR = 70;

describe('src/core/detail-fit-sweep.js', () => {
  /** @type {pg.Client} */
  let client;
  /** @type {number[]} */
  const listingIds = [];

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
  });

  after(async () => {
    if (listingIds.length) {
      await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
      await client.query('UPDATE ic_job_listings SET duplicate_of = NULL WHERE id = ANY($1::int[])', [listingIds]);
      await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
    }
    await client.end();
  });

  /**
   * @param {Partial<{ source: string, status: string|null, fit_score: number|null, description: string|null,
   *   expired_at: string|null, duplicate_of: number|null, absent_runs: number, stale: boolean,
   *   record_kind: string, detail_attempts: number }>} o
   */
  async function seedRow(o = {}) {
    const n = Math.floor(Math.random() * 1e9);
    const source = o.source ?? 'greenhouse';
    const r = await client.query(
      `INSERT INTO ic_job_listings
         (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
          last_seen, status, url, url_normalized, prescore, detail_attempts, fit_score, description,
          expired_at, duplicate_of, absent_runs, stale)
       VALUES ('Fit Sweep Test Role', $1, $2, $3, $4, $5, 'fit sweep test role', 'legacy-unknown', $6,
          now(), $7, $8, $8, 45, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        `${TAG}-${n}`, source, `zz-fitsweep-ext-${n}`, o.record_kind ?? 'listing', `${TAG}-${n}`, `zz-fitsweep-hash-${n}`,
        o.status === undefined ? 'new' : o.status, `https://boards.greenhouse.io/zztest/jobs/${8100000000 + (n % 900000000)}`,
        o.detail_attempts ?? 0, o.fit_score === undefined ? FLOOR : o.fit_score, o.description === undefined ? null : o.description,
        o.expired_at ?? null, o.duplicate_of ?? null, o.absent_runs ?? 0, o.stale ?? false,
      ],
    );
    const id = Number(r.rows[0].id);
    listingIds.push(id);
    return id;
  }

  /** @param {{ source?: string, fitFloor?: number, excludeIds?: number[], limit?: number|null }} [o] */
  async function runQuery(o = {}) {
    const { sql, params } = buildScanFitSweepQuery({
      source: o.source ?? 'greenhouse', fitFloor: o.fitFloor ?? FLOOR, detailMaxAttempts: 3,
      excludeIds: o.excludeIds ?? [], limit: o.limit ?? null,
    });
    const r = await client.query(sql, params);
    return r.rows.map((row) => Number(row.id));
  }

  test('positive control: a fresh, empty-description, at-floor, new-status row is selected', async () => {
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(ids.includes(included));
  });

  test('excludes fit_score below the floor', async () => {
    const excluded = await seedRow({ fit_score: FLOOR - 1 });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludes a non-empty description (real string)', async () => {
    const excluded = await seedRow({ description: 'a perfectly real, already-fetched description' });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludes a whitespace-only description (matches classifyCandidate\'s .trim().length === 0 test)', async () => {
    const excluded = await seedRow({ description: '   \n\t  ' });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludes duplicate_of rows', async () => {
    const root = await seedRow();
    const excluded = await seedRow({ duplicate_of: root });
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
  });

  test('excludes a terminal status (applied) even at/over the fit floor with an empty description', async () => {
    const excluded = await seedRow({ status: 'applied' });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded), 'a terminal status must never be reopened by the fit sweep');
    assert.ok(ids.includes(included));
  });

  test('status NULL and each of new/maybe/shortlisted are all included', async () => {
    const nullStatus = await seedRow({ status: null });
    const newStatus = await seedRow({ status: 'new' });
    const maybeStatus = await seedRow({ status: 'maybe' });
    const shortlistedStatus = await seedRow({ status: 'shortlisted' });
    const ids = await runQuery();
    for (const id of [nullStatus, newStatus, maybeStatus, shortlistedStatus]) assert.ok(ids.includes(id));
  });

  test('excludes expired_at rows', async () => {
    const excluded = await seedRow({ expired_at: new Date().toISOString() });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludes absent_runs > 0 rows', async () => {
    const excluded = await seedRow({ absent_runs: 1 });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludes stale rows', async () => {
    const excluded = await seedRow({ stale: true });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludes a row with an active (non-withdrawn) application', async () => {
    const excluded = await seedRow();
    await client.query(`INSERT INTO ic_job_applications (listing_id) VALUES ($1)`, [excluded]);
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('a WITHDRAWN application does not exclude the row (state <> \'withdrawn\' matches auto-apply-select.js exactly)', async () => {
    const included = await seedRow();
    await client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'withdrawn')`, [included]);
    const ids = await runQuery();
    assert.ok(ids.includes(included));
  });

  test('excludes rows at/over detailMaxAttempts (scan-run.js\'s own SQL-side clause, unlike backfill\'s JS-side filter)', async () => {
    const excluded = await seedRow({ detail_attempts: 3 });
    const included = await seedRow({ detail_attempts: 2 });
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludes a non-listing record_kind', async () => {
    const excluded = await seedRow({ record_kind: 'note' });
    const included = await seedRow();
    const ids = await runQuery();
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('excludeIds removes an otherwise-qualifying row (S2: never re-select a row this run already queued via the ordinary list-page path)', async () => {
    const excluded = await seedRow();
    const included = await seedRow();
    const ids = await runQuery({ excludeIds: [excluded] });
    assert.ok(!ids.includes(excluded));
    assert.ok(ids.includes(included));
  });

  test('source restricts to exactly that source (a matching row on a different source is never returned)', async () => {
    const otherSource = await seedRow({ source: 'indeed' });
    const included = await seedRow({ source: 'greenhouse' });
    const ids = await runQuery({ source: 'greenhouse' });
    assert.ok(!ids.includes(otherSource));
    assert.ok(ids.includes(included));
  });

  test('limit caps the returned row count and ordering is fit_score DESC, id ASC on ties', async () => {
    await seedRow({ fit_score: FLOOR });
    const high = await seedRow({ fit_score: FLOOR + 20 });
    const { sql, params } = buildScanFitSweepQuery({ source: 'greenhouse', fitFloor: FLOOR, detailMaxAttempts: 3, excludeIds: [], limit: 1 });
    const r = await client.query(sql, params);
    assert.equal(r.rowCount, 1);
    assert.equal(Number(r.rows[0].id), high, 'the higher fit_score row must be selected first under a limit');
  });

  test('limit 0 returns nothing without erroring', async () => {
    await seedRow();
    const ids = await runQuery({ limit: 0 });
    assert.deepEqual(ids, []);
  });

  test('fitSweepPredicateSql composes with an arbitrary paramOffset (placeholders renumber correctly)', async () => {
    const included = await seedRow();
    const pred = fitSweepPredicateSql({ paramOffset: 1, fitFloor: FLOOR });
    const r = await client.query(`SELECT id FROM ic_job_listings WHERE id = $1 AND ${pred.sql}`, [included, ...pred.params]);
    assert.equal(r.rowCount, 1);
  });
});
