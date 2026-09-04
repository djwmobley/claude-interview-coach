// @ts-check
/**
 * Sticky-skip spec ("final, adversary-corrected"): STICKY-ELIGIBLE/MATCH-TEST/SURFACE-EXCEPTION
 * (src/core/sticky-skip.js), part A (src/tools/review.js resolveItem), part B (src/core/upsert.js
 * applyDecision/findStickySkipRoot), and part C (src/core/review-bulk.js classifyForStickySkip +
 * src/tools/review.js bulkResolve mode 'sticky-skip', plus the mode:'reason' reopened_skip refusal).
 *
 * DB-backed sections use the real ic_context test DB, same convention as test/review-bulk-resolve.test.js:
 * rows carry source `zz-test-stickyskip-<pid>` / company `ZZ-TEST-STICKYSKIP-<pid>` and are deleted
 * afterwards (queue rows, events, then listings).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { isStickyStatus, isStickyEligible, matchTest, surfaceException, stickyMergeCandidate } from '../src/core/sticky-skip.js';
import { STICKY_STATUSES } from '../src/core/statuses.js';
import { classifyForStickySkip, STICKY_SKIP_LEAVE_REASONS } from '../src/core/review-bulk.js';
import { bulkResolve, resolveItem, REVIEW_BULK_MODES } from '../src/tools/review.js';
import { applyDecision } from '../src/core/upsert.js';
import { classify, makePgLookups } from '../src/core/dedup.js';
import { normalizeListing, DEFAULT_TRACKING_PARAMS } from '../src/core/normalize.js';
import { recordEvent, listEvents } from '../src/core/events.js';
import { withTransaction } from '../src/core/db.js';

// ---------------------------------------------------------------------------
// Pure functions: no DB
// ---------------------------------------------------------------------------

describe('sticky-skip: STICKY_STATUSES / isStickyStatus', () => {
  test('closed set is exactly skip, passed, lost', () => {
    assert.deepEqual([...STICKY_STATUSES].sort(), ['lost', 'passed', 'skip']);
  });
  test('applied/interviewing/offer/dead/review/null are never sticky', () => {
    for (const s of ['applied', 'interviewing', 'offer', 'dead', 'review', 'new', 'maybe', null, undefined]) {
      assert.equal(isStickyStatus(/** @type {any} */ (s)), false, `${s} must not be sticky`);
    }
  });
});

describe('sticky-skip: isStickyEligible (STICKY-ELIGIBLE)', () => {
  test('human actor (dashboard/mcp/cli) on a sticky status is eligible, regardless of candidate prescore', () => {
    for (const actor of ['dashboard', 'mcp', 'cli']) {
      for (const status of STICKY_STATUSES) {
        assert.equal(isStickyEligible(status, { actor, note: null }), true, `${actor}/${status}`);
        // human skip still eligible regardless of prescore (auto-skip-sticky spec): a human decision
        // never consults candidatePrescore/floor at all, so a high candidate prescore changes nothing.
        assert.equal(isStickyEligible(status, { actor, note: null }, { candidatePrescore: 95, floor: 40 }), true, `${actor}/${status} high prescore`);
      }
    }
  });
  test('auto actor, candidate prescore strictly below floor, no later non-status event -> eligible (note text irrelevant)', () => {
    for (const note of ['auto-triage: noise_class=suspect', 'auto-triage: prescore 12 < floor 20', 'model band: skip', 'freeform note']) {
      assert.equal(isStickyEligible('skip', { actor: 'auto', note }, { candidatePrescore: 10, floor: 40, hasLaterNonStatusEvent: false }), true, note);
    }
  });
  test('auto actor, candidate prescore equal to floor -> NOT eligible ("strictly below", not "at or below")', () => {
    assert.equal(isStickyEligible('skip', { actor: 'auto', note: null }, { candidatePrescore: 40, floor: 40 }), false);
  });
  test('auto actor, candidate prescore above floor -> NOT eligible', () => {
    assert.equal(isStickyEligible('skip', { actor: 'auto', note: null }, { candidatePrescore: 55, floor: 40 }), false);
  });
  test('auto actor, candidate prescore null -> NOT eligible, even below floor were it not null', () => {
    assert.equal(isStickyEligible('skip', { actor: 'auto', note: null }, { candidatePrescore: null, floor: 40 }), false);
    assert.equal(isStickyEligible('skip', { actor: 'auto', note: null }), false, 'no auto opts at all');
  });
  test('auto actor, floor omitted -> falls back to DEFAULT_STICKY_FLOOR (40)', () => {
    assert.equal(isStickyEligible('skip', { actor: 'auto', note: null }, { candidatePrescore: 39 }), true);
    assert.equal(isStickyEligible('skip', { actor: 'auto', note: null }, { candidatePrescore: 40 }), false);
  });
  test('auto actor, a later non-status event on the root -> NOT eligible even with a qualifying prescore', () => {
    assert.equal(isStickyEligible('skip', { actor: 'auto', note: null }, { candidatePrescore: 10, floor: 40, hasLaterNonStatusEvent: true }), false);
  });
  test('auto actor on passed/lost is eligible under the same prescore rule (auto-triage never sets those in practice, but the classification is generic)', () => {
    assert.equal(isStickyEligible('passed', { actor: 'auto', note: 'auto-triage: noise_class=suspect' }, { candidatePrescore: 10, floor: 40 }), true);
    assert.equal(isStickyEligible('lost', { actor: 'auto', note: 'auto-triage: noise_class=suspect' }, { candidatePrescore: 10, floor: 40 }), true);
  });
  test('no event at all is not eligible (fail closed)', () => {
    assert.equal(isStickyEligible('skip', null), false);
    assert.equal(isStickyEligible('skip', undefined), false);
  });
  test('a non-sticky status is never eligible regardless of actor', () => {
    assert.equal(isStickyEligible('applied', { actor: 'dashboard', note: null }), false);
  });
  test('seed/migration/apply actor is not eligible (not in the human set, not auto)', () => {
    assert.equal(isStickyEligible('skip', { actor: 'seed', note: null }), false);
    assert.equal(isStickyEligible('skip', { actor: 'migration', note: null }), false);
    assert.equal(isStickyEligible('skip', { actor: 'apply', note: null }, { candidatePrescore: 10, floor: 40 }), false);
  });
});

