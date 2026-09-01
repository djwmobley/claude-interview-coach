// @ts-check
/**
 * Regression coverage for the gmail scan #2112 crash (2026-08-28): source_failed, err_code 23505,
 * "duplicate key value violates unique constraint \"ic_job_listings_url_norm_uniq\"". Root cause:
 * classify()'s 4-ambiguous branches (url_reuse, branch1_conflict) can match a row that is currently
 * the sole live (duplicate_of IS NULL) holder of the colliding url_normalized / (source, external_id)
 * key without setting decision.rootId -- correct, since 'ambiguous' means "queue for a human", not
 * "merge". But sql/unique_indexes.sql's two partial unique indexes allow at most one duplicate_of-NULL
 * row per key, so insertListing()'s plain INSERT (pre-fix) threw 23505 for that second row, uncaught,
 * aborting the whole source (scan-run.js's per-source try/catch logs it as source_failed and moves on,
 * which is why only gmail failed in run #2112 while greenhouse/lever completed).
 *
 * Both tests below build the exact DB state that provoked the branch (a live row already occupying the
 * key), run the real classify() decision against it, then call applyDecision() -- with the pre-fix
 * insertListing (a plain INSERT using decision.rootId, which is null for both these branches) this
 * throws a real pg error with .code === '23505'; with the fix, insertListing's ON CONFLICT DO NOTHING
 * plus anchor-and-retry never lets that error occur, and the new row lands with duplicate_of pointing
 * at the live conflicting row -- structurally identical to what cross_source_dup already does -- while
 * the outcome/branch/reason recorded on the run item and the review-queue entry stay 'ambiguous' /
 * 'url_reuse' / 'branch1_conflict', so a human still has to resolve it (unchanged from before this fix).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { classify, makePgLookups } from '../src/core/dedup.js';
import { applyDecision } from '../src/core/upsert.js';
import { withTransaction } from '../src/core/db.js';
import { newClient } from './helpers/scan-fixtures.js';

const CO = `ZZ-TEST-UPSERT-${process.pid}`;
/** @type {import('pg').Client} */
let client;

