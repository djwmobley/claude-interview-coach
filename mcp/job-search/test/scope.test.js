// @ts-check
/**
 * Dedup scope gate (spec v1 + amendments v2): src/core/scope.js (relevance gate, exact match),
 * dedup.js branch 3b, upsert.js applyDecision's live gate, and bulk mode 'scope' (backlog).
 *
 * DB-backed sections use the shared test DB (npm test), same convention as test/sticky-skip.test.js:
 * rows carry source `zz-test-scope-<pid>` / company `ZZ Scope Dental <pid>` and are deleted afterwards.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  scopeOf, scopeDetail, pairIsOutOfScope, isExactMatch, isGatedReason, isNeverGatedReason, hasSeniorityToken,
  SCOPE_FIT_FLOOR, SCOPE_GATED_REASONS, loadScopeProfiles,
} from '../src/core/scope.js';
import { classify, makeMemoryLookups, makePgLookups, BRANCHES } from '../src/core/dedup.js';
import { applyDecision } from '../src/core/upsert.js';
import { bulkResolve, REVIEW_BULK_MODES, REVIEW_BULK_SCOPE_MODE, SCAN_LOCK_KEY } from '../src/tools/review.js';
import { LOCK_KEY } from '../src/core/scan-run.js';
import { normalizeListing, dedupHash, DEFAULT_TRACKING_PARAMS } from '../src/core/normalize.js';
import { prescore } from '../src/core/prescore.js';
import { recordEvent, listEvents } from '../src/core/events.js';
import { withTransaction } from '../src/core/db.js';

const PROFILES = [{
  name: 'zz-scope', keywords: ['CTO', 'CIO', 'Chief Digital Officer'], phrases: ['VP Payments Strategy'], exclude_terms: ['intern', 'analyst'],
}];
const NO_TERMS = [{ name: 'empty', keywords: [], phrases: [], exclude_terms: [] }];

// ---------------------------------------------------------------------------
// Pure: scopeOf (A1 + F1 + F7 + F11)
// ---------------------------------------------------------------------------

describe('scope: scopeOf rules, first match wins', () => {
  const row = (/** @type {any} */ o) => ({ title: 'Dental Hygienist', status: null, status_actor: null, fit_score: null, prescore: 5, ...o });

  test('(a) profiles missing or without keywords/phrases -> unknown', () => {
    assert.equal(scopeOf(row({}), null), 'unknown');
    assert.equal(scopeOf(row({}), []), 'unknown');
    assert.equal(scopeOf(row({}), NO_TERMS), 'unknown');
    assert.equal(scopeDetail(row({ status: 'applied' }), []).rule, 'profiles_missing', 'rule (a) precedes even status');
  });
  test('(b) blank title -> unknown', () => {
    assert.equal(scopeOf(row({ title: '  ' }), PROFILES), 'unknown');
    assert.equal(scopeOf(row({ title: null }), PROFILES), 'unknown');
  });
  test('(c) any pipeline status other than null/review/skip/passed -> in (A5 targets always in)', () => {
    for (const s of ['applied', 'interviewing', 'offer', 'accepted', 'dead', 'lost', 'new', 'maybe', 'shortlisted', 'garbage']) {
      assert.equal(scopeOf(row({ status: s }), PROFILES), 'in', s);
    }
    assert.equal(scopeOf(row({ status: 'review' }), PROFILES), 'out', 'review falls through');
  });
  test('F7: skip/passed set by a human (or with no status event) -> in; set by auto -> falls through to scoring', () => {
    for (const s of ['skip', 'passed']) {
      for (const actor of ['dashboard', 'mcp', 'cli', null]) {
        assert.equal(scopeOf(row({ status: s, status_actor: actor }), PROFILES), 'in', `${s}/${actor}`);
      }
      assert.equal(scopeOf(row({ status: s, status_actor: 'auto' }), PROFILES), 'out', `${s}/auto low prescore`);
      assert.equal(scopeOf(row({ status: s, status_actor: 'auto', prescore: 55 }), PROFILES), 'in', `${s}/auto high prescore`);
    }
  });
  test('(d) fit_score >= SCOPE_FIT_FLOOR (40) -> in; 39 falls through', () => {
    assert.equal(SCOPE_FIT_FLOOR, 40);
    assert.equal(scopeDetail(row({ fit_score: 40 }), PROFILES).rule, 'fit_score');
    assert.equal(scopeOf(row({ fit_score: 39 }), PROFILES), 'out');
  });
  test('(e) titleMatches any profile -> in; a profile without terms never matches everything', () => {
    assert.equal(scopeDetail(row({ title: 'Interim CTO' }), PROFILES).rule, 'title_match');
    assert.equal(scopeOf(row({ title: 'Dental Hygienist' }), [...PROFILES, ...NO_TERMS]), 'out');
    const second = [{ name: 'b', keywords: ['Hygienist'], phrases: [], exclude_terms: [] }];
    assert.equal(scopeOf(row({ title: 'Dental Hygienist' }), [...PROFILES, ...second]), 'in', 'ANY profile (F12)');
  });
  test('F0: a title-gate drop verdict overrides F1 (row is out) while a passing exec title stays in', () => {
    for (const t of ['Director of IT', 'EVP Sales', 'Chief Financial Officer']) {
      assert.equal(hasSeniorityToken(t), true, `premise: ${t} carries a seniority token`);
      assert.deepEqual(scopeDetail(row({ title: t, prescore: 30 }), PROFILES), { scope: 'out', rule: 'title_gate' }, t);
    }
    assert.equal(scopeDetail(row({ title: 'Senior Director, Technology', prescore: 30 }), PROFILES).rule, 'seniority');
    assert.equal(scopeDetail(row({ title: 'Director of IT', status: 'applied', prescore: 30 }), PROFILES).rule, 'status', 'status rules still run first');
  });
  test('F1: exec seniority tokens are in regardless of prescore or exclude_terms', () => {
    const cio = { title: 'Chief Information Officer', location: 'Houston, TX', location_norm: 'houston-tx' };
    assert.equal(prescore(cio, {}), 30, 'premise: prescore 30, below the floor');
    assert.equal(scopeDetail(row({ title: cio.title, prescore: 30 }), PROFILES).rule, 'seniority');
    assert.equal(scopeDetail(row({ title: 'VP Digital Transformation', prescore: 26 }), PROFILES).rule, 'seniority');
    assert.equal(scopeOf(row({ title: 'VP Analyst Relations', prescore: 0 }), PROFILES), 'in', 'exclude term does not override F1');
    for (const t of ['SVP Operations', 'EVP Sales', 'Head of Platform', 'Managing Director', 'COO', 'CDO', 'CAIO', 'Senior Director, Ops', 'Director of IT']) {
      assert.equal(hasSeniorityToken(t), true, t);
    }
    assert.equal(scopeOf(row({ title: 'Dentist - DDS / DMD', prescore: 5 }), PROFILES), 'out');
    assert.equal(hasSeniorityToken('Dentist - DDS / DMD'), false);
  });
  test('(f) prescore null -> unknown, (g) prescore >= floor -> in, (h) else out', () => {
    assert.equal(scopeDetail(row({ prescore: null }), PROFILES).rule, 'prescore_null');
    assert.equal(scopeOf(row({ prescore: 40 }), PROFILES), 'in');
    assert.equal(scopeOf(row({ prescore: 39 }), PROFILES), 'out');
  });
  test('F11: prescore floor and fit floor are separate thresholds', () => {
    assert.equal(scopeOf(row({ prescore: 50 }), PROFILES, { prescoreFloor: 60 }), 'out', 'prescore floor from opts');
    assert.equal(scopeOf(row({ prescore: 0, fit_score: 45 }), PROFILES, { prescoreFloor: 60 }), 'in', 'fit floor unaffected by prescoreFloor');
    assert.equal(scopeOf(row({ prescore: 0, fit_score: 35 }), PROFILES, { prescoreFloor: 30 }), 'out', 'fit floor not lowered by prescoreFloor');
  });
});