describe('sticky-skip: matchTest (MATCH-TEST)', () => {
  const base = { url_normalized: null, url_kind: undefined, source: 's1', title_norm: 't', company_norm: 'c', location_norm: 'houston-tx' };

  test('clause (i): same url_normalized, url_kind not redirect -> true', () => {
    const cand = { ...base, url_normalized: 'https://x.test/1', title_norm: 'other', company_norm: 'other', location_norm: 'dallas-tx' };
    const root = { ...base, url_normalized: 'https://x.test/1' };
    assert.equal(matchTest(cand, root), true);
  });
  test('clause (i): url_kind redirect never matches even with the same url', () => {
    const cand = { ...base, url_normalized: 'https://x.test/1', url_kind: 'redirect', title_norm: 'other', company_norm: 'other', location_norm: 'dallas-tx' };
    const root = { ...base, url_normalized: 'https://x.test/1' };
    assert.equal(matchTest(cand, root), false);
  });
  test('clause (i): url_kind omitted (stored-row callers) is treated as not-redirect', () => {
    const cand = { url_normalized: 'https://x.test/1', source: 'other', title_norm: 'other', company_norm: 'other', location_norm: 'dallas-tx' };
    const root = { url_normalized: 'https://x.test/1', source: 's1', title_norm: 't', company_norm: 'c', location_norm: 'houston-tx' };
    assert.equal(matchTest(cand, root), true);
  });
  test('null url_normalized on both sides never counts as a match (never treat null as equal to null)', () => {
    const cand = { ...base, url_normalized: null, title_norm: 'other', company_norm: 'other', location_norm: 'dallas-tx' };
    const root = { ...base, url_normalized: null };
    assert.equal(matchTest(cand, root), false);
  });

  test('clause (ii): same source, both location-eligible, equal title/company/location_norm -> true', () => {
    const cand = { ...base };
    const root = { ...base };
    assert.equal(matchTest(cand, root), true);
  });
  test('clause (ii): different source never matches via clause ii', () => {
    const cand = { ...base, source: 's2' };
    const root = { ...base };
    assert.equal(matchTest(cand, root), false);
  });
  test('clause (ii): location_norm "absent" on either side fails isLocationEligible', () => {
    const cand = { ...base, location_norm: 'absent' };
    const root = { ...base };
    assert.equal(matchTest(cand, root), false);
    assert.equal(matchTest({ ...base }, { ...base, location_norm: 'unknown:remote' }), false);
  });
  test('clause (ii): differing title_norm fails', () => {
    assert.equal(matchTest({ ...base, title_norm: 'other' }, { ...base }), false);
  });
  test('clause (ii): null title_norm on one side never counts as equal', () => {
    assert.equal(matchTest({ ...base, title_norm: null }, { ...base, title_norm: null }), false);
  });
  test('neither clause matches -> false', () => {
    assert.equal(matchTest({ ...base, source: 's2', title_norm: 'x' }, { ...base }), false);
  });
});

describe('sticky-skip: surfaceException (SURFACE-EXCEPTION)', () => {
  test('salary_max exceeding root by more than 10% is an exception', () => {
    assert.equal(surfaceException({ salary_max: 221000, apply_url: null }, { salary_max: 200000, apply_url: null }), true);
  });
  test('salary_max at exactly 10% over is NOT an exception ("more than", not "at least")', () => {
    assert.equal(surfaceException({ salary_max: 220000, apply_url: null }, { salary_max: 200000, apply_url: null }), false);
  });
  test('salary_max lower or equal is never an exception', () => {
    assert.equal(surfaceException({ salary_max: 150000, apply_url: null }, { salary_max: 200000, apply_url: null }), false);
  });
  test('a null salary_max on either side never triggers the salary clause', () => {
    assert.equal(surfaceException({ salary_max: null, apply_url: null }, { salary_max: 200000, apply_url: null }), false);
    assert.equal(surfaceException({ salary_max: 500000, apply_url: null }, { salary_max: null, apply_url: null }), false);
  });
  test('both apply_url present and different is an exception', () => {
    assert.equal(surfaceException({ salary_max: null, apply_url: 'https://a.test/apply' }, { salary_max: null, apply_url: 'https://b.test/apply' }), true);
  });
  test('both apply_url present and identical is not an exception', () => {
    assert.equal(surfaceException({ salary_max: null, apply_url: 'https://a.test/apply' }, { salary_max: null, apply_url: 'https://a.test/apply' }), false);
  });
  test('a null apply_url on either side never triggers the apply_url clause', () => {
    assert.equal(surfaceException({ salary_max: null, apply_url: null }, { salary_max: null, apply_url: 'https://b.test/apply' }), false);
  });
  test('stickyMergeCandidate combines matchTest && !surfaceException', () => {
    const base = { url_normalized: null, source: 's1', title_norm: 't', company_norm: 'c', location_norm: 'houston-tx' };
    assert.equal(stickyMergeCandidate({ ...base, salary_max: null, apply_url: null }, { ...base, salary_max: null, apply_url: null }), true);
    assert.equal(stickyMergeCandidate({ ...base, salary_max: 500000, apply_url: null }, { ...base, salary_max: 400000, apply_url: null }), false);
    assert.equal(stickyMergeCandidate({ ...base, source: 'other', salary_max: null, apply_url: null }, { ...base, salary_max: null, apply_url: null }), false);
  });
});

