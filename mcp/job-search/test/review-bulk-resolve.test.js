// @ts-check
/**
 * bulkResolve() (src/tools/review.js, review-bulk spec S2) against the real ic_context test DB. Rows
 * carry source `zz-test-reviewbulk-<pid>` / company `ZZ-TEST-REVIEWBULK-<pid>` and are deleted afterwards
 * (queue rows, events, then listings), same convention as test/tools.test.js.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { bulkResolve, resolveItem } from '../src/tools/review.js';
import { listEvents } from '../src/core/events.js';

const SRC = `zz-test-reviewbulk-${process.pid}`;
const CO = `ZZ-TEST-REVIEWBULK-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {{ withClient: (fn: (c: any) => Promise<any>) => Promise<any> }} */
let deps;

/**
 * @param {Partial<{ title: string, status: string|null, companyNorm: string, titleNorm: string, locationNorm: string, url: string, ext: string, dup: number|null }>} o
 */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const url = o.url ?? `https://example.test/${SRC}/${n}`;
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, status, url, url_normalized, source, external_id, record_kind, location, posted_at, company_norm, title_norm, location_norm, dedup_hash, last_seen, duplicate_of)
     VALUES ($1,$2,$3,$4,$4,$5,$6,'listing','Houston, TX',current_date,$7,$8,$9,md5($4),now(),$10) RETURNING id`,
    [o.title ?? 'CTO', CO, o.status ?? null, url, SRC, o.ext ?? `${SRC}:${n}`, o.companyNorm ?? 'zz reviewbulk co', o.titleNorm ?? 'chief technology officer', o.locationNorm ?? 'houston-tx', o.dup ?? null],
  );
  return Number(r.rows[0].id);
}

/**
 * @param {{ candidateId: number|null, matches?: number[], reason: string, resolution?: string|null, statusAtCreate?: string|null, createdAt?: Date|null }} o
 */
async function insertQueueItem(o) {
  const r = await client.query(
    `INSERT INTO ic_job_review_queue (candidate_id, matches, reason, resolution, status_at_create, created_at)
     VALUES ($1, $2::int[], $3, $4, $5, coalesce($6::timestamptz, now())) RETURNING id`,
    [o.candidateId, o.matches ?? [], o.reason, o.resolution ?? null, o.statusAtCreate ?? 'review', o.createdAt ?? null],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE source = $1', [SRC])).rows.map((r) => r.id);
  if (ids.length) await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
  if (ids.length) {
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
  deps = { withClient: async (fn) => fn(client) };
});

after(async () => {
  await cleanup();
  await client.end();
});

describe('bulkResolve: validation', () => {
  test('unknown mode is rejected before touching the DB', async () => {
    await assert.rejects(bulkResolve(deps, { mode: 'merge', dryRun: true, confirm: false }), /mode must be one of/);
  });

  test('dryRun must be a real boolean -- the string "false" is rejected, never coerced', async () => {
    await assert.rejects(bulkResolve(deps, /** @type {any} */ ({ mode: 'stale', dryRun: 'false', confirm: false })), /dryRun must be a boolean/);
  });

  test('confirm must be a real boolean -- the string "false" is rejected, never coerced', async () => {
    await assert.rejects(bulkResolve(deps, /** @type {any} */ ({ mode: 'stale', dryRun: false, confirm: 'true' })), /confirm must be a boolean/);
  });

  test('unknown reason is rejected for mode:"reason" before touching the DB', async () => {
    await assert.rejects(bulkResolve(deps, { mode: 'reason', reason: 'not_a_real_reason', dryRun: true, confirm: false }), /reason must be one of/);
  });

  test('a typo\'d near-miss reason is rejected the same way (no fuzzy matching on the reason string)', async () => {
    await assert.rejects(bulkResolve(deps, { mode: 'reason', reason: 'title_similar_same_compnay', dryRun: true, confirm: false }), /reason must be one of/);
  });

  test('live mode (dryRun:false) without confirm:true is refused, for every mode', async () => {
    for (const mode of /** @type {const} */ (['rule', 'reason', 'stale'])) {
      const opts = mode === 'reason' ? { mode, reason: 'title_similar_same_company', dryRun: false, confirm: false } : { mode, dryRun: false, confirm: false };
      await assert.rejects(bulkResolve(deps, opts), /confirm must be true/);
    }
  });
});

describe('bulkResolve: mode "rule"', () => {
  test('same title token key, same company, both eligible, different non-remote locations -> separated', async () => {
    const cand = await insertListing({ title: 'Senior Director of Engineering', status: 'review', titleNorm: 'senior director of engineering', locationNorm: 'houston-tx' });
    const match = await insertListing({ title: 'Senior Director of Engineering', status: 'shortlisted', titleNorm: 'senior director of engineering', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [match], reason: 'title_similar_same_company' });
    const out = await bulkResolve(deps, { mode: 'rule', dryRun: false, confirm: true });
    assert.equal(out.counts.separate, 1);
    assert.deepEqual(out.ids.separated, [q]);
    const row = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [cand]);
    assert.equal(row.rows[0].status, null);
    const events = await listEvents(client, cand);
    assert.ok(events.some((e) => e.note === 'resolved:separate:bulk:rule'));
  });

  test('title token key differs ("senior director" vs "director") -> left, tallied under title_key_differs', async () => {
    const cand = await insertListing({ status: 'review', titleNorm: 'senior director of engineering', locationNorm: 'houston-tx' });
    const match = await insertListing({ status: 'review', titleNorm: 'director of engineering', locationNorm: 'dallas-tx' });
    await insertQueueItem({ candidateId: cand, matches: [match], reason: 'title_similar_same_company' });
    const out = await bulkResolve(deps, { mode: 'rule', dryRun: true, confirm: false });
    assert.equal(out.counts.separate, 0);
    assert.equal(out.counts.leave_by_reason.title_key_differs, 1);
  });

  test('dryRun performs zero writes: resolved_at stays null and status is unchanged', async () => {
    const cand = await insertListing({ status: 'review', titleNorm: 'chief technology officer', locationNorm: 'houston-tx' });
    const match = await insertListing({ status: 'review', titleNorm: 'chief technology officer', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [match], reason: 'title_similar_same_company' });
    const out = await bulkResolve(deps, { mode: 'rule', dryRun: true, confirm: false });
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.ids.separated, [q]);
    const qRow = await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [q]);
    assert.equal(qRow.rows[0].resolved_at, null);
    const lRow = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [cand]);
    assert.equal(lRow.rows[0].status, 'review');
  });

  test('ids are re-queried at execution time: an item inserted between a dry-run preview and the live call is picked up', async () => {
    const before1 = await bulkResolve(deps, { mode: 'rule', dryRun: true, confirm: false });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp of payments', locationNorm: 'houston-tx' });
    const match = await insertListing({ status: 'review', titleNorm: 'vp of payments', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [match], reason: 'title_similar_same_company' });
    const after1 = await bulkResolve(deps, { mode: 'rule', dryRun: false, confirm: true });
    assert.ok(!before1.ids.separated.includes(q), 'the item did not exist yet during the first preview');
    assert.ok(after1.ids.separated.includes(q), 'the live call re-queried and picked up the newly inserted item');
  });

  test('a missing match row (deleted since queuing) never throws -- classified leave, multi_match', async () => {
    const cand = await insertListing({ status: 'review' });
    await insertQueueItem({ candidateId: cand, matches: [999999999], reason: 'title_similar_same_company' });
    const out = await bulkResolve(deps, { mode: 'rule', dryRun: true, confirm: false });
    assert.equal(out.counts.separate, 0);
    assert.equal(out.counts.leave_by_reason.multi_match, 1);
  });
});

describe('bulkResolve: mode "reason"', () => {
  test('separates every open item with the given reason, ignores others', async () => {
    const a = await insertListing({ status: 'review' });
    const b = await insertListing({ status: 'review' });
    const qa = await insertQueueItem({ candidateId: a, reason: 'branch1_conflict' });
    const qb = await insertQueueItem({ candidateId: b, reason: 'company_similar_same_title' });
    const out = await bulkResolve(deps, { mode: 'reason', reason: 'branch1_conflict', dryRun: false, confirm: true });
    assert.equal(out.counts.separate, 1);
    assert.deepEqual(out.ids.separated, [qa]);
    const qbRow = await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [qb]);
    assert.equal(qbRow.rows[0].resolved_at, null);
  });

  test('event note carries the mode and the reason', async () => {
    const cand = await insertListing({ status: 'review' });
    await insertQueueItem({ candidateId: cand, reason: 'hash_location_unknown' });
    await bulkResolve(deps, { mode: 'reason', reason: 'hash_location_unknown', dryRun: false, confirm: true });
    const events = await listEvents(client, cand);
    assert.ok(events.some((e) => e.note === 'resolved:separate:bulk:reason:hash_location_unknown'));
  });

  test('an already-resolved item counts as skipped, not an error (a concurrent resolve lands between bulkResolve\'s own selection query and its per-item resolveItem call)', async () => {
    const cand = await insertListing({ status: 'review' });
    // reason is incidental to this race-timing test -- 'reopened_skip' is refused for mode:'reason' by
    // the sticky-skip spec (part C: those items now resolve via mode:'sticky-skip' instead), so this
    // uses a different closed reason that exercises the exact same already-resolved race path.
    const q = await insertQueueItem({ candidateId: cand, reason: 'concurrent_review' });
    // bulkResolve re-queries open items at execution time, so resolving the item BEFORE bulkResolve
    // even runs would just make its own SELECT exclude the row entirely -- that would never exercise the
    // already-resolved catch branch in the per-item loop. To exercise it for real, a second, independent
    // connection resolves the item in between bulkResolve's selection query (this racyDeps' 1st
    // withClient call) and its per-item resolveItem attempt (the 2nd call), landing exactly where a
    // genuine concurrent human/auto resolve would.
    let calls = 0;
    const racyDeps = {
      withClient: async (/** @type {any} */ fn) => {
        calls++;
        if (calls === 2) {
          const other = new pg.Client(pgConnectionConfig());
          await other.connect();
          await other.query('BEGIN');
          await resolveItem(other, { queueId: q, resolution: 'separate' });
          await other.query('COMMIT');
          await other.end();
        }
        return fn(client);
      },
    };
    const out = await bulkResolve(racyDeps, { mode: 'reason', reason: 'concurrent_review', dryRun: false, confirm: true });
    assert.equal(out.counts.errors, 0);
    assert.equal(out.counts.skipped_by_reason.already_resolved, 1);
    assert.deepEqual(out.ids.skipped, [q]);
  });

  test('a unique-index conflict counts as skipped under reason unique_conflict, not an error', async () => {
    // Same pattern as test/tools.test.js's own "separate is blocked by a unique conflict" case: the
    // candidate shares its url_normalized with a live root while ITS OWN duplicate_of is already set
    // (so the partial unique index, which excludes duplicate_of IS NOT NULL rows, lets both rows exist);
    // uniqueConflict() then finds the live root when the candidate tries to separate.
    const sharedUrl = `https://example.test/${SRC}/shared-conflict`;
    const root = await insertListing({ status: null, url: sharedUrl });
    const cand = await insertListing({ status: 'review', url: sharedUrl, dup: root });
    const q = await insertQueueItem({ candidateId: cand, reason: 'cross_source_uncorroborated' });
    const out = await bulkResolve(deps, { mode: 'reason', reason: 'cross_source_uncorroborated', dryRun: false, confirm: true });
    assert.equal(out.counts.errors, 0);
    assert.equal(out.counts.skipped_by_reason.unique_conflict, 1);
    assert.deepEqual(out.ids.skipped, [q]);
  });
});