describe('scope: pairIsOutOfScope (A2 + F2)', () => {
  const out = { scope: 'out', rule: 'below_floor' };
  test('all out with every match loaded -> out', () => {
    assert.equal(pairIsOutOfScope(out, [out, out], 2, 2).out, true);
  });
  test('F2: vacuous (no matches) or a missing match row -> queue', () => {
    assert.equal(pairIsOutOfScope(out, [], 0, 0).out, false);
    assert.equal(pairIsOutOfScope(out, [out], 2, 1).why, 'match_rows_missing');
  });
  test('one in or one unknown -> queue, with the reason recorded', () => {
    assert.equal(pairIsOutOfScope(out, [out, { scope: 'in', rule: 'status' }], 2, 2).why, 'scope_in');
    assert.equal(pairIsOutOfScope({ scope: 'unknown', rule: 'prescore_null' }, [out], 1, 1).why, 'scope_unknown:prescore_null');
  });
});

describe('scope: reason classification (A, A5)', () => {
  test('exactly the seven decided reasons are gated', () => {
    assert.deepEqual([...SCOPE_GATED_REASONS].sort(), [
      'company_description_match', 'company_similar_same_title', 'cross_source_uncorroborated', 'description_match_other_company',
      'hash_location_unknown', 'legacy_exact', 'title_similar_same_company',
    ]);
  });
  test('status-inheritance and identity reasons are never gated', () => {
    for (const r of ['reopened_skip', 'reopened_applied', 'concurrent_review', 'unrecognized_status', 'url_reuse', 'branch1_conflict', 'redirect_url', 'separate_blocked_unique', 'adopt_title_similar_same_company']) {
      assert.equal(isGatedReason(r), false, r);
      assert.equal(isNeverGatedReason(r), true, r);
    }
    assert.equal(isGatedReason('same_source_hash_within_gap'), false);
  });
});

describe('scope: isExactMatch (B1 + F4 + F10)', () => {
  const base = { source: 's', external_id: null, url_normalized: null, title_norm: 't', company_norm: 'c', location_norm: 'houston-tx', salary_max: null };
  test('same source, same norms, external_id null on both -> exact', () => {
    assert.equal(isExactMatch({ ...base }, { ...base }), true);
  });
  test('F4: different non-null external_id with everything else equal -> not exact', () => {
    assert.equal(isExactMatch({ ...base, external_id: 'a' }, { ...base, external_id: 'b' }), false);
    assert.equal(isExactMatch({ ...base, external_id: 'a' }, { ...base }), false, 'one side null, the other not');
  });
  test('F4: equal external_id, or equal url_normalized, ties identity', () => {
    assert.equal(isExactMatch({ ...base, external_id: 'a' }, { ...base, external_id: 'a' }), true);
    assert.equal(isExactMatch({ ...base, external_id: 'a', url_normalized: 'u' }, { ...base, external_id: 'b', url_normalized: 'u' }), true);
  });
  test('F10: a remote location needs equal non-null external_id', () => {
    const r = { ...base, location_norm: 'remote-us' };
    assert.equal(isExactMatch({ ...r }, { ...r }), false);
    assert.equal(isExactMatch({ ...r, url_normalized: 'u' }, { ...r, url_normalized: 'u' }), false);
    assert.equal(isExactMatch({ ...r, external_id: 'x' }, { ...r, external_id: 'x' }), true);
  });
  test('B1: absent/legacy/unknown locations, a different source, a differing norm, or a surface exception -> not exact', () => {
    for (const loc of ['absent', 'legacy-unknown', 'unknown:abc', null]) {
      assert.equal(isExactMatch({ ...base, location_norm: loc }, { ...base, location_norm: loc }), false, String(loc));
    }
    assert.equal(isExactMatch({ ...base, source: 'x' }, { ...base }), false);
    assert.equal(isExactMatch({ ...base, title_norm: 'u' }, { ...base }), false);
    assert.equal(isExactMatch({ ...base, title_norm: null }, { ...base, title_norm: null }), false);
    assert.equal(isExactMatch({ ...base, salary_max: 300000 }, { ...base, salary_max: 200000 }), false);
  });
});