// ---------------------------------------------------------------------------
// DB-backed: resolveItem (part A), applyDecision (part B), bulkResolve (part C)
// ---------------------------------------------------------------------------

const SRC = `zz-test-stickyskip-${process.pid}`;
const CO = `ZZ-TEST-STICKYSKIP-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {{ withClient: (fn: (c: any) => Promise<any>) => Promise<any> }} */
let deps;
/**
 * Every listing id this file creates, tracked explicitly rather than relying only on `company = CO`:
 * part B's applyDecision() calls insert rows through the REAL production insertListing() (src/core/
 * upsert.js), which stores `rec.company` (e.g. "Acme Widgets"), not the CO constant -- so those rows,
 * and the duplicate_of/repost_of edges they hold pointing at CO-scoped root rows, would otherwise be
 * invisible to a company-scoped cleanup and block the root rows' delete with a foreign-key violation.
 * @type {number[]}
 */
const createdIds = [];

/**
 * @param {Partial<{ title: string, status: string|null, companyNorm: string, titleNorm: string, locationNorm: string, url: string, ext: string, dup: number|null, salaryMax: number|null, applyUrl: string|null, source: string, prescore: number|null }>} o
 */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const url = o.url ?? `https://example.test/${SRC}/${n}`;
  // 'ext' in o (not o.ext ?? default): insertRootFromListing explicitly passes ext: null when the real
  // normalizeListing() output has no external_id (a generic host) -- that null must be stored as-is,
  // never silently replaced by the auto-generated default, or a same-url branch-1b test can never see
  // the bothNull condition it needs.
  const ext = 'ext' in o ? o.ext : `${SRC}:${n}`;
  const r = await client.query(
    `INSERT INTO ic_job_listings
       (title, company, status, url, url_normalized, source, external_id, record_kind, location, posted_at,
        company_norm, title_norm, location_norm, dedup_hash, last_seen, duplicate_of, salary_max, apply_url, prescore)
     VALUES ($1,$2,$3,$4,$4,$5,$6,'listing','Houston, TX',current_date,$7,$8,$9,md5($4),now(),$10,$11,$12,$13) RETURNING id`,
    [
      o.title ?? 'CTO', CO, o.status ?? null, url, o.source ?? SRC, ext,
      o.companyNorm ?? 'zz stickyskip co', o.titleNorm ?? 'chief technology officer', o.locationNorm ?? 'houston-tx',
      o.dup ?? null, o.salaryMax ?? null, o.applyUrl ?? null, o.prescore ?? null,
    ],
  );
  const id = Number(r.rows[0].id);
  createdIds.push(id);
  return id;
}

/** @param {{ candidateId: number|null, matches?: number[], reason: string, resolution?: string|null, statusAtCreate?: string|null }} o */
async function insertQueueItem(o) {
  const r = await client.query(
    `INSERT INTO ic_job_review_queue (candidate_id, matches, reason, resolution, status_at_create)
     VALUES ($1, $2::int[], $3, $4, $5) RETURNING id`,
    [o.candidateId, o.matches ?? [], o.reason, o.resolution ?? null, o.statusAtCreate ?? 'review'],
  );
  return Number(r.rows[0].id);
}

/** @param {{ listingId: number, toStatus: string, actor: string, note: string|null }} o */
async function insertStatusEvent(o) {
  await recordEvent(client, { listingId: o.listingId, kind: 'status', fromStatus: null, toStatus: o.toStatus, note: o.note, actor: /** @type {any} */ (o.actor) });
}