describe('bulkResolve: mode "stale"', () => {
  test('separates items older than reviewAutoSeparateDays, leaves fresh ones', async () => {
    const stale = await insertListing({ status: 'review' });
    const fresh = await insertListing({ status: 'review' });
    const qStale = await insertQueueItem({ candidateId: stale, reason: 'title_renormalized', createdAt: new Date(Date.now() - 40 * 86400000) });
    const qFresh = await insertQueueItem({ candidateId: fresh, reason: 'title_renormalized' });
    const out = await bulkResolve(deps, { mode: 'stale', dryRun: false, confirm: true, reviewAutoSeparateDays: 30 });
    assert.deepEqual(out.ids.separated, [qStale]);
    const freshRow = await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [qFresh]);
    assert.equal(freshRow.rows[0].resolved_at, null);
  });

  test('overlaps autoSeparate without error: a row autoSeparate claims between bulkResolve\'s selection and its own resolveItem attempt is reported as skipped, not an error', async () => {
    const cand = await insertListing({ status: 'review' });
    const q = await insertQueueItem({ candidateId: cand, reason: 'concurrent_review', createdAt: new Date(Date.now() - 40 * 86400000) });
    // Same reasoning as the mode:"reason" already-resolved test above: resolving the row before
    // bulkResolve runs would just make its own staleness SELECT exclude it. A second, independent
    // connection plays the role of autoSeparate() landing in between bulkResolve's selection query and
    // its per-item resolveItem call.
    let calls = 0;
    const racyDeps = {
      withClient: async (/** @type {any} */ fn) => {
        calls++;
        if (calls === 2) {
          const other = new pg.Client(pgConnectionConfig());
          await other.connect();
          await other.query('BEGIN');
          await resolveItem(other, { queueId: q, resolution: 'separate', auto: true });
          await other.query('COMMIT');
          await other.end();
        }
        return fn(client);
      },
    };
    const out = await bulkResolve(racyDeps, { mode: 'stale', dryRun: false, confirm: true, reviewAutoSeparateDays: 30 });
    assert.equal(out.counts.errors, 0);
    assert.equal(out.counts.skipped_by_reason.already_resolved, 1);
  });
});

describe('bulkResolve: actor pass-through', () => {
  test('actor defaults to mcp when not supplied, and passes through cli/dashboard values', async () => {
    const cand = await insertListing({ status: 'review' });
    await insertQueueItem({ candidateId: cand, reason: 'title_similar_same_company' });
    await bulkResolve(deps, { mode: 'reason', reason: 'title_similar_same_company', dryRun: false, confirm: true, actor: 'cli' });
    const events = await listEvents(client, cand);
    const ev = events.find((e) => /^resolved:separate:bulk:/.test(e.note ?? ''));
    assert.equal(ev?.actor, 'cli');
  });
});