// ---------------------------------------------------------------------------
// Pure: classify() branch 3b (B2 + F4 + F6 + F10)
// ---------------------------------------------------------------------------

describe('scope: classify branch 3b-same-source-live-dup', () => {
  const NOW = new Date('2026-10-01T12:00:00Z');
  const OPTS = { trackingParams: DEFAULT_TRACKING_PARAMS, greenhouseBoards: [], aliases: {} };
  const rec = (/** @type {any} */ o = {}) => normalizeListing({ source: 'zzsrc', url: null, title: 'Dental Hygienist', company: 'Acme Dental', location: 'Houston, TX', description: null, ...o }, OPTS);
  let seq = 900000;
  const row = (/** @type {any} */ r, /** @type {any} */ o = {}) => ({
    id: seq++, source: r.source, external_id: r.external_id, url_normalized: r.url_normalized, title: r.title, company: r.company,
    company_norm: r.company_norm, title_norm: r.title_norm, location_norm: r.location_norm, dedup_hash: r.dedup_hash,
    description_hash: null, posted_at: null, salary_min: null, salary_max: null, status: null, duplicate_of: null, repost_of: null,
    expired_at: null, last_seen: new Date(NOW.getTime() - 2 * 86400000), record_kind: 'listing', ...o,
  });

  test('BRANCHES carries the new branch', () => {
    assert.ok(BRANCHES.includes('3b-same-source-live-dup'));
  });
  test('one live exact root, external_id null on both -> 3b, cross_source_dup, rootId the root, no queue', async () => {
    const r = rec();
    assert.equal(r.external_id, null, 'premise');
    const root = row(r);
    const d = await classify(r, makeMemoryLookups([root]), { now: NOW });
    assert.equal(d.branch, '3b-same-source-live-dup');
    assert.equal(d.outcome, 'cross_source_dup');
    assert.equal(d.rootId, root.id);
    assert.equal(d.queue, false);
    assert.equal(d.fallback?.reason, 'same_source_hash_within_gap');
  });
  test('root plus its own duplicate -> still one root -> 3b', async () => {
    const r = rec();
    const root = row(r);
    const dup = row(r, { duplicate_of: root.id });
    const d = await classify(r, makeMemoryLookups([root, dup]), { now: NOW });
    assert.equal(d.branch, '3b-same-source-live-dup');
    assert.equal(d.rootId, root.id);
  });
  test('F4: stored row has a non-null external_id, candidate null -> stays 4-ambiguous', async () => {
    const r = rec();
    const d = await classify(r, makeMemoryLookups([row(r, { external_id: 'zzsrc:1' })]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'same_source_hash_within_gap');
  });
  test('F6: two independent roots -> stays 4-ambiguous', async () => {
    const r = rec();
    const d = await classify(r, makeMemoryLookups([row(r), row(r)]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
  });
  test('F5/C3: root status needs review (applied) -> stays queued', async () => {
    const r = rec();
    const d = await classify(r, makeMemoryLookups([row(r, { status: 'applied' })]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.queue, true);
  });
  test('F10: remote location with external_id null on both -> stays 4-ambiguous', async () => {
    const r = rec({ location: 'Houston, TX', remoteDeclared: true, remoteMode: 'remote' });
    assert.ok(String(r.location_norm).startsWith('remote-'), `premise: ${r.location_norm}`);
    const d = await classify(r, makeMemoryLookups([row(r)]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
  });
  test('past the repost gap stays 3-repost', async () => {
    const r = rec();
    const d = await classify(r, makeMemoryLookups([row(r, { last_seen: new Date(NOW.getTime() - 60 * 86400000) })]), { now: NOW });
    assert.equal(d.branch, '3-repost');
  });
  test('the dedup hash helper agrees with normalizeListing (fixture sanity)', () => {
    const r = rec();
    assert.equal(dedupHash(r.company_norm, r.title_norm, r.location_norm), r.dedup_hash);
  });
});

// ---------------------------------------------------------------------------
// DB-backed
// ---------------------------------------------------------------------------

const PID = process.pid;
const SRC = `zz-test-scope-${PID}`;
const CO = `Zzscope Dental ${PID}`;
/** Every company this file uses ends with this, so cleanup and parking can find them all. */
const CO_SUFFIX = ` Dental ${PID}`;
const NOPTS = { trackingParams: DEFAULT_TRACKING_PARAMS, greenhouseBoards: [], aliases: {} };
/** @type {pg.Client} */
let client;
/** @type {any} */
let deps;
/** @type {number[]} */
const createdIds = [];
const PROFILE_NAME = `zz-scope-profile-${PID}`;

/**
 * @param {string} title
 * @param {string} location
 * @param {string} [tag] company prefix; live-path tests each use their own company so one test's
 *   rows never show up in another test's classify() lookups
 */
function makeRec(title, location, tag) {
  const company = tag ? `${tag}${CO_SUFFIX}` : CO;
  return normalizeListing({ source: SRC, url: `https://example.test/${SRC}/${Math.floor(Math.random() * 1e9)}`, title, company, location, description: null }, NOPTS);
}

/**
 * Insert a stored row carrying a rec's normalized fields.
 * @param {any} rec
 * @param {Partial<{ status: string|null, prescore: number|null, fitScore: number|null, ext: string|null, dup: number|null, lastSeenDays: number, firstSeenDays: number, noiseClass: string|null }>} o
 */
async function insertFromRec(rec, o = {}) {
  const r = await client.query(
    `INSERT INTO ic_job_listings
       (title, company, status, url, url_normalized, source, external_id, record_kind, location, company_norm, title_norm, location_norm,
        dedup_hash, first_seen, last_seen, duplicate_of, prescore, fit_score, noise_class)
     VALUES ($1,$2,$3,$4,$4,$5,$6,'listing',$7,$8,$9,$10,$11, now() - make_interval(days => $12), now() - make_interval(days => $13), $14, $15, $16, $17) RETURNING id`,
    [
      rec.title, rec.company, o.status ?? null, `${rec.url_normalized}#${Math.floor(Math.random() * 1e9)}`, rec.source, 'ext' in o ? o.ext : rec.external_id,
      rec.location, rec.company_norm, rec.title_norm, rec.location_norm, rec.dedup_hash, o.firstSeenDays ?? 0, o.lastSeenDays ?? 0,
      o.dup ?? null, 'prescore' in o ? o.prescore : 5, o.fitScore ?? null, 'noiseClass' in o ? o.noiseClass : null,
    ],
  );
  const id = Number(r.rows[0].id);
  createdIds.push(id);
  return id;
}

/** @param {{ candidateId: number, matches: number[], reason: string, statusAtCreate?: string|null }} o */
async function insertQueueItem(o) {
  const r = await client.query(
    'INSERT INTO ic_job_review_queue (candidate_id, matches, reason, status_at_create) VALUES ($1, $2::int[], $3, $4) RETURNING id',
    [o.candidateId, o.matches, o.reason, 'statusAtCreate' in o ? o.statusAtCreate : 'review'],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  const byCo = (await client.query("SELECT id FROM ic_job_listings WHERE company LIKE '%' || $1", [CO_SUFFIX])).rows.map((r) => Number(r.id));
  const ids = [...new Set([...createdIds, ...byCo])];
  if (ids.length) {
    await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await client.query('DELETE FROM ic_search_profiles WHERE name = $1', [PROFILE_NAME]);
  createdIds.length = 0;
}

/** Close every open queue item that is not this file's, so backlog runs only see this file's items. */
async function parkForeignOpenItems() {
  await client.query(
    `UPDATE ic_job_review_queue SET resolution = 'separate', resolved_at = now()
     WHERE resolved_at IS NULL AND (candidate_id IS NULL OR candidate_id NOT IN (SELECT id FROM ic_job_listings WHERE company LIKE '%' || $1))`,
    [CO_SUFFIX],
  );
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
  deps = { withClient: async (/** @type {any} */ fn) => fn(client) };
});
after(async () => {
  await cleanup();
  await client.end();
});

const liveCtx = (/** @type {any} */ o = {}) => ({ runId: null, now: new Date(), scopeProfiles: PROFILES, scopePrescoreFloor: 40, prescore: 5, ...o });

async function openItems(/** @type {number} */ id) {
  return (await client.query('SELECT id, reason FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [id])).rows;
}

describe('scope: live gate in applyDecision (A3/A4/A5, B3, F2, F7)', () => {
  test('out-of-scope pair: inserted as new, no open queue row, an already-resolved audit row, scopeSeparated', async () => {
    const stored = await insertFromRec(makeRec('Dental Hygienist Lead', 'Houston, TX', 'Aardvark'), { prescore: 5 });
    const rec = makeRec('Dental Hygienist', 'Houston, TX', 'Aardvark');
    const decision = await classify(rec, makePgLookups(client), {});
    assert.equal(decision.reason, 'title_similar_same_company', 'premise');
    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, liveCtx()));
    createdIds.push(applied.id);
    assert.equal(applied.outcome, 'new');
    assert.equal(applied.queued, null);
    assert.equal(applied.scopeSeparated, true);
    assert.equal(applied.scopeRule, 'scope');
    assert.equal(applied.status, null);
    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [applied.id])).rows[0];
    assert.equal(row.status, null);
    assert.equal(row.duplicate_of, null);
    assert.equal((await openItems(applied.id)).length, 0);
    const audit = (await client.query('SELECT reason, resolution, resolved_at, matches FROM ic_job_review_queue WHERE candidate_id = $1', [applied.id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].resolution, 'separate');
    assert.ok(audit[0].resolved_at);
    assert.equal(audit[0].reason, 'title_similar_same_company');
    assert.deepEqual(audit[0].matches, [stored]);
  });

  test('candidate in scope (prescore at the floor) -> queued as before', async () => {
    await insertFromRec(makeRec('Dental Surgeon Lead', 'Houston, TX', 'Bison'), { prescore: 5 });
    const rec = makeRec('Dental Surgeon', 'Houston, TX', 'Bison');
    const decision = await classify(rec, makePgLookups(client), {});
    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, liveCtx({ prescore: 40 })));
    createdIds.push(applied.id);
    assert.equal(applied.outcome, 'ambiguous');
    assert.ok(applied.queued);
    assert.equal(applied.scopeSeparated, false);
  });

  test('F1 live: "VP" candidate with prescore 26 -> queued', async () => {
    await insertFromRec(makeRec('VP Dental Operations Lead', 'Houston, TX', 'Cheetah'), { prescore: 5 });
    const rec = makeRec('VP Dental Operations', 'Houston, TX', 'Cheetah');
    const decision = await classify(rec, makePgLookups(client), {});
    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, liveCtx({ prescore: 26 })));
    createdIds.push(applied.id);
    assert.ok(applied.queued);
  });

  test('unknown signal (candidate prescore null) or no profiles in ctx -> queued', async () => {
    await insertFromRec(makeRec('Dental Biller Lead', 'Houston, TX', 'Dingo'), { prescore: 5 });
    const rec1 = makeRec('Dental Biller', 'Houston, TX', 'Dingo');
    const d1 = await classify(rec1, makePgLookups(client), {});
    assert.equal(d1.reason, 'title_similar_same_company', 'premise');
    const a1 = await withTransaction(client, (c) => applyDecision(c, rec1, d1, liveCtx({ prescore: null })));
    createdIds.push(a1.id);
    assert.ok(a1.queued, 'prescore null -> unknown -> queue');
    await insertFromRec(makeRec('Dental Biller Lead', 'Houston, TX', 'Emu'), { prescore: 5 });
    const rec2 = makeRec('Dental Biller', 'Houston, TX', 'Emu');
    const d2 = await classify(rec2, makePgLookups(client), {});
    assert.equal(d2.reason, 'title_similar_same_company', 'premise');
    const a2 = await withTransaction(client, (c) => applyDecision(c, rec2, d2, liveCtx({ scopeProfiles: undefined })));
    createdIds.push(a2.id);
    assert.ok(a2.queued, 'no profiles -> queue');
  });

  test('F7: matched row skipped by a human -> queued; skipped by auto -> separated', async () => {
    const humanSkip = await insertFromRec(makeRec('Dental Courier Lead', 'Houston, TX', 'Falcon'), { status: 'skip', prescore: 5 });
    await recordEvent(client, { listingId: humanSkip, kind: 'status', toStatus: 'skip', actor: 'dashboard' });
    const rec1 = makeRec('Dental Courier', 'Houston, TX', 'Falcon');
    const d1 = await classify(rec1, makePgLookups(client), {});
    assert.deepEqual(d1.matches, [humanSkip], 'premise');
    const a1 = await withTransaction(client, (c) => applyDecision(c, rec1, d1, liveCtx()));
    createdIds.push(a1.id);
    assert.ok(a1.queued, 'human skip is in scope');

    const autoSkip = await insertFromRec(makeRec('Dental Driver Lead', 'Houston, TX', 'Gecko'), { status: 'skip', prescore: 5 });
    await recordEvent(client, { listingId: autoSkip, kind: 'status', toStatus: 'skip', actor: 'auto' });
    const rec2 = makeRec('Dental Driver', 'Houston, TX', 'Gecko');
    const d2 = await classify(rec2, makePgLookups(client), {});
    assert.deepEqual(d2.matches, [autoSkip], 'premise');
    // The sticky auto-merge never fires here: its MATCH-TEST needs identical title_norm, and the titles differ.
    const a2 = await withTransaction(client, (c) => applyDecision(c, rec2, d2, liveCtx()));
    createdIds.push(a2.id);
    assert.equal(a2.stickySkipMerged, false, 'premise: titles differ, no sticky merge');
    assert.equal(a2.scopeSeparated, true, 'auto skip falls through to scoring -> out');
  });

  test('F2: a match id with no row -> queued', async () => {
    const stored = await insertFromRec(makeRec('Dental Porter Lead', 'Houston, TX', 'Heron'), { prescore: 5 });
    const rec = makeRec('Dental Porter', 'Houston, TX', 'Heron');
    const decision = { branch: '4-ambiguous', outcome: /** @type {const} */ ('ambiguous'), target: null, rootId: null, repostOf: null, inherit: null, reason: 'title_similar_same_company', matches: [stored, 2147480000], queue: true };
    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, liveCtx()));
    createdIds.push(applied.id);
    assert.ok(applied.queued);
    assert.equal(applied.scopeSeparated, false);
  });

  test('A5: status-inheritance and never-gated reasons queue even when every row is out', async () => {
    const rec0 = makeRec('Dental Janitor', 'Houston, TX', 'Ibis');
    const stale = await insertFromRec(rec0, { status: 'review', prescore: 5, lastSeenDays: 60 });
    const rec = makeRec('Dental Janitor', 'Houston, TX', 'Ibis');
    const d = await classify(rec, makePgLookups(client), {});
    assert.equal(d.branch, '3-repost', 'premise');
    assert.equal(d.reason, 'concurrent_review', 'premise');
    const a = await withTransaction(client, (c) => applyDecision(c, rec, d, liveCtx()));
    createdIds.push(a.id);
    assert.ok(a.queued);
    assert.equal(a.scopeSeparated, false);

    const recU = makeRec('Dental Janitor', 'Houston, TX', 'Ibis');
    const urlReuse = { branch: '4-ambiguous', outcome: /** @type {const} */ ('ambiguous'), target: null, rootId: null, repostOf: null, inherit: null, reason: 'url_reuse', matches: [stale], queue: true };
    const aU = await withTransaction(client, (c) => applyDecision(c, recU, urlReuse, liveCtx()));
    createdIds.push(aU.id);
    assert.ok(aU.queued);
  });

  test('B3 live: same title, different eligible non-remote location -> separated by rule location, even in scope', async () => {
    await insertFromRec(makeRec('Dental Hygienist Supervisor', 'Houston, TX', 'Jackal'), { prescore: 70 });
    const rec = makeRec('Dental Hygienist Supervisor', 'Dallas, TX', 'Jackal');
    const d = await classify(rec, makePgLookups(client), {});
    assert.equal(d.reason, 'title_similar_same_company', 'premise');
    const a = await withTransaction(client, (c) => applyDecision(c, rec, d, liveCtx({ prescore: 70 })));
    createdIds.push(a.id);
    assert.equal(a.scopeSeparated, true);
    assert.equal(a.scopeRule, 'location');
    assert.equal(a.outcome, 'new');
  });
});