async function cleanup() {
  // Union of everything explicitly tracked (createdIds, including part B's applyDecision-created rows
  // whose `company` column is NOT the CO constant) with anything still tagged company=CO (belt and
  // braces for any row created some other way). Either set alone can miss a referencing row and leave
  // the delete below blocked by a duplicate_of/repost_of foreign key.
  const byCompany = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [CO])).rows.map((r) => Number(r.id));
  const ids = [...new Set([...createdIds, ...byCompany])];
  if (ids.length) {
    await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  createdIds.length = 0;
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

describe('sticky-skip part A: resolveItem merge/repost into a STICKY-ELIGIBLE root', () => {
  test('merge: human-skip root -> candidate inherits skip directly, bypassing inheritStatus, one "sticky skip" event, no reopened_skip queue row', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'vp payments', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments 2', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: root }));
    assert.equal(out.resolution, 'merge');
    assert.equal(out.status, 'skip');
    assert.equal(/** @type {any} */ (out).sticky, true);

    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(row.status, 'skip');
    assert.equal(row.duplicate_of, root);
    const rootRow = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [root])).rows[0];
    assert.equal(rootRow.status, 'skip', 'the root row is untouched');
    const openQueue = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [cand])).rows[0].n;
    assert.equal(openQueue, 0, 'no reopened_skip queue row inserted');
    const events = await listEvents(client, cand);
    assert.equal(events.filter((e) => e.kind === 'status').length, 1);
    assert.equal(events[0].note, 'sticky skip');
  });

  test('repost: human-lost root -> candidate stays independent (repost_of), status set directly to lost, no reopened_lost queue row', async () => {
    const root = await insertListing({ status: 'lost', titleNorm: 'vp payments repost', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'lost', actor: 'mcp', note: null });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments repost 2', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'same_source_hash_within_gap' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'repost', targetId: root }));
    assert.equal(out.resolution, 'repost');
    assert.equal(out.status, 'lost');
    assert.equal(/** @type {any} */ (out).sticky, true);

    const row = (await client.query('SELECT status, repost_of, duplicate_of FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(row.status, 'lost');
    assert.equal(row.repost_of, root);
    assert.equal(row.duplicate_of, null, 'repost never sets duplicate_of');
    const openQueue = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [cand])).rows[0].n;
    assert.equal(openQueue, 0, 'no reopened_lost queue row inserted');
  });

  test('auto skip_low root, candidate has NO prescore: NOT eligible (reopens to review, inserts a reopened_skip queue row)', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'vp payments low', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 12 < floor 20' });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments low 2', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'repost', targetId: root }));
    assert.equal(out.status, 'review');
    assert.equal(/** @type {any} */ (out).sticky, false);
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(row.status, 'review');
    const openQueue = (await client.query('SELECT reason FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [cand])).rows;
    assert.equal(openQueue.length, 1);
    assert.equal(openQueue[0].reason, 'reopened_skip');
  });

  test('auto-skip-sticky: auto skip_low root becomes eligible when the CANDIDATE\'s own stored prescore is strictly below the triage floor', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'vp payments low elig', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 12 < floor 40' });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments low elig 2', locationNorm: 'dallas-tx', prescore: 10 });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: root, stickyFloor: 40 }));
    assert.equal(out.status, 'skip');
    assert.equal(/** @type {any} */ (out).sticky, true);
    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(row.status, 'skip');
    assert.equal(row.duplicate_of, root);
    const openQueue = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [cand])).rows[0].n;
    assert.equal(openQueue, 0, 'no reopened_skip queue row');
  });

  test('auto-skip-sticky: candidate prescore EQUAL to the floor is NOT eligible ("strictly below", not "at or below")', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'vp payments floor equal', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: noise_class=suspect' });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments floor equal 2', locationNorm: 'dallas-tx', prescore: 40 });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: root, stickyFloor: 40 }));
    assert.equal(/** @type {any} */ (out).sticky, false);
    assert.equal(out.status, 'review');
  });

  test('auto-skip-sticky: model-band auto skip with candidate prescore below floor is eligible (freeform note, not skip_noise-shaped)', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'vp payments model band', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'model band: not a fit for this profile' });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments model band 2', locationNorm: 'dallas-tx', prescore: 5 });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: root, stickyFloor: 40 }));
    assert.equal(/** @type {any} */ (out).sticky, true);
    assert.equal(out.status, 'skip');
  });

  test('auto-skip-sticky: an auto skip followed by a later non-status event on the root is NOT eligible, even with a qualifying candidate prescore', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'vp payments later event', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 12 < floor 40' });
    // A later, non-status event (e.g. a human note left on the root after the auto skip) means the root
    // was touched since -- no longer a purely unattended auto decision.
    await recordEvent(client, { listingId: root, kind: 'note', note: 'operator left a note after the auto skip', actor: 'dashboard' });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments later event 2', locationNorm: 'dallas-tx', prescore: 5 });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: root, stickyFloor: 40 }));
    assert.equal(/** @type {any} */ (out).sticky, false, 'a later non-status event on the root blocks eligibility');
    assert.equal(out.status, 'review');
  });

  test('auto-skip-sticky: human skip still eligible regardless of the candidate\'s prescore', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'vp payments human floor', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments human floor 2', locationNorm: 'dallas-tx', prescore: 95 });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });

    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: root, stickyFloor: 40 }));
    assert.equal(/** @type {any} */ (out).sticky, true);
    assert.equal(out.status, 'skip');
  });

  test('sticky status with no recorded status-change event at all is NOT eligible (fail closed)', async () => {
    // status set directly by the test fixture, never through an event -- simulates old, pre-event-log data.
    const root = await insertListing({ status: 'passed', titleNorm: 'vp payments no event', locationNorm: 'houston-tx' });
    const cand = await insertListing({ status: 'review', titleNorm: 'vp payments no event 2', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'title_similar_same_company' });
    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: root }));
    assert.equal(/** @type {any} */ (out).sticky, false);
    assert.equal(out.status, 'review');
  });

  test('target resolves to the candidate itself (matches[0] is already a duplicate of the candidate), reason reopened_skip -> closes with no listing change', async () => {
    const cand = await insertListing({ status: 'review', titleNorm: 'already root a', locationNorm: 'houston-tx' });
    // A row that ALREADY points its duplicate_of at the candidate: rootOf(dup) resolves to cand, so
    // targetId (dup) differs from cand.id (passes the earlier "target_id must differ" guard) while its
    // ROOT is the candidate itself -- the real-world shape of "the target this candidate matches
    // already resolves to the candidate itself" (a stale matches[] entry from before dup was merged).
    const dup = await insertListing({ status: 'review', titleNorm: 'already root a dup', dup: cand });
    const q = await insertQueueItem({ candidateId: cand, matches: [dup], reason: 'reopened_skip' });
    const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: dup }));
    assert.equal(/** @type {any} */ (out).note, 'already root');
    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(row.status, 'review', 'no listing change');
    assert.equal(row.duplicate_of, null);
    const qRow = (await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [q])).rows[0];
    assert.ok(qRow.resolved_at, 'queue row closed');
  });

  test('target resolves to the candidate itself for each of the four allowed reasons -> closes; any other reason still throws', async () => {
    const allowed = ['reopened_skip', 'same_source_hash_within_gap', 'title_renormalized', 'concurrent_review'];
    for (const reason of allowed) {
      const cand = await insertListing({ status: 'review', titleNorm: `already root ${reason}`, locationNorm: 'houston-tx' });
      const dup = await insertListing({ status: 'review', titleNorm: `already root dup ${reason}`, dup: cand });
      const q = await insertQueueItem({ candidateId: cand, matches: [dup], reason });
      const out = await withTransaction(client, (c) => resolveItem(c, { queueId: q, resolution: 'merge', targetId: dup }));
      assert.equal(/** @type {any} */ (out).note, 'already root', `reason ${reason} should close cleanly`);
    }
    const cand2 = await insertListing({ status: 'review', titleNorm: 'already root refused', locationNorm: 'houston-tx' });
    const dup2 = await insertListing({ status: 'review', titleNorm: 'already root refused dup', dup: cand2 });
    const q2 = await insertQueueItem({ candidateId: cand2, matches: [dup2], reason: 'url_reuse' });
    await assert.rejects(
      withTransaction(client, (c) => resolveItem(c, { queueId: q2, resolution: 'merge', targetId: dup2 })),
      /target resolves to the candidate itself/,
    );
  });
});