before(async () => {
  client = await newClient();
});
after(async () => {
  await client.query(`DELETE FROM ic_job_review_queue WHERE candidate_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
  await client.query(`DELETE FROM ic_scan_run_items WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
  // Null url_normalized/external_id too, not just duplicate_of/repost_of: several rows in this file
  // deliberately share a url_normalized or (source, external_id) once duplicate_of is cleared (that is
  // the exact scenario under test), so clearing duplicate_of alone re-triggers the very unique-index
  // collision the fix exists to avoid. Matches test/helpers/scan-fixtures.js's cleanupScan.
  await client.query(`UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE company = $1`, [CO]);
  await client.query(`DELETE FROM ic_followups WHERE listing_id IN (SELECT id FROM ic_job_listings WHERE company = $1)`, [CO]);
  await client.query(`DELETE FROM ic_job_listings WHERE company = $1`, [CO]);
  await client.end();
});

/**
 * Insert a live top-level row directly (bypassing classify/insertListing, which is exactly what a
 * prior scan run or a native adapter would have already committed).
 * @param {{ source: string, externalId: string|null, url: string, title: string, dedupHash: string }} o
 */
async function insertLiveRow(o) {
  const r = await client.query(
    `INSERT INTO ic_job_listings
       (title, company, record_kind, source, external_id, url_normalized, dedup_hash, company_norm, title_norm,
        location_norm, posted_at, first_seen, last_seen, times_seen, duplicate_of)
     VALUES ($1,$2,'listing',$3,$4,$5,$6,$7,$8,$9,now()::date,now(),now(),1,NULL)
     RETURNING id`,
    [o.title, CO, o.source, o.externalId, o.url, o.dedupHash, CO.toLowerCase(), o.title.toLowerCase(), 'unknown:absent'],
  );
  return r.rows[0].id;
}

/**
 * A NormalizedListing built by hand (not via normalizeListing()) so the test controls
 * url_normalized/external_id/title_norm exactly, independent of normalize.js's own URL rules.
 * @param {Partial<import('../src/core/normalize.js').NormalizedListing>} o
 * @returns {import('../src/core/normalize.js').NormalizedListing}
 */
function rec(o) {
  return {
    source: 'gmail', external_id: null, url_normalized: null, url_kind: 'residual', title: 'ZZ Test Role',
    company: CO, title_norm: 'zz test role', company_norm: CO.toLowerCase(), company_note: null,
    location: null, location_norm: 'unknown:absent', remote_mode: null, remote_declared: false,
    dedup_hash: `zz-test-upsert-${Math.random().toString(36).slice(2)}`, description: null, description_hash: null,
    posted_at: null, salary_raw: null, salary_min: null, salary_max: null,
    ...o,
  };
}

describe('insertListing / applyDecision: unique-index conflicts on ambiguous decisions', () => {
  test('url_reuse (branch 4, shares url_normalized with a live row): does not throw 23505, anchors duplicate_of, still queues for review', async () => {
    const url = `https://example-zztest.com/careers/upsert-conflict-${process.pid}`;
    const existingId = await insertLiveRow({ source: 'indeed', externalId: null, url, title: 'Existing Ops Role', dedupHash: 'zz-test-upsert-existing-a' });

    const newRec = rec({ source: 'gmail', external_id: null, url_normalized: url, title: 'Totally Different Title', title_norm: 'totally different title' });
    const lookups = makePgLookups(client);
    const decision = await classify(newRec, lookups, {});
    assert.equal(decision.branch, '4-ambiguous');
    assert.equal(decision.reason, 'url_reuse');
    assert.equal(decision.rootId, null, 'premise: classify() never anchors an ambiguous decision itself');

    // Pre-fix, this next call throws a real pg error (err.code === '23505') on
    // ic_job_listings_url_norm_uniq, because insertListing tried to INSERT a second
    // duplicate_of-NULL row for the same url_normalized as `existingId`.
    const applied = await withTransaction(client, (c) => applyDecision(c, newRec, decision, { runId: null, now: new Date() }));
    assert.equal(applied.outcome, 'ambiguous');
    assert.equal(applied.branch, '4-ambiguous');
    assert.ok(applied.id !== existingId);

    const row = (await client.query('SELECT duplicate_of, status FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.equal(row.duplicate_of, existingId, 'anchored to the live row that already held the url, like cross_source_dup does');
    assert.equal(row.status, 'review');

    const queued = (await client.query(`SELECT reason FROM ic_job_review_queue WHERE candidate_id = $1`, [applied.id])).rows;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].reason, 'url_reuse', 'the classify() reason is preserved; the anchor is a persistence fallback, not a reclassification');

    // The unique indexes are the whole point: assert the anchored row genuinely is NOT visible to
    // ic_job_listings_url_norm_uniq (a second attempt to insert yet another duplicate_of-NULL row for
    // this same URL still must be rejected by Postgres itself, proving the fix did not just widen the
    // index away).
    await assert.rejects(
      client.query(
        `INSERT INTO ic_job_listings (title, company, record_kind, source, url_normalized, dedup_hash) VALUES ($1,$2,'listing','manual',$3,$4)`,
        ['Yet another live row', CO, url, `zz-test-upsert-${Math.random().toString(36).slice(2)}`],
      ),
      (/** @type {any} */ e) => e.code === '23505',
    );
  });

  test('branch1_conflict (external_id matches one live row, url_normalized matches a different live row): does not throw 23505, anchors duplicate_of', async () => {
    const extId = `zz-test-upsert:${process.pid}`;
    const otherUrl = `https://example-zztest.com/careers/upsert-conflict-other-${process.pid}`;
    const rowA = await insertLiveRow({ source: 'linkedin', externalId: extId, url: `https://www.linkedin.com/jobs/view/900000${process.pid % 1000}`, title: 'Row A', dedupHash: 'zz-test-upsert-existing-b1' });
    const rowM = await insertLiveRow({ source: 'manual', externalId: null, url: otherUrl, title: 'Row M', dedupHash: 'zz-test-upsert-existing-b2' });

    const newRec = rec({ source: 'linkedin', external_id: extId, url_normalized: otherUrl, title: 'Conflicting Incoming Row', title_norm: 'conflicting incoming row' });
    const lookups = makePgLookups(client);
    const decision = await classify(newRec, lookups, {});
    assert.equal(decision.branch, '4-ambiguous');
    assert.equal(decision.reason, 'branch1_conflict');
    assert.deepEqual(decision.matches.slice().sort((a, b) => a - b), [rowA, rowM].sort((a, b) => a - b));
    assert.equal(decision.rootId, null);

    const applied = await withTransaction(client, (c) => applyDecision(c, newRec, decision, { runId: null, now: new Date() }));
    assert.equal(applied.outcome, 'ambiguous');

    const row = (await client.query('SELECT duplicate_of FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.ok(row.duplicate_of === rowA || row.duplicate_of === rowM, 'anchored to whichever live row the fallback found first');

    const queued = (await client.query(`SELECT reason FROM ic_job_review_queue WHERE candidate_id = $1`, [applied.id])).rows;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].reason, 'branch1_conflict');
  });
});