describe('scope: live branch 3b (B2, F5)', () => {
  test('exact same-source live match -> duplicate_of the root, status inherited, no queue row', async () => {
    const root = await insertFromRec(makeRec('Dental Scheduler', 'Austin, TX', 'Koala'), { status: 'new', ext: null });
    const rec = makeRec('Dental Scheduler', 'Austin, TX', 'Koala');
    assert.equal(rec.external_id, null, 'premise: generic host carries no external id');
    const d = await classify(rec, makePgLookups(client), {});
    assert.equal(d.branch, '3b-same-source-live-dup');
    const a = await withTransaction(client, (c) => applyDecision(c, rec, d, liveCtx()));
    createdIds.push(a.id);
    assert.equal(a.outcome, 'cross_source_dup');
    assert.equal(a.queued, null);
    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [a.id])).rows[0];
    assert.equal(row.duplicate_of, root);
    assert.equal(row.status, 'new');
  });

  test('F5: root status re-read inside the transaction; applied since classify -> falls back to the queued decision', async () => {
    const root = await insertFromRec(makeRec('Dental Receptionist', 'Austin, TX', 'Lemur'), { ext: null });
    const rec = makeRec('Dental Receptionist', 'Austin, TX', 'Lemur');
    const d = await classify(rec, makePgLookups(client), {});
    assert.equal(d.branch, '3b-same-source-live-dup', 'premise');
    await client.query("UPDATE ic_job_listings SET status = 'applied' WHERE id = $1", [root]);
    const a = await withTransaction(client, (c) => applyDecision(c, rec, d, liveCtx()));
    createdIds.push(a.id);
    assert.equal(a.outcome, 'ambiguous');
    assert.ok(a.queued);
    assert.equal(a.branch, '4-ambiguous');
    const row = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [a.id])).rows[0];
    assert.equal(row.duplicate_of, null);
    assert.equal(row.status, 'review');
  });

  test('F5: match is a duplicate of an applied root -> never silently merged', async () => {
    const recR = makeRec('Dental Treasurer', 'Austin, TX', 'Marmot');
    const root = await insertFromRec(recR, { status: 'applied', ext: null });
    await insertFromRec(recR, { dup: root, ext: null });
    const rec = makeRec('Dental Treasurer', 'Austin, TX', 'Marmot');
    const d = await classify(rec, makePgLookups(client), {});
    assert.equal(d.branch, '4-ambiguous');
    const a = await withTransaction(client, (c) => applyDecision(c, rec, d, liveCtx()));
    createdIds.push(a.id);
    assert.ok(a.queued);
  });

  test('F4 live: same everything but different external_id -> queued', async () => {
    const recR = makeRec('Dental Planner', 'Austin, TX', 'Newt');
    await insertFromRec(recR, { ext: `${SRC}:one` });
    const rec = makeRec('Dental Planner', 'Austin, TX', 'Newt');
    const d = await classify(rec, makePgLookups(client), {});
    assert.equal(d.reason, 'same_source_hash_within_gap');
    const a = await withTransaction(client, (c) => applyDecision(c, rec, d, liveCtx()));
    createdIds.push(a.id);
    assert.ok(a.queued);
  });
});