describe('sticky-skip part B: scan-time auto-merge (applyDecision / findStickySkipRoot)', () => {
  const OPTS = { trackingParams: DEFAULT_TRACKING_PARAMS, greenhouseBoards: [], aliases: {} };

  /**
   * Insert a "root" row from a real normalizeListing() output, so its company_norm/title_norm/
   * location_norm/dedup_hash are exactly what classify() will compute for a same-posting rec later --
   * no guessing normalizeCompany's suffix-stripping or normalizeTitle's segment logic by hand.
   * @param {{ title: string, company: string, location: string, url: string, source: string, salaryMax?: number|null }} raw
   * @param {{ status: string, salaryMax?: number|null }} extra
   */
  async function insertRootFromListing(raw, extra) {
    const rec0 = normalizeListing({ ...raw, description: null }, OPTS);
    const id = await insertListing({
      title: rec0.title, status: extra.status, source: rec0.source, url: rec0.url_normalized ?? `${raw.url}#root`,
      ext: rec0.external_id, companyNorm: rec0.company_norm, titleNorm: rec0.title_norm, locationNorm: rec0.location_norm,
      salaryMax: extra.salaryMax ?? null,
    });
    await client.query('UPDATE ic_job_listings SET dedup_hash = $2, last_seen = now() - interval \'60 days\' WHERE id = $1', [id, rec0.dedup_hash]);
    return id;
  }

  test('a repost of a human-skipped listing (same source, same title/company/location norms) auto-merges silently: no queue row, one sticky-skip event, status inherited', async () => {
    const raw = { title: 'Director of Engineering', company: 'Acme Widgets', location: 'Houston, TX', url: `https://example.test/${SRC}/repost-root`, source: 'greenhouse' };
    const root = await insertRootFromListing(raw, { status: 'skip' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });

    const rec = normalizeListing({ ...raw, url: `https://example.test/${SRC}/repost-new`, description: null }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '3-repost');
    assert.equal(decision.queue, true, 'premise: an ordinary repost of a skipped root would otherwise queue (reopened_skip)');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date() }));
    createdIds.push(applied.id);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, true);
    assert.equal(applied.queued, null);
    assert.equal(applied.status, 'skip');

    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.equal(row.status, 'skip');
    assert.equal(row.duplicate_of, root);
    const openQueue = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [applied.id])).rows[0].n;
    assert.equal(openQueue, 0);
    const events = await listEvents(client, applied.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].note, 'sticky skip');
    assert.equal(events[0].actor, 'auto');
  });

  test('SURFACE-EXCEPTION (salary jump > 10%) blocks the auto-merge: queues normally instead', async () => {
    const raw = { title: 'Director of Platform', company: 'Acme Platform Widgets', location: 'Houston, TX', url: `https://example.test/${SRC}/surface-root`, source: 'greenhouse' };
    const root = await insertRootFromListing(raw, { status: 'skip', salaryMax: 200000 });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });

    const rec = normalizeListing({ ...raw, url: `https://example.test/${SRC}/surface-new`, description: null, salaryMin: 250000, salaryMax: 250000 }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '3-repost');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date() }));
    createdIds.push(applied.id);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, false, 'surface exception must block the merge');
    assert.ok(applied.queued, 'falls back to an ordinary queued row');
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.equal(row.status, 'review');
  });

  test('an auto skip_low root never auto-merges when the incoming candidate has NO prescore in ctx (not STICKY-ELIGIBLE): queues normally', async () => {
    const raw = { title: 'Director of Low Prescore', company: 'Acme Low Widgets', location: 'Houston, TX', url: `https://example.test/${SRC}/lowskip-root`, source: 'greenhouse' };
    const root = await insertRootFromListing(raw, { status: 'skip' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 10 < floor 25' });

    const rec = normalizeListing({ ...raw, url: `https://example.test/${SRC}/lowskip-new`, description: null }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '3-repost');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date() }));
    createdIds.push(applied.id);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, false);
    assert.ok(applied.queued);
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.equal(row.status, 'review');
  });

  test('auto-skip-sticky: scan path passes the incoming candidate\'s own ctx.prescore -- an auto skip_low root auto-merges when it is below ctx.stickyFloor', async () => {
    const raw = { title: 'Director of Low Prescore Eligible', company: 'Acme Low Eligible Widgets', location: 'Houston, TX', url: `https://example.test/${SRC}/lowskip-elig-root`, source: 'greenhouse' };
    const root = await insertRootFromListing(raw, { status: 'skip' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 10 < floor 40' });

    const rec = normalizeListing({ ...raw, url: `https://example.test/${SRC}/lowskip-elig-new`, description: null }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '3-repost');

    // ctx.prescore is the candidate's own, already-computed prescore (src/core/scan-run.js passes it
    // as `ps`, computed before applyDecision runs); ctx.stickyFloor is the current triage floor.
    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date(), prescore: 8, stickyFloor: 40 }));
    createdIds.push(applied.id);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, true);
    assert.equal(applied.queued, null);
    assert.equal(applied.status, 'skip');
    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.equal(row.status, 'skip');
    assert.equal(row.duplicate_of, root);
  });

  test('auto-skip-sticky: scan path -- ctx.prescore at or above ctx.stickyFloor never merges into an auto-skipped root', async () => {
    const raw = { title: 'Director of High Prescore', company: 'Acme High Widgets', location: 'Houston, TX', url: `https://example.test/${SRC}/highskip-root`, source: 'greenhouse' };
    const root = await insertRootFromListing(raw, { status: 'skip' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 10 < floor 40' });

    const rec = normalizeListing({ ...raw, url: `https://example.test/${SRC}/highskip-new`, description: null }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '3-repost');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date(), prescore: 55, stickyFloor: 40 }));
    createdIds.push(applied.id);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, false);
    assert.ok(applied.queued);
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.equal(row.status, 'review');
  });

  test('1a-repost-same-id: human-skip root reactivates IN PLACE at the sticky status, no reopened_skip queue row (independent-review finding 1)', async () => {
    const linkedinId = String(910000000 + (process.pid % 9000000));
    const raw = { title: 'VP of Payments', company: 'Acme Linked Payments', location: 'Houston, TX', url: `https://www.linkedin.com/jobs/view/${linkedinId}/`, source: 'linkedin' };
    const root = await insertRootFromListing(raw, { status: 'skip' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });

    const rec = normalizeListing({ ...raw, description: null }, OPTS);
    assert.ok(rec.external_id, 'premise: a linkedin canonical URL normalizes to a real external_id');
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '1a-repost-same-id');
    assert.equal(decision.queue, true, 'premise: an ordinary repost of a skipped root would otherwise queue (reopened_skip)');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date() }));
    assert.equal(applied.id, root, 'same-row branch: the existing row is reactivated in place, never a new row');
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, true);
    assert.equal(applied.queued, null);
    assert.equal(applied.status, 'skip');

    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [root])).rows[0];
    assert.equal(row.status, 'skip');
    const openQueue = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [root])).rows[0].n;
    assert.equal(openQueue, 0, 'no reopened_skip queue row');
    const events = await listEvents(client, root);
    assert.equal(events.filter((e) => e.note === 'sticky skip').length, 1);
  });

  test('1a-repost-same-id: auto skip_low root is NOT eligible, falls through to ordinary reopened_skip', async () => {
    const linkedinId = String(920000000 + (process.pid % 9000000));
    const raw = { title: 'VP of Payments Low', company: 'Acme Linked Low', location: 'Houston, TX', url: `https://www.linkedin.com/jobs/view/${linkedinId}/`, source: 'linkedin' };
    const root = await insertRootFromListing(raw, { status: 'skip' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 8 < floor 20' });

    const rec = normalizeListing({ ...raw, description: null }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '1a-repost-same-id');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date() }));
    assert.equal(applied.id, root);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, false);
    assert.ok(applied.queued, 'falls back to an ordinary queued row');
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [root])).rows[0];
    assert.equal(row.status, 'review');
    const openQueue = (await client.query('SELECT reason FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [root])).rows;
    assert.equal(openQueue.length, 1);
    assert.equal(openQueue[0].reason, 'reopened_skip');
  });

  test('auto-skip-sticky: 1a-repost-same-id auto skip_low root becomes eligible when ctx.prescore is below ctx.stickyFloor (findStickySkipRootForSameRow)', async () => {
    const linkedinId = String(925000000 + (process.pid % 9000000));
    const raw = { title: 'VP of Payments Low Eligible', company: 'Acme Linked Low Eligible', location: 'Houston, TX', url: `https://www.linkedin.com/jobs/view/${linkedinId}/`, source: 'linkedin' };
    const root = await insertRootFromListing(raw, { status: 'skip' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 8 < floor 40' });

    const rec = normalizeListing({ ...raw, description: null }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '1a-repost-same-id');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date(), prescore: 6, stickyFloor: 40 }));
    assert.equal(applied.id, root);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, true);
    assert.equal(applied.queued, null);
    assert.equal(applied.status, 'skip');
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [root])).rows[0];
    assert.equal(row.status, 'skip');
    const openQueue = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [root])).rows[0].n;
    assert.equal(openQueue, 0, 'no reopened_skip queue row');
  });

  test('1a-repost-same-id: SURFACE-EXCEPTION (salary jump > 10%) blocks the merge, falls through to ordinary reopened_skip', async () => {
    const linkedinId = String(930000000 + (process.pid % 9000000));
    const raw = { title: 'VP of Payments Surface', company: 'Acme Linked Surface', location: 'Houston, TX', url: `https://www.linkedin.com/jobs/view/${linkedinId}/`, source: 'linkedin' };
    const root = await insertRootFromListing(raw, { status: 'skip', salaryMax: 200000 });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });

    const rec = normalizeListing({ ...raw, description: null, salaryMin: 250000, salaryMax: 250000 }, OPTS);
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '1a-repost-same-id');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date() }));
    assert.equal(applied.id, root);
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, false, 'surface exception must block the merge');
    assert.ok(applied.queued);
    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [root])).rows[0];
    assert.equal(row.status, 'review');
  });

  test('1b-repost-same-url: human-lost root reactivates IN PLACE at the sticky status, no reopened_lost queue row (independent-review finding 1)', async () => {
    const raw = { title: 'Director of Growth', company: 'Acme Residual Growth', location: 'Houston, TX', url: `https://example.test/${SRC}/1b-same-url`, source: 'manual' };
    const root = await insertRootFromListing(raw, { status: 'lost' });
    await insertStatusEvent({ listingId: root, toStatus: 'lost', actor: 'cli', note: null });

    // SAME url as the root (branch 1b keys off an exact url_normalized match, unlike 3-repost's
    // dedup_hash match against a DIFFERENT url) -- both sides carry a null external_id (a generic,
    // non-adapter host), so bothNull+contentMatch (matching title_norm) is what routes this to 1b.
    const rec = normalizeListing({ ...raw, description: null }, OPTS);
    assert.equal(rec.external_id, null, 'premise: a generic host normalizes to no external_id, forcing the url-match path');
    const lookups = makePgLookups(client);
    const decision = await classify(rec, lookups, {});
    assert.equal(decision.branch, '1b-repost-same-url');
    assert.equal(decision.queue, true, 'premise: an ordinary repost of a lost root would otherwise queue (reopened_lost)');

    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, { runId: null, now: new Date() }));
    assert.equal(applied.id, root, 'same-row branch: the existing row is reactivated in place, never a new row');
    assert.equal(/** @type {any} */ (applied).stickySkipMerged, true);
    assert.equal(applied.queued, null);
    assert.equal(applied.status, 'lost');

    const row = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [root])).rows[0];
    assert.equal(row.status, 'lost');
    const openQueue = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [root])).rows[0].n;
    assert.equal(openQueue, 0, 'no reopened_lost queue row');
    const events = await listEvents(client, root);
    assert.equal(events.filter((e) => e.note === 'sticky skip').length, 1);
  });
});

