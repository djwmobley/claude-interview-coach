// @ts-check
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  classify, BRANCHES, OUTCOMES, inheritStatus, selectTarget, isLive, groupMaxLastSeen, trigramSimilarity,
  makeMemoryLookups, makePgLookups,
} from '../src/core/dedup.js';
import { normalizeListing, normalizeTitle, normalizeCompany, dedupHash, descriptionHash, DEFAULT_TRACKING_PARAMS } from '../src/core/normalize.js';
import { pgConnectionConfig } from '../src/core/config.js';

const NOW = new Date('2026-08-24T12:00:00Z');
const daysAgo = (/** @type {number} */ n) => new Date(NOW.getTime() - n * 86400000);
const OPTS = { trackingParams: DEFAULT_TRACKING_PARAMS, greenhouseBoards: [], aliases: {} };

let seq = 1000;
/**
 * Build a stored row with consistent normalized fields.
 * @param {Partial<import('../src/core/dedup.js').ListingRow> & { location_norm?: string }} o
 * @returns {import('../src/core/dedup.js').ListingRow}
 */
function row(o = {}) {
  const title = o.title ?? 'CTO';
  const company = o.company ?? 'Acme';
  const title_norm = o.title_norm ?? normalizeTitle(title).title_norm;
  const company_norm = o.company_norm ?? normalizeCompany(company, OPTS).company_norm;
  const location_norm = o.location_norm ?? 'houston-tx';
  return {
    id: o.id ?? seq++,
    source: o.source ?? 'linkedin',
    external_id: o.external_id ?? null,
    url_normalized: o.url_normalized ?? null,
    title,
    company,
    company_norm,
    title_norm,
    location_norm,
    dedup_hash: o.dedup_hash ?? dedupHash(company_norm, title_norm, location_norm),
    description_hash: o.description_hash ?? null,
    posted_at: o.posted_at ?? null,
    salary_min: o.salary_min ?? null,
    salary_max: o.salary_max ?? null,
    status: o.status ?? null,
    duplicate_of: o.duplicate_of ?? null,
    repost_of: o.repost_of ?? null,
    expired_at: o.expired_at ?? null,
    last_seen: o.last_seen ?? daysAgo(1),
    record_kind: o.record_kind ?? 'listing',
  };
}

/**
 * Build a candidate through the real normalizer.
 * @param {Partial<import('../src/core/normalize.js').RawListing>} o
 */
function rec(o = {}) {
  return normalizeListing({ source: 'linkedin', url: null, title: 'CTO', company: 'Acme', location: 'Houston, TX', ...o }, OPTS);
}

const OUTCOME_FOR_BRANCH = {
  '0-confidential-update': 'update',
  '1a-update': 'update',
  '1a-repost-same-id': 'repost',
  '1b-update': 'update',
  '1b-repost-same-url': 'repost',
  '2-cross-source-dup': 'cross_source_dup',
  '3-repost': 'repost',
  '6-state-remote-dup': 'cross_source_dup',
  '4-ambiguous': 'ambiguous',
  '5-new': 'new',
};

describe('inheritStatus: stated total function', () => {
  const table = [
    ['applied', 'review', 'reopened_applied'],
    ['dead', 'review', 'reopened_dead'],
    ['skip', 'review', 'reopened_skip'],
    ['review', 'new', null],
    ['shortlisted', 'shortlisted', null],
    ['maybe', 'maybe', null],
    ['new', 'new', null],
    [null, null, null],
    [undefined, null, null],
    ['active', null, null],
  ];
  for (const [input, status, reason] of table) {
    test(`${String(input)} -> ${String(status)} / ${String(reason)}`, () => {
      assert.deepEqual(inheritStatus(/** @type {any} */ (input)), { status, queueReason: reason });
    });
  }
});

describe('selectTarget ordering', () => {
  test('duplicate_of NULL first, then expired NULL first, then status precedence, then id asc', () => {
    const rows = [
      row({ id: 5, status: 'applied', duplicate_of: 1 }),
      row({ id: 4, status: 'applied', expired_at: daysAgo(2) }),
      row({ id: 3, status: 'maybe' }),
      row({ id: 2, status: 'shortlisted' }),
      row({ id: 9, status: 'shortlisted' }),
    ];
    assert.equal(/** @type {any} */ (selectTarget(rows)).id, 2);
    assert.equal(/** @type {any} */ (selectTarget([rows[0], rows[1]])).id, 4);
    assert.equal(/** @type {any} */ (selectTarget([rows[2], row({ id: 1, status: 'dead' })])).id, 3);
    assert.equal(selectTarget([]), null);
  });
  test('isLive and groupMaxLastSeen', () => {
    assert.equal(isLive(row({ last_seen: daysAgo(5) }), NOW, 30), true);
    assert.equal(isLive(row({ last_seen: daysAgo(31) }), NOW, 30), false);
    assert.equal(isLive(row({ expired_at: daysAgo(1) }), NOW, 30), false);
    assert.equal(isLive(row({ duplicate_of: 1 }), NOW, 30), false);
    assert.equal(isLive(row({ record_kind: 'note' }), NOW, 30), false);
    const m = groupMaxLastSeen([row({ last_seen: daysAgo(40) }), row({ last_seen: daysAgo(3) })]);
    assert.equal(/** @type {Date} */ (m).getTime(), daysAgo(3).getTime());
  });
});