describe('scope: loadScopeProfiles (F12)', () => {
  test('returns every ic_search_profiles row', async () => {
    await client.query("INSERT INTO ic_search_profiles (name, keywords, phrases, exclude_terms, rev) VALUES ($1, '{Hygienist}', '{}', '{}', 'x')", [PROFILE_NAME]);
    const all = await loadScopeProfiles(client);
    const mine = all.find((p) => p.name === PROFILE_NAME);
    assert.ok(mine);
    assert.deepEqual(mine.keywords, ['Hygienist']);
    const n = (await client.query('SELECT count(*)::int AS n FROM ic_search_profiles')).rows[0].n;
    assert.equal(all.length, n);
    await client.query('DELETE FROM ic_search_profiles WHERE name = $1', [PROFILE_NAME]);
  });
});

describe('scope: backlog bulk mode "scope" (C, F3, F5, F7, F8, F9)', () => {
  before(async () => {
    await cleanup();
    await parkForeignOpenItems();
  });

  const run = (/** @type {any} */ o) => bulkResolve(deps, {
    mode: 'scope', dryRun: true, confirm: false, profiles: PROFILES, prescoreFloor: 40, repostGapDays: 30,
    triageConfig: { deterministic: { enabled: true, floor: 40, ceiling: 70 } }, ...o,
  });
  const leftReason = (/** @type {any} */ out, /** @type {number} */ q) => out.ids.left.find((x) => x.id === q)?.reason;

  test('mode is CLI-only: not in REVIEW_BULK_MODES; lock key pinned to scan-run.js', () => {
    assert.equal(REVIEW_BULK_SCOPE_MODE, 'scope');
    assert.equal(REVIEW_BULK_MODES.includes('scope'), false);
    assert.equal(SCAN_LOCK_KEY, LOCK_KEY);
  });

  test('a live run without confirm is refused', async () => {
    await assert.rejects(run({ dryRun: false, confirm: false }), /confirm must be true/);
  });

  /** @type {Record<string, number>} */
  const q = {};
  /** @type {Record<string, number>} */
  const cand = {};

  test('fixture: one item per branch', async () => {
    // out-of-scope pair, different titles, same location
    cand.out = await insertFromRec(makeRec('Dental Hygienist', 'Houston, TX'), { status: 'review', prescore: 5 });
    const outMatch = await insertFromRec(makeRec('Dental Assistant', 'Houston, TX'), { prescore: 5 });
    q.out = await insertQueueItem({ candidateId: cand.out, matches: [outMatch], reason: 'title_similar_same_company' });
    // null prescore -> unknown
    cand.nullPs = await insertFromRec(makeRec('Dental Clerk', 'Houston, TX'), { status: 'review', prescore: null });
    const m2 = await insertFromRec(makeRec('Dental Clerk II', 'Houston, TX'), { prescore: 5 });
    q.nullPs = await insertQueueItem({ candidateId: cand.nullPs, matches: [m2], reason: 'title_similar_same_company' });
    // F3: two open items on one candidate
    cand.twice = await insertFromRec(makeRec('Dental Tech', 'Houston, TX'), { status: 'review', prescore: 5 });
    const m3 = await insertFromRec(makeRec('Dental Tech II', 'Houston, TX'), { prescore: 5 });
    q.twiceA = await insertQueueItem({ candidateId: cand.twice, matches: [m3], reason: 'title_similar_same_company' });
    q.twiceB = await insertQueueItem({ candidateId: cand.twice, matches: [m3], reason: 'company_similar_same_title' });
    // F3: status_at_create other than review
    cand.sac = await insertFromRec(makeRec('Dental Aide', 'Houston, TX'), { status: 'review', prescore: 5 });
    const m4 = await insertFromRec(makeRec('Dental Aide II', 'Houston, TX'), { prescore: 5 });
    q.sac = await insertQueueItem({ candidateId: cand.sac, matches: [m4], reason: 'title_similar_same_company', statusAtCreate: 'skip' });
    // B merge: exact same-source root, seen recently
    const recM = makeRec('Dental Coordinator', 'Austin, TX');
    const rootM = await insertFromRec(recM, { ext: null });
    cand.merge = await insertFromRec(recM, { status: 'review', ext: null });
    q.merge = await insertQueueItem({ candidateId: cand.merge, matches: [rootM], reason: 'same_source_hash_within_gap' });
    cand.mergeRoot = rootM;
    // B repost: exact root last seen 90 days before the candidate first appeared
    const recP = makeRec('Dental Office Manager', 'Austin, TX');
    const rootP = await insertFromRec(recP, { ext: null, lastSeenDays: 90 });
    cand.repost = await insertFromRec(recP, { status: 'review', ext: null, prescore: 5 });
    q.repost = await insertQueueItem({ candidateId: cand.repost, matches: [rootP], reason: 'title_similar_same_company' });
    cand.repostRoot = rootP;
    // F4 backlog: same everything, different external ids, not a gated reason -> left
    const recF4 = makeRec('Dental Lab Tech', 'Austin, TX');
    const rootF4 = await insertFromRec(recF4, { ext: `${SRC}:a` });
    cand.f4 = await insertFromRec(recF4, { status: 'review', ext: `${SRC}:b` });
    q.f4 = await insertQueueItem({ candidateId: cand.f4, matches: [rootF4], reason: 'same_source_hash_within_gap' });
    // F5 backlog: match is a duplicate of an applied root (exact) -> B skipped, root in scope -> left scope_in
    const recF5 = makeRec('Dental Sterilizer', 'Austin, TX');
    const rootF5 = await insertFromRec(recF5, { status: 'applied', ext: null });
    const dupF5 = await insertFromRec(recF5, { dup: rootF5, ext: null });
    cand.f5 = await insertFromRec(recF5, { status: 'review', ext: null });
    q.f5 = await insertQueueItem({ candidateId: cand.f5, matches: [dupF5], reason: 'title_similar_same_company' });
    // F6 backlog: two roots -> no B; both out -> separated by scope
    cand.f6 = await insertFromRec(makeRec('Dental Billing Clerk', 'Austin, TX'), { status: 'review' });
    const r6a = await insertFromRec(makeRec('Dental Billing Clerk I', 'Austin, TX'));
    const r6b = await insertFromRec(makeRec('Dental Billing Clerk II', 'Austin, TX'));
    q.f6 = await insertQueueItem({ candidateId: cand.f6, matches: [r6a, r6b], reason: 'title_similar_same_company' });
    // F7 backlog: human skip -> left; auto skip -> separated
    cand.f7h = await insertFromRec(makeRec('Dental Runner', 'Austin, TX'), { status: 'review' });
    const s7h = await insertFromRec(makeRec('Dental Runner Lead', 'Austin, TX'), { status: 'skip' });
    await recordEvent(client, { listingId: s7h, kind: 'status', toStatus: 'skip', actor: 'cli' });
    q.f7h = await insertQueueItem({ candidateId: cand.f7h, matches: [s7h], reason: 'title_similar_same_company' });
    cand.f7a = await insertFromRec(makeRec('Dental Mover', 'Austin, TX'), { status: 'review' });
    const s7a = await insertFromRec(makeRec('Dental Mover Lead', 'Austin, TX'), { status: 'skip' });
    await recordEvent(client, { listingId: s7a, kind: 'status', toStatus: 'skip', actor: 'auto' });
    q.f7a = await insertQueueItem({ candidateId: cand.f7a, matches: [s7a], reason: 'title_similar_same_company' });
    // F10 backlog: remote, external ids null -> not exact; same_source reason not gated -> left
    const recR = normalizeListing({ source: SRC, url: `https://example.test/${SRC}/remote-coder`, title: 'Dental Coder', company: CO, location: 'Houston, TX', remoteDeclared: true, remoteMode: 'remote', description: null }, NOPTS);
    assert.ok(String(recR.location_norm).startsWith('remote-'), `premise: ${recR.location_norm}`);
    const rootR = await insertFromRec(recR, { ext: null });
    cand.f10 = await insertFromRec(recR, { status: 'review', ext: null });
    q.f10 = await insertQueueItem({ candidateId: cand.f10, matches: [rootR], reason: 'same_source_hash_within_gap' });
    // A5 backlog: status-inheritance reason -> never touched
    cand.inh = await insertFromRec(makeRec('Dental Greeter', 'Austin, TX'), { status: 'review' });
    const mInh = await insertFromRec(makeRec('Dental Greeter', 'Austin, TX'));
    q.inh = await insertQueueItem({ candidateId: cand.inh, matches: [mInh], reason: 'reopened_skip' });
    // B3 backlog: same title, different location
    cand.loc = await insertFromRec(makeRec('Dental Hygiene Director', 'Austin, TX'), { status: 'review', prescore: 80 });
    const mLoc = await insertFromRec(makeRec('Dental Hygiene Director', 'El Paso, TX'), { prescore: 80 });
    q.loc = await insertQueueItem({ candidateId: cand.loc, matches: [mLoc], reason: 'title_similar_same_company' });
    // in scope: candidate fit_score 60
    cand.in = await insertFromRec(makeRec('Dental Strategist', 'Austin, TX'), { status: 'review', fitScore: 60 });
    const mIn = await insertFromRec(makeRec('Dental Strategist Lead', 'Austin, TX'));
    q.in = await insertQueueItem({ candidateId: cand.in, matches: [mIn], reason: 'title_similar_same_company' });
  });

  test('dry run: every item classified, zero writes', async () => {
    const before = (await client.query('SELECT count(*)::int AS n FROM ic_job_events')).rows[0].n;
    const out = await run({});
    assert.equal(out.dryRun, true);
    assert.ok(out.ids.separated.includes(q.out));
    assert.equal(leftReason(out, q.nullPs), 'scope_unknown:prescore_null');
    assert.equal(leftReason(out, q.twiceA), 'other_open_item');
    assert.equal(leftReason(out, q.twiceB), 'other_open_item');
    assert.equal(leftReason(out, q.sac), 'status_at_create');
    assert.ok(out.ids.merged.includes(q.merge));
    assert.ok(out.ids.reposted.includes(q.repost));
    assert.equal(leftReason(out, q.f4), 'reason_not_gated');
    assert.equal(leftReason(out, q.f5), 'scope_in');
    assert.ok(out.ids.separated.includes(q.f6));
    assert.equal(leftReason(out, q.f7h), 'scope_in');
    assert.ok(out.ids.separated.includes(q.f7a));
    assert.equal(leftReason(out, q.f10), 'reason_not_gated');
    assert.equal(leftReason(out, q.inh), 'reason_not_eligible');
    assert.ok(out.ids.separated.includes(q.loc));
    assert.equal(leftReason(out, q.in), 'scope_in');
    assert.equal(out.counts.separated_by_rule.location, 1);

    const open = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE id = ANY($1::int[]) AND resolved_at IS NULL', [Object.values(q)])).rows[0].n;
    assert.equal(open, Object.values(q).length, 'dry run resolves nothing');
    const status = (await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [cand.out])).rows[0].status;
    assert.equal(status, 'review');
    const after = (await client.query('SELECT count(*)::int AS n FROM ic_job_events')).rows[0].n;
    assert.equal(after, before, 'no events written');
  });

  test('F8: scan lock held elsewhere -> LOCKED, no changes', async () => {
    const other = new pg.Client(pgConnectionConfig());
    await other.connect();
    try {
      const got = await other.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [SCAN_LOCK_KEY]);
      assert.equal(got.rows[0].ok, true, 'premise: test holds the lock');
      await assert.rejects(run({ dryRun: false, confirm: true }), (err) => /** @type {any} */ (err).code === 'LOCKED' && /scan advisory lock is held/.test(String(/** @type {any} */ (err).message)));
      const open = (await client.query('SELECT count(*)::int AS n FROM ic_job_review_queue WHERE id = ANY($1::int[]) AND resolved_at IS NULL', [Object.values(q)])).rows[0].n;
      assert.equal(open, Object.values(q).length);
    } finally {
      await other.query('SELECT pg_advisory_unlock($1::bigint)', [SCAN_LOCK_KEY]);
      await other.end();
    }
  });

  test('live run: resolves per the dry run, actor auto, then triages the rows returned to status null (F9)', async () => {
    const out = await run({ dryRun: false, confirm: true });
    assert.equal(out.counts.errors, 0, JSON.stringify(out.ids.errors));
    assert.ok(out.ids.separated.includes(q.out));
    assert.ok(out.ids.merged.includes(q.merge));
    assert.ok(out.ids.reposted.includes(q.repost));
    assert.ok(out.ids.separated.includes(q.f7a));

    const c = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [cand.out])).rows[0];
    assert.equal(c.status, 'skip', 'separated (null) then auto-triaged: noise_class null -> skip_noise');
    const ev = await listEvents(client, cand.out);
    assert.ok(ev.some((e) => e.note === 'resolved:separate:bulk:scope' && e.actor === 'auto'));
    assert.ok(Number(out.counts.triage.skip_noise) >= 1);
    assert.ok(Number(out.counts.triage.marked) >= 1);

    const m = (await client.query('SELECT status, duplicate_of FROM ic_job_listings WHERE id = $1', [cand.merge])).rows[0];
    assert.equal(m.duplicate_of, cand.mergeRoot);
    const r = (await client.query('SELECT repost_of, duplicate_of FROM ic_job_listings WHERE id = $1', [cand.repost])).rows[0];
    assert.equal(r.repost_of, cand.repostRoot);
    assert.equal(r.duplicate_of, null);

    for (const key of ['nullPs', 'twiceA', 'twiceB', 'sac', 'f4', 'f5', 'f7h', 'f10', 'inh', 'in']) {
      const row = (await client.query('SELECT resolved_at FROM ic_job_review_queue WHERE id = $1', [q[key]])).rows[0];
      assert.equal(row.resolved_at, null, `${key} stays open`);
    }
    const lock = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [SCAN_LOCK_KEY])).rows[0].ok;
    assert.equal(lock, true, 'lock released after the run');
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [SCAN_LOCK_KEY]);
  });

  test('idempotent: a second live run changes nothing already resolved', async () => {
    const snapshot = async () => (await client.query('SELECT id, status, duplicate_of, repost_of FROM ic_job_listings WHERE company = $1 ORDER BY id', [CO])).rows;
    const before = await snapshot();
    const out = await run({ dryRun: false, confirm: true });
    assert.equal(out.counts.merged + out.counts.reposted + out.counts.separated, 0);
    assert.deepEqual(await snapshot(), before);
  });
});