describe('sticky-skip part C: classifyForStickySkip (pure)', () => {
  const stickyRoot = { id: 5, status: 'skip', source: 's1', url_normalized: null, title_norm: 't', company_norm: 'c', location_norm: 'houston-tx', salary_max: null, apply_url: null, sticky_eligible: true };
  const cand = { id: 1, status: 'review', source: 's1', url_normalized: null, title_norm: 't', company_norm: 'c', location_norm: 'houston-tx', salary_max: null, apply_url: null };

  test('already resolved -> not_open', () => {
    assert.deepEqual(classifyForStickySkip({ resolution: 'separate', matches: [5] }, cand, [stickyRoot]), { decision: 'leave', reason: 'not_open' });
  });
  test('no candidate row -> candidate_missing', () => {
    assert.deepEqual(classifyForStickySkip({ matches: [5] }, null, [stickyRoot]), { decision: 'leave', reason: 'candidate_missing' });
  });
  test('empty matches -> no_matches', () => {
    assert.deepEqual(classifyForStickySkip({ matches: [] }, cand, []), { decision: 'leave', reason: 'no_matches' });
  });
  test('root not sticky_eligible -> no_sticky_match', () => {
    assert.deepEqual(classifyForStickySkip({ matches: [5] }, cand, [{ ...stickyRoot, sticky_eligible: false }]), { decision: 'leave', reason: 'no_sticky_match' });
  });
  test('root status not sticky -> no_sticky_match', () => {
    assert.deepEqual(classifyForStickySkip({ matches: [5] }, cand, [{ ...stickyRoot, status: 'applied' }]), { decision: 'leave', reason: 'no_sticky_match' });
  });
  test('matchTest fails -> no_sticky_match', () => {
    assert.deepEqual(classifyForStickySkip({ matches: [5] }, cand, [{ ...stickyRoot, title_norm: 'different' }]), { decision: 'leave', reason: 'no_sticky_match' });
  });
  test('a missing match row (null in roots array) is skipped, never throws', () => {
    assert.deepEqual(classifyForStickySkip({ matches: [5] }, cand, [null]), { decision: 'leave', reason: 'no_sticky_match' });
  });
  test('a qualifying root -> merge with its id', () => {
    assert.deepEqual(classifyForStickySkip({ matches: [5] }, cand, [stickyRoot]), { decision: 'merge', targetId: 5 });
  });
  test('lowest id wins when multiple roots qualify', () => {
    const rootHi = { ...stickyRoot, id: 9 };
    const rootLo = { ...stickyRoot, id: 3 };
    assert.deepEqual(classifyForStickySkip({ matches: [9, 3] }, cand, [rootHi, rootLo]), { decision: 'merge', targetId: 3 });
  });
  test('leave reasons are exactly the closed set', () => {
    assert.deepEqual([...STICKY_SKIP_LEAVE_REASONS].sort(), ['candidate_missing', 'no_matches', 'no_sticky_match', 'not_open'].sort());
  });
});