describe('classify: one test per branch (in-memory lookups)', () => {
  const opts = { now: NOW, repostGapDays: 30 };

  test('0-confidential-update: identity is (company_norm, description_hash)', async () => {
    const desc = 'Lead technology for a PE-backed firm.';
    const rows = [row({ company: 'Confidential', company_norm: 'confidential:east57th', title: 'CTO', description_hash: descriptionHash(desc).hash, location_norm: 'absent' })];
    const d = await classify(rec({ source: 'exec', company: 'Confidential', confidentialFirm: 'east57th', title: 'Chief Technology Officer', description: desc, location: null }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '0-confidential-update');
    assert.equal(d.outcome, 'update');
    assert.equal(/** @type {any} */ (d.target).id, rows[0].id);
  });

  test('confidential without description and same title: new with queue reason confidential_no_description; never branch 2/3', async () => {
    const rows = [row({ company_norm: 'confidential:east57th', title: 'CTO', location_norm: 'houston-tx', source: 'indeed', posted_at: '2026-08-20' })];
    const d = await classify(rec({ source: 'exec', company: 'Confidential', confidentialFirm: 'east57th', title: 'CTO', location: 'Houston, TX', postedAt: '2026-08-21' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '5-new');
    assert.equal(d.queue, true);
    assert.equal(d.reason, 'confidential_no_description');
    const d2 = await classify(rec({ source: 'exec', company: 'Confidential', confidentialFirm: 'east57th', title: 'CIO', location: 'Houston, TX' }), makeMemoryLookups(rows), opts);
    assert.equal(d2.branch, '5-new');
    assert.equal(d2.queue, false);
  });

  test('1a-update: (source, external_id) match on a live row', async () => {
    const rows = [row({ source: 'linkedin', external_id: 'linkedin:4289469969', url_normalized: 'https://www.linkedin.com/jobs/view/4289469969', status: 'applied' })];
    const d = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/cto-at-acme-4289469969' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '1a-update');
    assert.equal(d.outcome, 'update');
    assert.equal(d.inherit, null);
  });

  test('1a lookup has no duplicate_of filter; duplicate rows order NULLS FIRST', async () => {
    const rows = [
      row({ id: 7, source: 'linkedin', external_id: 'linkedin:1', duplicate_of: 3 }),
      row({ id: 8, source: 'linkedin', external_id: 'linkedin:1' }),
    ];
    const d = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/1000001', title: 'x' }), makeMemoryLookups(rows.map((r) => ({ ...r, external_id: 'linkedin:1000001' }))), opts);
    assert.equal(d.branch, '1a-update');
    assert.equal(/** @type {any} */ (d.target).id, 8);
  });

  test('1a-repost-same-id: expired or stale row reopens with inheritance', async () => {
    const rows = [row({ source: 'linkedin', external_id: 'linkedin:4289469969', status: 'skip', last_seen: daysAgo(45) })];
    const d = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/4289469969' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '1a-repost-same-id');
    assert.equal(d.outcome, 'repost');
    assert.deepEqual(d.inherit, { status: 'review', queueReason: 'reopened_skip' });
    assert.equal(d.queue, true);
    const expired = [row({ source: 'linkedin', external_id: 'linkedin:4289469969', status: 'maybe', expired_at: daysAgo(2) })];
    const d2 = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/4289469969' }), makeMemoryLookups(expired), opts);
    assert.equal(d2.branch, '1a-repost-same-id');
    assert.deepEqual(d2.inherit, { status: 'maybe', queueReason: null });
    assert.equal(d2.queue, false);
  });

  test('4-ambiguous branch1_conflict: id matches row A, URL matches a different row B', async () => {
    const rows = [
      row({ id: 1, source: 'linkedin', external_id: 'linkedin:4289469969', url_normalized: 'https://www.linkedin.com/jobs/view/4289469969' }),
      row({ id: 2, source: 'manual', external_id: null, url_normalized: 'https://www.linkedin.com/jobs/view/4289469969', title: 'Other' }),
    ];
    const lookups = makeMemoryLookups(rows);
    const d = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/4289469969' }), lookups, opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'branch1_conflict');
    assert.deepEqual(d.matches, [1, 2]);
  });

  test('1b-update: URL match with external_id NULL on both sides and equal title', async () => {
    const url = 'https://example.com/careers/cto';
    const rows = [row({ source: 'manual', external_id: null, url_normalized: url, title: 'CTO' })];
    const d = await classify(rec({ source: 'manual', url: 'https://EXAMPLE.com/careers/cto/?utm_source=x', title: 'Chief Technology Officer' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '1b-update');
  });

  test('1b-repost-same-url: stale URL match reopens', async () => {
    const url = 'https://example.com/careers/cto';
    const rows = [row({ source: 'manual', external_id: null, url_normalized: url, title: 'CTO', last_seen: daysAgo(60), status: 'dead' })];
    const d = await classify(rec({ source: 'manual', url, title: 'CTO' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '1b-repost-same-url');
    assert.deepEqual(d.inherit, { status: 'review', queueReason: 'reopened_dead' });
  });

  test('4-ambiguous url_reuse: same URL, different title and no description match', async () => {
    const url = 'https://example.com/careers/opening';
    const rows = [row({ source: 'manual', external_id: null, url_normalized: url, title: 'CTO' })];
    const d = await classify(rec({ source: 'manual', url, title: 'Head of Sales' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'url_reuse');
  });

  test('R6: url match, SAME non-null canonical external_id, different sources, existing row live -> cross_source_dup (not ambiguous)', async () => {
    // A gmail-sourced LinkedIn alert stored first (source 'gmail', but its external_id and url_normalized are
    // the LinkedIn-canonical values because the parser rewrote the link before storage). A native LinkedIn
    // scrape of the same job arrives next: branch 1a's byExternalId(rec.source, rec.external_id) cannot find
    // it (the stored row's source is 'gmail', not 'linkedin'), so it falls to 1b's byUrl match.
    const url = 'https://www.linkedin.com/jobs/view/4012345678';
    const rows = [row({ id: 50, source: 'gmail', external_id: 'linkedin:4012345678', url_normalized: url, title: 'CTO', status: 'shortlisted', last_seen: daysAgo(1) })];
    const d = await classify(rec({ source: 'linkedin', url, title: 'CTO' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '2-cross-source-dup');
    assert.equal(d.outcome, 'cross_source_dup');
    assert.equal(/** @type {any} */ (d.target).id, 50);
    assert.equal(d.rootId, 50);
    assert.deepEqual(d.inherit, { status: 'shortlisted', queueReason: null });
  });

  test('R6: same scenario but the existing row is stale (past the repost gap) -> repost, not cross_source_dup', async () => {
    const url = 'https://www.linkedin.com/jobs/view/4012345678';
    const rows = [row({ id: 51, source: 'gmail', external_id: 'linkedin:4012345678', url_normalized: url, title: 'CTO', status: 'dead', last_seen: daysAgo(60) })];
    const d = await classify(rec({ source: 'linkedin', url, title: 'CTO' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '1b-repost-same-url');
    assert.equal(d.outcome, 'repost');
    assert.deepEqual(d.inherit, { status: 'review', queueReason: 'reopened_dead' });
  });

  test('R6: url match, DIFFERENT non-null external_ids -> stays 4-ambiguous url_reuse (unchanged)', async () => {
    const url = 'https://example.com/careers/opening2';
    const rows = [row({ source: 'manual', external_id: 'manual:abc123', url_normalized: url, title: 'CTO' })];
    const d = await classify(rec({ source: 'manual', url, title: 'CTO', externalId: 'xyz999' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'url_reuse');
  });

  test('2-cross-source-dup: live row from another source, eligible locations, corroborated by posted_at', async () => {
    const rows = [row({ id: 40, source: 'indeed', external_id: 'indeed:abc', posted_at: '2026-08-20', status: 'shortlisted' })];
    const d = await classify(rec({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4289469969', postedAt: '2026-08-22' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '2-cross-source-dup');
    assert.equal(d.outcome, 'cross_source_dup');
    assert.equal(d.rootId, 40);
    assert.deepEqual(d.inherit, { status: 'shortlisted', queueReason: null });
  });

  test('2 never chains: a row that is itself a duplicate is not live, so only the root can be matched', async () => {
    const rows = [
      row({ id: 7, source: 'greenhouse', external_id: 'greenhouse:acme/1', posted_at: '2026-08-20', status: 'maybe' }),
      row({ id: 40, source: 'indeed', external_id: 'indeed:abc', posted_at: '2026-08-20', status: 'shortlisted', duplicate_of: 7 }),
    ];
    const d = await classify(rec({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4289469969', postedAt: '2026-08-22' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '2-cross-source-dup');
    assert.equal(d.rootId, 7);
    assert.deepEqual(d.matches, [7]);
  });

  test('2 corroboration by description hash and by equal salary', async () => {
    const desc = '<p>Run engineering.</p>';
    const rows = [row({ source: 'indeed', description_hash: descriptionHash(desc).hash })];
    const d = await classify(rec({ source: 'greenhouse', description: desc }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '2-cross-source-dup');
    const rows2 = [row({ source: 'indeed', salary_min: 250000, salary_max: 300000 })];
    const d2 = await classify(rec({ source: 'greenhouse', salaryMin: 250000, salaryMax: 300000 }), makeMemoryLookups(rows2), opts);
    assert.equal(d2.branch, '2-cross-source-dup');
  });

  test('4-ambiguous cross_source_uncorroborated: hash match from another source with no corroboration', async () => {
    const rows = [row({ source: 'indeed', posted_at: '2026-07-01' })];
    const d = await classify(rec({ source: 'linkedin', postedAt: '2026-08-22' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'cross_source_uncorroborated');
  });

  test('2 requires the existing row to be live: stale cross-source match is not merged', async () => {
    const rows = [row({ source: 'indeed', posted_at: '2026-08-20', last_seen: daysAgo(45) })];
    const d = await classify(rec({ source: 'linkedin', postedAt: '2026-08-22' }), makeMemoryLookups(rows), opts);
    assert.notEqual(d.branch, '2-cross-source-dup');
    assert.equal(d.branch, '4-ambiguous');
  });

  test('3-repost: same-source hash match with MAX(last_seen) older than the gap', async () => {
    const rows = [
      row({ id: 21, source: 'linkedin', last_seen: daysAgo(80), status: 'applied' }),
      row({ id: 22, source: 'linkedin', last_seen: daysAgo(45), status: 'maybe', repost_of: 21 }),
    ];
    const d = await classify(rec({ source: 'linkedin' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '3-repost');
    assert.equal(d.outcome, 'repost');
    // target by precedence: applied (#21) beats maybe (#22); repost_of points at the root
    assert.equal(d.repostOf, 21);
    assert.deepEqual(d.inherit, { status: 'review', queueReason: 'reopened_applied' });
  });

  test('4-ambiguous same_source_hash_within_gap: group MAX(last_seen) inside the gap', async () => {
    const rows = [row({ source: 'linkedin', last_seen: daysAgo(80) }), row({ source: 'linkedin', last_seen: daysAgo(3) })];
    const d = await classify(rec({ source: 'linkedin' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'same_source_hash_within_gap');
  });

  test('4-ambiguous hash_location_unknown: absent, unknown, and legacy-unknown never auto-merge', async () => {
    // Both sides absent: hashes match, corroborated by posted_at, but the location class forbids a merge.
    const absentRows = [row({ source: 'indeed', location_norm: 'absent', posted_at: '2026-08-22' })];
    const dA = await classify(rec({ source: 'linkedin', location: null, postedAt: '2026-08-22' }), makeMemoryLookups(absentRows), opts);
    assert.equal(dA.branch, '4-ambiguous');
    assert.equal(dA.reason, 'hash_location_unknown');

    // Both sides the same unparseable string: unknown:<sha1> matches, still no merge.
    const unknownRec = rec({ source: 'linkedin', location: 'Greater Houston Area', postedAt: '2026-08-22' });
    assert.ok(unknownRec.location_norm.startsWith('unknown:'));
    const unknownRows = [row({ source: 'indeed', location_norm: unknownRec.location_norm, posted_at: '2026-08-22' })];
    const dU = await classify(unknownRec, makeMemoryLookups(unknownRows), opts);
    assert.equal(dU.reason, 'hash_location_unknown');

    // Adoption shape: candidate carries legacy-unknown (normalizeLegacyRow), stored row too.
    const legacyRec = { ...rec({ source: 'manual', location: null, postedAt: '2026-08-22' }), location_norm: 'legacy-unknown' };
    legacyRec.dedup_hash = dedupHash(legacyRec.company_norm, legacyRec.title_norm, 'legacy-unknown');
    const legacyRows = [row({ source: 'indeed', location_norm: 'legacy-unknown', posted_at: '2026-08-22' })];
    const dL = await classify(legacyRec, makeMemoryLookups(legacyRows), opts);
    assert.equal(dL.reason, 'hash_location_unknown');

    // Same-source hash match with an ineligible location is also never a repost.
    const sameSource = [row({ source: 'linkedin', location_norm: 'absent', last_seen: daysAgo(90) })];
    const dS = await classify(rec({ source: 'linkedin', location: null }), makeMemoryLookups(sameSource), opts);
    assert.equal(dS.branch, '4-ambiguous');
    assert.equal(dS.reason, 'hash_location_unknown');
  });

  test('4-ambiguous title_similar_same_company via similarity and via token set', async () => {
    const rows = [row({ title: 'Vice President of Engineering' })];
    const d = await classify(rec({ title: 'Vice President, Engineering' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'title_similar_same_company');
    const rows2 = [row({ title: 'Director of Engineering' })];
    const d2 = await classify(rec({ title: 'Engineering Director', location: 'Austin, TX' }), makeMemoryLookups(rows2), opts);
    assert.equal(d2.reason, 'title_similar_same_company');
  });

  test('4-ambiguous company_description_match', async () => {
    const desc = 'Own the roadmap for the payments platform and lead 40 engineers.';
    const rows = [row({ title: 'Head of Payments Platform', description_hash: descriptionHash(desc).hash })];
    const d = await classify(rec({ title: 'CFO', description: desc }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'company_description_match');
  });

  test('4-ambiguous company_similar_same_title', async () => {
    const rows = [row({ company: 'Hewlett Packard Enterprise' })];
    const d = await classify(rec({ company: 'Hewlett Packard Enterprises' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'company_similar_same_title');
  });

  test('4-ambiguous description_match_other_company', async () => {
    const desc = 'A very specific description shared by a staffing agency and the end client.';
    const rows = [row({ company: 'Robert Half', title: 'Director of IT', description_hash: descriptionHash(desc).hash })];
    const d = await classify(rec({ company: 'Zeta Widgets', title: 'IT Director', description: desc }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'description_match_other_company');
  });

  test('4-ambiguous redirect_url: redirect-kind URL with no external_id', async () => {
    const d = await classify(rec({ source: 'indeed', url: 'https://www.indeed.com/pagead/clk?ad=abc' }), makeMemoryLookups([]), opts);
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'redirect_url');
  });

  test('4-ambiguous legacy_exact: lower(title)+lower(company) match against a legacy row', async () => {
    const rows = [row({ title: 'Head of Applications', company: 'Worley', company_norm: 'worley', title_norm: 'head of applications', location_norm: 'legacy-unknown', source: 'manual' })];
    const d = await classify(rec({ title: 'head of APPLICATIONS', company: 'Worley', location: 'Houston, TX' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '4-ambiguous');
    // dedup_hash differs (legacy-unknown vs houston-tx), title/company similarity checks fire first
    assert.ok(['title_similar_same_company', 'legacy_exact'].includes(String(d.reason)));
    const rows2 = [row({ title: 'Head of Applications', company: 'Worley Ltd', company_norm: 'worley ltd zzz', title_norm: 'zzz', location_norm: 'legacy-unknown', source: 'manual' })];
    const d2 = await classify(rec({ title: 'Head of Applications', company: 'Worley Ltd', location: 'Houston, TX' }), makeMemoryLookups(rows2), opts);
    assert.equal(d2.reason, 'legacy_exact');
  });

  test('5-new: nothing matches', async () => {
    const d = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/4289469969' }), makeMemoryLookups([]), opts);
    assert.equal(d.branch, '5-new');
    assert.equal(d.outcome, 'new');
    assert.equal(d.queue, false);
  });

  test('record_kind lookups exclude notes', async () => {
    const rows = [row({ source: 'linkedin', external_id: 'linkedin:4289469969', record_kind: 'note' })];
    const d = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/4289469969' }), makeMemoryLookups(rows), opts);
    assert.equal(d.branch, '5-new');
  });

  test('excludeId ignores the row itself (adoption)', async () => {
    const self = row({ id: 500, source: 'linkedin', external_id: 'linkedin:4289469969' });
    const d = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/4289469969' }), makeMemoryLookups([self]), { ...opts, excludeId: 500 });
    assert.equal(d.branch, '5-new');
  });
});

describe('classify: branch 6, state/remote same-posting merge (spec R6, decisions 13-15/18)', () => {
  const opts = { now: NOW, repostGapDays: 30 };
  test('must match: same company/title, two different US states, posted within 14 days -> auto-merged, not queued', async () => {
    const tx = row({ id: 700, source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'state-tx', posted_at: '2026-08-10' });
    const d = await classify(rec({ source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Oklahoma', postedAt: '2026-08-15' }), makeMemoryLookups([tx]), opts);
    assert.equal(d.branch, '6-state-remote-dup');
    assert.equal(d.outcome, 'cross_source_dup');
    assert.equal(d.rootId, 700);
    assert.equal(d.queue, false, 'a state/remote merge is deterministic, never queued for review');
  });
  test('must match: same-SOURCE repeat also merges (no source-difference requirement, unlike branch 2)', async () => {
    const ar = row({ id: 701, source: 'exec:gartner', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'state-ar', posted_at: '2026-08-12' });
    const d = await classify(rec({ source: 'exec:gartner', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Texas', postedAt: '2026-08-13' }), makeMemoryLookups([ar]), opts);
    assert.equal(d.branch, '6-state-remote-dup');
    assert.equal(d.rootId, 701);
  });
  test('must match: both remote listings (different remote-<iso> regions, so the dedup_hash differs and branch 2 does not already own it) merge', async () => {
    const remoteCa = row({ id: 702, source: 'linkedin', company: 'Acme', title: 'CTO', location_norm: 'remote-ca', posted_at: '2026-08-10' });
    const d = await classify(rec({ source: 'greenhouse', company: 'Acme', title: 'CTO', location: null, remoteMode: 'remote', remoteDeclared: true, postedAt: '2026-08-12' }), makeMemoryLookups([remoteCa]), opts);
    assert.equal(d.branch, '6-state-remote-dup');
    assert.equal(d.rootId, 702);
  });
  test('an IDENTICAL remote-<iso> on both sides is owned by branch 2 (hash match), not branch 6', async () => {
    const remoteUs = row({ id: 7020, source: 'linkedin', company: 'Acme', title: 'CTO', location_norm: 'remote-us', posted_at: '2026-08-10' });
    const d = await classify(rec({ source: 'greenhouse', company: 'Acme', title: 'CTO', location: null, remoteMode: 'remote', remoteDeclared: true, postedAt: '2026-08-12' }), makeMemoryLookups([remoteUs]), opts);
    assert.equal(d.branch, '2-cross-source-dup');
  });
  test('must NOT match: a city-level location never satisfies R6 (R6.2)', async () => {
    const existing = row({ id: 703, source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'houston-tx', posted_at: '2026-08-10' });
    const d = await classify(rec({ source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Oklahoma', postedAt: '2026-08-12' }), makeMemoryLookups([existing]), opts);
    assert.notEqual(d.branch, '6-state-remote-dup');
  });
  test('must NOT match: a remote listing and a state-only listing do not merge (mixed, not "both")', async () => {
    const remote = row({ id: 704, source: 'linkedin', company: 'Acme', title: 'CTO', location_norm: 'remote-us', posted_at: '2026-08-10' });
    const d = await classify(rec({ source: 'exec', company: 'Acme', title: 'CTO', location: 'Texas', postedAt: '2026-08-11' }), makeMemoryLookups([remote]), opts);
    assert.notEqual(d.branch, '6-state-remote-dup');
  });
  test('must NOT match: an unknown:* location never qualifies even though isStateOnlyLocation-adjacent (decision 14)', async () => {
    const existing = row({ id: 705, source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: `unknown:${'a'.repeat(40)}`, posted_at: '2026-08-10' });
    const d = await classify(rec({ source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Oklahoma', postedAt: '2026-08-11' }), makeMemoryLookups([existing]), opts);
    assert.notEqual(d.branch, '6-state-remote-dup');
  });
  test('must NOT match: posted_at null on either side falls through to the ordinary near-miss path (decision 15)', async () => {
    const existing = row({ id: 706, source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'state-tx', posted_at: null });
    const d = await classify(rec({ source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Oklahoma', postedAt: '2026-08-11' }), makeMemoryLookups([existing]), opts);
    assert.notEqual(d.branch, '6-state-remote-dup');
  });
  test('must NOT match: more than 14 days apart', async () => {
    const existing = row({ id: 707, source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'state-tx', posted_at: '2026-07-01' });
    const d = await classify(rec({ source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Oklahoma', postedAt: '2026-08-20' }), makeMemoryLookups([existing]), opts);
    assert.notEqual(d.branch, '6-state-remote-dup');
  });
  test('must NOT match: identical location_norm is owned by branch 2/3 (hash match), not branch 6', async () => {
    const same = row({ id: 708, source: 'linkedin', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'state-tx', posted_at: '2026-08-10' });
    const d = await classify(rec({ source: 'greenhouse', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Texas', postedAt: '2026-08-11' }), makeMemoryLookups([same]), opts);
    assert.notEqual(d.branch, '6-state-remote-dup');
    assert.equal(d.branch, '2-cross-source-dup');
  });
  test('three rows arriving out of order never chain: root stays the true root, not an intermediate duplicate', async () => {
    // Row A (root, TX) arrives first; row B (OK) arrives second and merges into A (duplicate_of=709); row C
    // (AR) arrives third. isLive() (same precondition branch 2 uses) excludes B from candidacy because it
    // already has a non-null duplicate_of, so C matches only the live root A and rootId resolves to 709,
    // never to B -- the no-chains invariant holds by construction, the same way it does for branch 2/3.
    const a = row({ id: 709, source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'state-tx', posted_at: '2026-08-10' });
    const b = row({ id: 710, source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location_norm: 'state-ok', posted_at: '2026-08-11', duplicate_of: 709 });
    const dC = await classify(rec({ source: 'exec', company: 'Gartner', title: 'Executive Partner CIO Advisory', location: 'Arkansas', postedAt: '2026-08-12' }), makeMemoryLookups([a, b]), opts);
    assert.equal(dC.branch, '6-state-remote-dup');
    assert.equal(dC.rootId, 709, 'root must be the ORIGINAL root (A), never the intermediate duplicate (B)');
  });
});

describe('classify: 200-record property test', () => {
  test('every record maps to exactly one branch, never throws, outcome agrees with branch', async () => {
    let s = 12345;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const pick = (/** @type {any[]} */ a) => a[Math.floor(rnd() * a.length)];
    const titles = ['CTO', 'Chief Technology Officer', 'VP of Engineering', 'Vice President, Engineering', 'CIO', 'Head of Data'];
    const companies = ['Acme', 'Acme Inc.', 'Hewlett Packard Enterprise', 'Confidential', 'Zeta Widgets'];
    const sources = ['linkedin', 'indeed', 'greenhouse', 'manual'];
    const locs = ['Houston, TX', 'Austin, TX', null, 'Remote', 'United States', 'Greater Houston Area'];
    const descs = [null, 'Lead all engineering.', 'Own the platform roadmap and hire.', '<p>Run IT for a PE-backed firm.</p>'];
    const statuses = [null, 'new', 'maybe', 'shortlisted', 'applied', 'skip', 'dead', 'review'];
    const ids = () => String(4000000 + Math.floor(rnd() * 12));

    /** @type {import('../src/core/dedup.js').ListingRow[]} */
    const pool = [];
    for (let i = 0; i < 60; i++) {
      const source = pick(sources);
      const id = ids();
      const useId = rnd() < 0.6;
      const title = pick(titles);
      const company = pick(companies);
      const loc = pick(locs);
      const n = normalizeListing({ source, url: useId && source === 'linkedin' ? `https://www.linkedin.com/jobs/view/${id}` : null, externalId: useId && source !== 'linkedin' ? id : null, title, company, location: loc, description: pick(descs), postedAt: rnd() < 0.7 ? `2026-08-${String(1 + Math.floor(rnd() * 23)).padStart(2, '0')}` : null }, OPTS);
      pool.push(row({
        id: 100 + i, source, external_id: n.external_id, url_normalized: n.url_normalized, title, company, company_norm: n.company_norm, title_norm: n.title_norm,
        location_norm: rnd() < 0.15 ? 'legacy-unknown' : n.location_norm, dedup_hash: rnd() < 0.15 ? dedupHash(n.company_norm, n.title_norm, 'legacy-unknown') : n.dedup_hash,
        description_hash: n.description_hash, posted_at: n.posted_at, status: pick(statuses),
        last_seen: daysAgo(Math.floor(rnd() * 90)), expired_at: rnd() < 0.15 ? daysAgo(1) : null,
        duplicate_of: rnd() < 0.1 ? 100 + Math.floor(rnd() * i) : null, record_kind: rnd() < 0.05 ? 'note' : 'listing',
      }));
    }
    const lookups = makeMemoryLookups(pool);
    /** @type {Record<string, number>} */
    const seen = {};
    for (let i = 0; i < 200; i++) {
      const source = pick(sources);
      const id = ids();
      const urlKind = rnd();
      const url = source === 'linkedin' && urlKind < 0.7 ? `https://www.linkedin.com/jobs/view/${id}` : source === 'indeed' && urlKind < 0.1 ? 'https://www.indeed.com/pagead/clk?ad=x' : urlKind < 0.5 ? `https://example.com/jobs/${id}?utm_source=x` : null;
      const r = normalizeListing({ source, url, externalId: source !== 'linkedin' && rnd() < 0.5 ? id : null, title: pick(titles), company: pick(companies), location: pick(locs), description: pick(descs), postedAt: rnd() < 0.7 ? `2026-08-${String(1 + Math.floor(rnd() * 23)).padStart(2, '0')}` : null, remoteDeclared: rnd() < 0.2, salaryMin: rnd() < 0.3 ? 250000 : null, salaryMax: rnd() < 0.3 ? 300000 : null }, OPTS);
      const d = await classify(r, lookups, { now: NOW });
      assert.ok(BRANCHES.includes(d.branch), `unknown branch ${d.branch}`);
      assert.equal(typeof d.branch, 'string');
      assert.equal(d.outcome, OUTCOME_FOR_BRANCH[/** @type {keyof typeof OUTCOME_FOR_BRANCH} */ (d.branch)]);
      assert.ok(Object.values(OUTCOMES).includes(d.outcome));
      if (d.queue) assert.ok(d.reason, 'queued decisions carry a reason');
      if (d.outcome === 'ambiguous') assert.equal(d.queue, true);
      if (d.outcome === 'cross_source_dup') assert.ok(typeof d.rootId === 'number');
      if (d.branch === '3-repost') assert.ok(typeof d.repostOf === 'number');
      seen[d.branch] = (seen[d.branch] ?? 0) + 1;
    }
    // The generator must actually exercise the classifier, not just hit branch 5.
    assert.ok(Object.keys(seen).length >= 4, `branches exercised: ${JSON.stringify(seen)}`);
  });
});

describe('pg_trgm similarity and lookups in the real Postgres', () => {
  /** @type {import('pg').Client} */
  let client;
  const table = `ic_dedup_test_${process.pid}`;
  const cols = 'source, external_id, url_normalized, title, company, company_norm, title_norm, location_norm, dedup_hash, description_hash, posted_at, salary_min, salary_max, status, duplicate_of, repost_of, expired_at, last_seen, record_kind';

  /** @param {import('../src/core/dedup.js').ListingRow} r */
  async function insert(r) {
    const res = await client.query(
      `INSERT INTO ${table} (${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [r.source, r.external_id, r.url_normalized, r.title, r.company, r.company_norm, r.title_norm, r.location_norm, r.dedup_hash, r.description_hash, r.posted_at, r.salary_min, r.salary_max, r.status, r.duplicate_of, r.repost_of, r.expired_at, r.last_seen, r.record_kind],
    );
    return res.rows[0].id;
  }

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await client.query(`CREATE TABLE ${table} (
      id serial PRIMARY KEY, source text, external_id text, url_normalized text, title text, company text, company_norm text, title_norm text,
      location_norm text, dedup_hash text, description_hash text, posted_at date, salary_min int, salary_max int, status text,
      duplicate_of int, repost_of int, expired_at timestamptz, last_seen timestamptz, record_kind text DEFAULT 'listing')`);
    await client.query(`CREATE INDEX ON ${table} USING gin (title_norm gin_trgm_ops)`);
    await client.query(`CREATE INDEX ON ${table} USING gin (company_norm gin_trgm_ops)`);
  });

  after(async () => {
    try {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
    } finally {
      await client.end();
    }
  });

  test('JS trigramSimilarity matches pg_trgm similarity()', async () => {
    const pairs = [
      ['vice president of engineering', 'vice president engineering'],
      ['director of engineering', 'engineering director'],
      ['hewlett packard enterprise', 'hewlett packard enterprises'],
      ['chief technology officer', 'chief information officer'],
      ['acme', 'zeta widgets'],
      ['', 'x'],
    ];
    for (const [a, b] of pairs) {
      const r = await client.query('SELECT similarity($1, $2)::float8 AS s', [a, b]);
      assert.ok(Math.abs(r.rows[0].s - trigramSimilarity(a, b)) < 1e-6, `${a} ~ ${b}: pg=${r.rows[0].s} js=${trigramSimilarity(a, b)}`);
    }
  });

  test('threshold semantics: 0.55 title inclusive of 1.0, 0.70 company via % with set_limit', async () => {
    const lookups = makePgLookups(client, { table });
    const id1 = await insert(row({ title: 'Vice President of Engineering', company: 'Hewlett Packard Enterprise' }));
    const same = await lookups.byCompany('hewlett packard enterprise', 'vice president of engineering');
    assert.equal(same.length, 1);
    assert.equal(same[0].title_sim, 1);
    const near = await lookups.byCompany('hewlett packard enterprise', 'vice president engineering');
    assert.ok(/** @type {number} */ (near[0].title_sim) >= 0.55);
    const far = await lookups.byCompany('hewlett packard enterprise', 'chief information officer');
    assert.ok(/** @type {number} */ (far[0].title_sim) < 0.55);
    const fuzzy = await lookups.byTitleFuzzyCompany('vice president of engineering', 'hewlett packard enterprises', 0.7);
    assert.deepEqual(fuzzy.map((r) => r.id), [id1]);
    assert.ok(/** @type {number} */ (fuzzy[0].company_sim) >= 0.7);
    const none = await lookups.byTitleFuzzyCompany('vice president of engineering', 'zeta widgets', 0.7);
    assert.equal(none.length, 0);
  });

  test('classify end to end against Postgres: 1a, 2, 4 (trgm), 5, notes excluded', async () => {
    const lookups = makePgLookups(client, { table });
    const opts = { now: NOW };
    await client.query(`DELETE FROM ${table}`);
    const liId = await insert(row({ source: 'linkedin', external_id: 'linkedin:4289469969', url_normalized: 'https://www.linkedin.com/jobs/view/4289469969', title: 'CTO', company: 'Acme', posted_at: '2026-08-20', status: 'maybe' }));
    await insert(row({ source: 'linkedin', external_id: 'linkedin:9999999', title: 'Head of Sales', company: 'Acme', record_kind: 'note' }));

    const d1 = await classify(rec({ url: 'https://www.linkedin.com/jobs/view/cto-at-acme-4289469969' }), lookups, opts);
    assert.equal(d1.branch, '1a-update');
    assert.equal(/** @type {any} */ (d1.target).id, liId);

    const d2 = await classify(rec({ source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=d9b188507102064e', postedAt: '2026-08-22' }), lookups, opts);
    assert.equal(d2.branch, '2-cross-source-dup');
    assert.equal(d2.rootId, liId);
    assert.deepEqual(d2.inherit, { status: 'maybe', queueReason: null });

    const d4 = await classify(rec({ source: 'greenhouse', title: 'Chief Technology Officer, Platform', location: 'Austin, TX' }), lookups, opts);
    assert.equal(d4.branch, '4-ambiguous');
    assert.equal(d4.reason, 'title_similar_same_company');
    assert.deepEqual(d4.matches, [liId]);

    const d5 = await classify(rec({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/9999999', title: 'Head of Sales', company: 'Acme' }), lookups, opts);
    assert.equal(d5.branch, '5-new');

    const dNote = await classify(rec({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/9999999', title: 'Head of Legal', company: 'Zeta Widgets' }), lookups, opts);
    assert.equal(dNote.branch, '5-new');
  });
});