describe('sticky-skip part C: bulkResolve mode "sticky-skip"', () => {
  test('mode is a member of REVIEW_BULK_MODES', () => {
    assert.ok(REVIEW_BULK_MODES.includes('sticky-skip'));
  });

  test('dry-run: previews the merge count with zero writes', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'bulk sticky dry', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });
    const cand = await insertListing({ status: 'review', titleNorm: 'bulk sticky dry', locationNorm: 'houston-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'reopened_skip' });

    const out = await bulkResolve(deps, { mode: 'sticky-skip', dryRun: true, confirm: false });
    assert.equal(out.dryRun, true);
    assert.ok(out.ids.merged.includes(q));
    assert.equal(out.counts.merged >= 1, true);

    const qRow = (await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [q])).rows[0];
    assert.equal(qRow.resolved_at, null, 'dry run performs zero writes');
    const lRow = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(lRow.status, 'review');
    assert.equal(lRow.duplicate_of, null);
  });

  test('live run: resolves the qualifying item as merge into the sticky root; a non-qualifying item (no sticky match) is left', async () => {
    const root = await insertListing({ status: 'lost', titleNorm: 'bulk sticky live', locationNorm: 'dallas-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'lost', actor: 'cli', note: null });
    const cand = await insertListing({ status: 'review', titleNorm: 'bulk sticky live', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'reopened_lost' });

    const otherCand = await insertListing({ status: 'review', titleNorm: 'unrelated bulk sticky', locationNorm: 'houston-tx' });
    const otherMatch = await insertListing({ status: 'review', titleNorm: 'unrelated bulk sticky', locationNorm: 'dallas-tx' });
    const q2 = await insertQueueItem({ candidateId: otherCand, matches: [otherMatch], reason: 'title_similar_same_company' });

    const out = await bulkResolve(deps, { mode: 'sticky-skip', dryRun: false, confirm: true });
    assert.ok(out.ids.merged.includes(q));
    assert.ok(!out.ids.merged.includes(q2));
    assert.equal(out.counts.leave_by_reason.no_sticky_match >= 1, true);

    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(row.status, 'lost');
    assert.equal(row.duplicate_of, root);
    const otherRow = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [otherCand])).rows[0];
    assert.equal(otherRow.status, 'review', 'left open, not touched');
  });

  test('auto-skip-sticky: bulk path reads the STORED ic_job_listings.prescore of the queue row\'s candidate, not a freshly recomputed value', async () => {
    const lowRoot = await insertListing({ status: 'skip', titleNorm: 'bulk sticky low prescore', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: lowRoot, toStatus: 'skip', actor: 'auto', note: 'auto-triage: prescore 9 < floor 40' });
    const lowCand = await insertListing({ status: 'review', titleNorm: 'bulk sticky low prescore', locationNorm: 'houston-tx', prescore: 9 });
    const lowQ = await insertQueueItem({ candidateId: lowCand, matches: [lowRoot], reason: 'reopened_skip' });

    const highRoot = await insertListing({ status: 'skip', titleNorm: 'bulk sticky high prescore', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: highRoot, toStatus: 'skip', actor: 'auto', note: 'auto-triage: noise_class=suspect' });
    const highCand = await insertListing({ status: 'review', titleNorm: 'bulk sticky high prescore', locationNorm: 'houston-tx', prescore: 72 });
    const highQ = await insertQueueItem({ candidateId: highCand, matches: [highRoot], reason: 'reopened_skip' });

    const out = await bulkResolve(deps, { mode: 'sticky-skip', dryRun: false, confirm: true, stickyFloor: 40 });
    assert.ok(out.ids.merged.includes(lowQ), 'candidate stored prescore below the floor merges');
    assert.ok(!out.ids.merged.includes(highQ), 'candidate stored prescore at/above the floor never merges');

    const lowRow = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [lowCand])).rows[0];
    assert.equal(lowRow.status, 'skip');
    assert.equal(lowRow.duplicate_of, lowRoot);
    const highRow = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [highCand])).rows[0];
    assert.equal(highRow.status, 'review', 'left open, not merged');
  });
});

describe('sticky-skip part C: mode "stale" leaves sticky-eligible rows for mode "sticky-skip" (independent-review finding 2)', () => {
  test('an aged reopened_skip row with an eligible root is NOT separated by stale mode: left_for_sticky_skip, untouched', async () => {
    const root = await insertListing({ status: 'skip', titleNorm: 'stale sticky gate', locationNorm: 'houston-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'skip', actor: 'dashboard', note: null });
    const cand = await insertListing({ status: 'review', titleNorm: 'stale sticky gate', locationNorm: 'houston-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'reopened_skip' });
    await client.query(`UPDATE ic_job_review_queue SET created_at = now() - interval '90 days' WHERE id = $1`, [q]);

    // Control row: aged too, but no sticky match at all -- stale mode must still separate this one
    // normally, proving the sticky gate only carves out rows that actually classify as a merge.
    const plainCand = await insertListing({ status: 'review', titleNorm: 'stale plain aged' });
    const q2 = await insertQueueItem({ candidateId: plainCand, matches: [], reason: 'title_similar_same_company' });
    await client.query(`UPDATE ic_job_review_queue SET created_at = now() - interval '90 days' WHERE id = $1`, [q2]);

    const out = await bulkResolve(deps, { mode: 'stale', dryRun: false, confirm: true, reviewAutoSeparateDays: 30 });
    assert.ok(out.ids.left_for_sticky_skip.includes(q), 'the sticky-eligible aged row is carved out, not separated');
    assert.ok(!out.ids.separated.includes(q), 'never separated by stale mode');
    assert.ok(out.counts.left_for_sticky_skip >= 1);
    assert.ok(out.ids.separated.includes(q2), 'a plain aged row with no sticky match still separates normally');

    const candRow = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [cand])).rows[0];
    assert.equal(candRow.status, 'review', 'listing untouched');
    const qRow = (await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [q])).rows[0];
    assert.equal(qRow.resolved_at, null, 'queue row stays open, ready for mode:sticky-skip');
  });

  test('dry-run reports left_for_sticky_skip with zero writes, same as a live run', async () => {
    const root = await insertListing({ status: 'lost', titleNorm: 'stale sticky dry', locationNorm: 'dallas-tx' });
    await insertStatusEvent({ listingId: root, toStatus: 'lost', actor: 'mcp', note: null });
    const cand = await insertListing({ status: 'review', titleNorm: 'stale sticky dry', locationNorm: 'dallas-tx' });
    const q = await insertQueueItem({ candidateId: cand, matches: [root], reason: 'reopened_lost' });
    await client.query(`UPDATE ic_job_review_queue SET created_at = now() - interval '90 days' WHERE id = $1`, [q]);

    const out = await bulkResolve(deps, { mode: 'stale', dryRun: true, confirm: false, reviewAutoSeparateDays: 30 });
    assert.equal(out.dryRun, true);
    assert.ok(out.ids.left_for_sticky_skip.includes(q));
    const qRow = (await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [q])).rows[0];
    assert.equal(qRow.resolved_at, null);
  });
});

describe('sticky-skip part C: mode "reason" refuses reason "reopened_skip"', () => {
  test('refuses with a message pointing at mode sticky-skip, before touching the DB', async () => {
    await assert.rejects(
      bulkResolve(deps, { mode: 'reason', reason: 'reopened_skip', dryRun: true, confirm: false }),
      /sticky-skip/,
    );
  });
  test('other reason-mode reasons still work as before', async () => {
    const cand = await insertListing({ status: 'review', titleNorm: 'reason mode still works' });
    const q = await insertQueueItem({ candidateId: cand, matches: [], reason: 'branch1_conflict' });
    const out = await bulkResolve(deps, { mode: 'reason', reason: 'branch1_conflict', dryRun: true, confirm: false });
    assert.ok(out.ids.separated.includes(q));
  });
});
