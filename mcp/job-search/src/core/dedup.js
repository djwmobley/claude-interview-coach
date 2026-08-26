// @ts-check
/**
 * Dedup classification (spec section 3.2). `classify()` is a TOTAL
 * classification: every input maps to exactly one branch. Anything that is
 * not an exact, corroborated match and is not clearly new lands in branch 4
 * (ambiguous, review queue). There is no silent pass-through.
 *
 * The function is pure with respect to the database: all reads go through a
 * `Lookups` object (makePgLookups for Postgres, an in-memory implementation
 * in tests). Similarity for the fuzzy checks is computed by pg_trgm in
 * Postgres; `trigramSimilarity` here mirrors it for in-memory tests only.
 */
import { isLocationEligible, titleTokenKey, isStateOnlyLocation, isRemoteLocation } from './normalize.js';

export const BRANCHES = Object.freeze([
  '0-confidential-update',
  '1a-update',
  '1a-repost-same-id',
  '1b-update',
  '1b-repost-same-url',
  '2-cross-source-dup',
  '3-repost',
  '6-state-remote-dup',
  '4-ambiguous',
  '5-new',
]);

/** outcome values stored in ic_scan_run_items */
export const OUTCOMES = Object.freeze({ update: 'update', new: 'new', cross_source_dup: 'cross_source_dup', repost: 'repost', ambiguous: 'ambiguous' });

/** Target selection status precedence, best first (spec 3.2). */
export const STATUS_PRECEDENCE = Object.freeze(['applied', 'shortlisted', 'review', 'maybe', 'new', 'skip', 'dead']);

/**
 * @typedef {Object} ListingRow
 * @property {number} id
 * @property {string|null} source
 * @property {string|null} external_id
 * @property {string|null} url_normalized
 * @property {string} title
 * @property {string} company
 * @property {string|null} company_norm
 * @property {string|null} title_norm
 * @property {string|null} location_norm
 * @property {string|null} dedup_hash
 * @property {string|null} description_hash
 * @property {string|Date|null} posted_at
 * @property {number|null} salary_min
 * @property {number|null} salary_max
 * @property {string|null} status
 * @property {number|null} duplicate_of
 * @property {number|null} repost_of
 * @property {string|Date|null} expired_at
 * @property {string|Date|null} last_seen
 * @property {string|null} record_kind
 * @property {number} [title_sim] filled by byCompany
 * @property {number} [company_sim] filled by byTitleFuzzyCompany
 */

/**
 * @typedef {Object} Lookups
 * @property {(source: string, externalId: string) => Promise<ListingRow[]>} byExternalId ordered duplicate_of NULLS FIRST, id
 * @property {(urlNormalized: string) => Promise<ListingRow[]>} byUrl same order
 * @property {(dedupHash: string) => Promise<ListingRow[]>} byDedupHash
 * @property {(companyNorm: string, descriptionHash: string) => Promise<ListingRow[]>} byCompanyDesc
 * @property {(companyNorm: string, titleNorm: string) => Promise<ListingRow[]>} byCompany every listing with this company_norm, `title_sim` filled
 * @property {(titleNorm: string, companyNorm: string, threshold: number) => Promise<ListingRow[]>} byTitleFuzzyCompany title equal AND similarity(company) >= threshold, `company_sim` filled
 * @property {(descriptionHash: string) => Promise<ListingRow[]>} byDescriptionHash
 * @property {(title: string, company: string) => Promise<ListingRow[]>} legacyExact lower(title)+lower(company) match
 */

/**
 * @typedef {Object} ClassifyOptions
 * @property {Date} [now]
 * @property {number} [repostGapDays] default 30
 * @property {number} [titleSimilarity] default 0.55
 * @property {number} [companySimilarity] default 0.70
 * @property {number} [postedAtCorroborationDays] default 3
 * @property {number|null} [excludeId] ignore this row id in every lookup (adoption of an existing row)
 */

/**
 * @typedef {Object} Inheritance
 * @property {string|null} status status to write on the new/reopened row
 * @property {string|null} queueReason `reopened_<status>` when a queue entry is required
 */

/**
 * @typedef {Object} Decision
 * @property {string} branch one of BRANCHES
 * @property {'update'|'new'|'cross_source_dup'|'repost'|'ambiguous'} outcome
 * @property {ListingRow|null} target matched row (update/repost/dup target)
 * @property {number|null} rootId duplicate_of value for cross-source dups (never a chain)
 * @property {number|null} repostOf repost_of value for branch 3
 * @property {Inheritance|null} inherit
 * @property {string|null} reason queue reason for ambiguous / confidential_no_description
 * @property {number[]} matches ids of the rows that triggered the decision
 * @property {boolean} queue whether a review-queue entry is required
 */

const DEFAULTS = Object.freeze({ repostGapDays: 30, titleSimilarity: 0.55, companySimilarity: 0.7, postedAtCorroborationDays: 3 });

// ---------------------------------------------------------------------------
// Helpers exported for tests and upsert
// ---------------------------------------------------------------------------

/**
 * Status inheritance, a stated total function (spec 3.2).
 * @param {string|null|undefined} status
 * @returns {Inheritance}
 */
export function inheritStatus(status) {
  if (status === null || status === undefined) return { status: null, queueReason: null };
  switch (status) {
    case 'applied':
    case 'dead':
    case 'skip':
      return { status: 'review', queueReason: `reopened_${status}` };
    case 'review':
      return { status: 'new', queueReason: null };
    case 'shortlisted':
    case 'maybe':
    case 'new':
      return { status, queueReason: null };
    default:
      // Unknown legacy status text: treat like NULL (no inheritance) rather than guessing.
      return { status: null, queueReason: null };
  }
}

/** @param {string|Date|null|undefined} v */
export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {ListingRow[]} rows
 * @returns {ListingRow|null}
 */
export function selectTarget(rows) {
  if (!rows || rows.length === 0) return null;
  const rank = (/** @type {string|null} */ s) => {
    const i = STATUS_PRECEDENCE.indexOf(String(s));
    return i === -1 ? STATUS_PRECEDENCE.length : i;
  };
  const sorted = [...rows].sort((a, b) => {
    const ad = a.duplicate_of == null ? 0 : 1;
    const bd = b.duplicate_of == null ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const ae = a.expired_at == null ? 0 : 1;
    const be = b.expired_at == null ? 0 : 1;
    if (ae !== be) return ae - be;
    const ar = rank(a.status);
    const br = rank(b.status);
    if (ar !== br) return ar - br;
    return a.id - b.id;
  });
  return sorted[0];
}

/**
 * @param {ListingRow} row
 * @param {Date} now
 * @param {number} gapDays
 */
export function isLive(row, now, gapDays) {
  if (row.duplicate_of != null) return false;
  if (row.expired_at != null) return false;
  if ((row.record_kind ?? 'listing') !== 'listing') return false;
  const ls = toDate(row.last_seen);
  if (!ls) return false;
  return ls.getTime() >= now.getTime() - gapDays * 86400000;
}

/**
 * MAX(last_seen) over a group; null when none.
 * @param {ListingRow[]} rows
 */
export function groupMaxLastSeen(rows) {
  let max = null;
  for (const r of rows) {
    const d = toDate(r.last_seen);
    if (d && (max === null || d.getTime() > max.getTime())) max = d;
  }
  return max;
}

/**
 * pg_trgm-compatible similarity for in-memory tests. Postgres is authoritative
 * in production; test/dedup.test.js cross-checks this against the real
 * `similarity()` on sample pairs.
 * @param {string} a
 * @param {string} b
 */
export function trigramSimilarity(a, b) {
  const grams = (/** @type {string} */ s) => {
    const set = new Set();
    const words = String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      const p = `  ${w} `;
      for (let i = 0; i + 3 <= p.length; i++) set.add(p.slice(i, i + 3));
    }
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 && B.size === 0) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  const union = A.size + B.size - common;
  return union === 0 ? 0 : common / union;
}

/**
 * @param {ListingRow|import('./normalize.js').NormalizedListing} a
 * @param {ListingRow|import('./normalize.js').NormalizedListing} b
 * @param {number} days
 */
function corroborated(a, b, days) {
  if (a.description_hash && b.description_hash && a.description_hash === b.description_hash) return true;
  const pa = toDate(a.posted_at);
  const pb = toDate(b.posted_at);
  if (pa && pb && Math.abs(pa.getTime() - pb.getTime()) <= days * 86400000) return true;
  if (a.salary_min != null && a.salary_max != null && b.salary_min != null && b.salary_max != null && a.salary_min === b.salary_min && a.salary_max === b.salary_max) return true;
  return false;
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

/**
 * @param {import('./normalize.js').NormalizedListing} rec
 * @param {Lookups} lookups
 * @param {ClassifyOptions} [opts]
 * @returns {Promise<Decision>}
 */
export async function classify(rec, lookups, opts = {}) {
  const now = opts.now ?? new Date();
  const gap = opts.repostGapDays ?? DEFAULTS.repostGapDays;
  const titleT = opts.titleSimilarity ?? DEFAULTS.titleSimilarity;
  const companyT = opts.companySimilarity ?? DEFAULTS.companySimilarity;
  const corrDays = opts.postedAtCorroborationDays ?? DEFAULTS.postedAtCorroborationDays;
  const excludeId = opts.excludeId ?? null;
  /** @param {ListingRow[]} rows */
  const notes = (rows) => (rows ?? []).filter((r) => (r.record_kind ?? 'listing') === 'listing' && (excludeId === null || r.id !== excludeId));
  /** @param {ListingRow[]} rows */
  const ids = (rows) => rows.map((r) => r.id);

  /** @type {(branch: string, outcome: Decision['outcome'], extra?: Partial<Decision>) => Decision} */
  const decide = (branch, outcome, extra = {}) => ({
    branch,
    outcome,
    target: null,
    rootId: null,
    repostOf: null,
    inherit: null,
    reason: null,
    matches: [],
    queue: false,
    ...extra,
  });

  const isConfidential = typeof rec.company_norm === 'string' && rec.company_norm.startsWith('confidential:');
  const staleOrExpired = (/** @type {ListingRow} */ row) => {
    if (row.expired_at != null) return true;
    const ls = toDate(row.last_seen);
    return !ls || ls.getTime() < now.getTime() - gap * 86400000;
  };

  // Branch 0: confidential identity is (company_norm, description_hash).
  if (isConfidential && rec.description_hash) {
    const rows = notes(await lookups.byCompanyDesc(rec.company_norm, rec.description_hash));
    if (rows.length) {
      const target = /** @type {ListingRow} */ (selectTarget(rows));
      return decide('0-confidential-update', 'update', { target, matches: ids(rows) });
    }
  }

  // Branch 1a: (source, external_id) exact match.
  /** @type {ListingRow|null} */
  let a = null;
  /** @type {ListingRow[]} */
  let aRows = [];
  if (rec.external_id) {
    aRows = notes(await lookups.byExternalId(rec.source, rec.external_id));
    a = aRows.length ? aRows[0] : null;
  }
  /** @type {ListingRow[]} */
  let bRows = [];
  if (rec.url_normalized) bRows = notes(await lookups.byUrl(rec.url_normalized));

  if (a) {
    const other = bRows.find((r) => r.id !== a.id && !aRows.some((x) => x.id === r.id));
    if (other) {
      return decide('4-ambiguous', 'ambiguous', { reason: 'branch1_conflict', matches: [a.id, other.id], queue: true });
    }
    if (staleOrExpired(a)) {
      return decide('1a-repost-same-id', 'repost', { target: a, inherit: inheritStatus(a.status), matches: [a.id], queue: Boolean(inheritStatus(a.status).queueReason), reason: inheritStatus(a.status).queueReason });
    }
    return decide('1a-update', 'update', { target: a, matches: [a.id] });
  }

  // Branch 1b: url_normalized exact match. Either external_id is NULL on both sides, or (R6) both sides
  // carry the SAME non-null canonical external_id (e.g. a gmail-sourced LinkedIn alert and a natively
  // scraped LinkedIn row can both resolve to external_id linkedin:<id> via normalizeUrl while their
  // `source` columns differ, so branch 1a's byExternalId(rec.source, rec.external_id) lookup never finds
  // the other row). A url match with two DIFFERENT non-null external_ids stays ambiguous (url_reuse).
  if (bRows.length) {
    const b = bRows[0];
    const bothNull = !rec.external_id && !b.external_id;
    const sameExternalId = Boolean(rec.external_id) && Boolean(b.external_id) && rec.external_id === b.external_id;
    const contentMatch = (rec.description_hash && b.description_hash && rec.description_hash === b.description_hash) || (rec.title_norm && b.title_norm && rec.title_norm === b.title_norm);
    if ((bothNull && contentMatch) || sameExternalId) {
      // Same canonical id, different sources, and the existing row is still live: this is a cross-source
      // duplicate (like branch 2), not an update of the gmail-sourced (or other-sourced) copy in place.
      if (sameExternalId && b.source !== rec.source && isLive(b, now, gap)) {
        const rootId = b.duplicate_of ?? b.id;
        const inh = inheritStatus(b.status);
        return decide('2-cross-source-dup', 'cross_source_dup', { target: b, rootId, inherit: inh, matches: [b.id], queue: Boolean(inh.queueReason), reason: inh.queueReason });
      }
      if (staleOrExpired(b)) {
        const inh = inheritStatus(b.status);
        return decide('1b-repost-same-url', 'repost', { target: b, inherit: inh, matches: [b.id], queue: Boolean(inh.queueReason), reason: inh.queueReason });
      }
      return decide('1b-update', 'update', { target: b, matches: [b.id] });
    }
    return decide('4-ambiguous', 'ambiguous', { reason: 'url_reuse', matches: ids(bRows), queue: true });
  }

  // Confidential rows are never eligible for branches 2-3.
  if (isConfidential) {
    if (!rec.description_hash) {
      const same = notes(await lookups.byCompany(rec.company_norm, rec.title_norm)).filter((r) => r.title_norm === rec.title_norm);
      if (same.length) return decide('5-new', 'new', { reason: 'confidential_no_description', matches: ids(same), queue: true });
    }
    return decide('5-new', 'new');
  }

  // Branches 2-4 share the dedup_hash lookup.
  const hashRows = notes(await lookups.byDedupHash(rec.dedup_hash));
  const recEligible = isLocationEligible(rec.location_norm);

  if (hashRows.length) {
    const eligibleRows = hashRows.filter((r) => isLocationEligible(r.location_norm));
    const ineligibleRows = hashRows.filter((r) => !isLocationEligible(r.location_norm));

    if (recEligible) {
      // Branch 2: live row from a different source with corroboration.
      const cross = eligibleRows.filter((r) => r.source !== rec.source && isLive(r, now, gap) && corroborated(rec, r, corrDays));
      if (cross.length) {
        const target = /** @type {ListingRow} */ (selectTarget(cross));
        const rootId = target.duplicate_of ?? target.id;
        const inh = inheritStatus(target.status);
        return decide('2-cross-source-dup', 'cross_source_dup', { target, rootId, inherit: inh, matches: ids(cross), queue: Boolean(inh.queueReason), reason: inh.queueReason });
      }
      // Branch 3: same-source repost after the gap.
      const sameSource = eligibleRows.filter((r) => r.source === rec.source);
      if (sameSource.length) {
        const maxSeen = groupMaxLastSeen(sameSource);
        const allExpired = sameSource.every((r) => r.expired_at != null);
        const pastGap = !maxSeen || maxSeen.getTime() < now.getTime() - gap * 86400000;
        if (pastGap || allExpired) {
          const target = /** @type {ListingRow} */ (selectTarget(sameSource));
          const inh = inheritStatus(target.status);
          return decide('3-repost', 'repost', { target, repostOf: target.repost_of ?? target.id, inherit: inh, matches: ids(sameSource), queue: Boolean(inh.queueReason), reason: inh.queueReason });
        }
        return decide('4-ambiguous', 'ambiguous', { reason: 'same_source_hash_within_gap', matches: ids(sameSource), queue: true });
      }
      if (ineligibleRows.length) {
        return decide('4-ambiguous', 'ambiguous', { reason: 'hash_location_unknown', matches: ids(ineligibleRows), queue: true });
      }
      // Different-source hash match without corroboration (or not live).
      return decide('4-ambiguous', 'ambiguous', { reason: 'cross_source_uncorroborated', matches: ids(eligibleRows), queue: true });
    }
    // Candidate location is absent/unknown/legacy: any hash match is a near-miss.
    return decide('4-ambiguous', 'ambiguous', { reason: 'hash_location_unknown', matches: ids(hashRows), queue: true });
  }

  // Branch 6 (spec R6, decisions 13-15/18): same posting broadcast once per US state, or the identical
  // role posted as remote from two sources -- merged automatically, ahead of the title_similar_same_company
  // near-miss below, NOT queued for review. Requires: identical company_norm AND identical title_norm
  // (already true here, both rows share rec.company_norm/title_norm by construction of the lookup below);
  // both locations dedup-eligible (isLocationEligible -- decision 14: an 'unknown:*'/'absent'/
  // 'legacy-unknown' location on either side never qualifies); both sides EITHER remote (location_norm
  // 'remote-*') OR both a state-only location (location_norm 'state-*', no city -- R6.2: a city-level
  // location never satisfies this) -- a remote/state MIX does not qualify, and neither does an identical
  // location_norm on both sides (that case is already handled by the dedup_hash branches 2/3 above, since
  // dedup_hash includes location_norm); posted_at present on BOTH sides and within 14 days of each other
  // (decision 15: a null posted_at on either side falls through to the ordinary near-miss path instead).
  // Deliberately has NO same/different-source requirement (unlike branch 2/3): the spec's own motivating
  // case -- one exec board listing "Executive Partner CIO Advisory" once per state -- is a SAME-source
  // repeat, and R6.1's text does not condition on source either.
  if (recEligible && rec.company_norm && rec.title_norm && toDate(rec.posted_at)) {
    const recRemote = isRemoteLocation(rec.location_norm);
    const recState = isStateOnlyLocation(rec.location_norm);
    if (recRemote || recState) {
      const sameCompanySameTitle = notes(await lookups.byCompany(rec.company_norm, rec.title_norm)).filter((r) => r.title_norm === rec.title_norm);
      const stateRemoteCandidates = sameCompanySameTitle.filter((r) => {
        if (!isLocationEligible(r.location_norm)) return false;
        if (r.location_norm === rec.location_norm) return false; // identical location: owned by branch 2/3 above
        const bothRemote = recRemote && isRemoteLocation(r.location_norm);
        const bothState = recState && isStateOnlyLocation(r.location_norm);
        if (!bothRemote && !bothState) return false;
        const rDate = toDate(r.posted_at);
        if (!rDate) return false;
        if (Math.abs(rDate.getTime() - toDate(rec.posted_at).getTime()) > 14 * 86400000) return false;
        return isLive(r, now, gap);
      });
      if (stateRemoteCandidates.length) {
        const target = /** @type {ListingRow} */ (selectTarget(stateRemoteCandidates));
        const rootId = target.duplicate_of ?? target.id;
        const inh = inheritStatus(target.status);
        return decide('6-state-remote-dup', 'cross_source_dup', { target, rootId, inherit: inh, matches: ids(stateRemoteCandidates), queue: Boolean(inh.queueReason), reason: inh.queueReason });
      }
    }
  }

  // Branch 4: near-miss triggers.
  if (rec.url_kind === 'redirect' && !rec.external_id) {
    return decide('4-ambiguous', 'ambiguous', { reason: 'redirect_url', matches: [], queue: true });
  }
  if (rec.company_norm) {
    const sameCompany = notes(await lookups.byCompany(rec.company_norm, rec.title_norm));
    if (sameCompany.length) {
      const key = titleTokenKey(rec.title_norm);
      const near = sameCompany.filter((r) => (typeof r.title_sim === 'number' && r.title_sim >= titleT) || (r.title_norm && titleTokenKey(r.title_norm) === key));
      if (near.length) return decide('4-ambiguous', 'ambiguous', { reason: 'title_similar_same_company', matches: ids(near), queue: true });
      if (rec.description_hash) {
        const desc = sameCompany.filter((r) => r.description_hash === rec.description_hash);
        if (desc.length) return decide('4-ambiguous', 'ambiguous', { reason: 'company_description_match', matches: ids(desc), queue: true });
      }
    }
  }
  if (rec.title_norm && rec.company_norm) {
    const fuzzy = notes(await lookups.byTitleFuzzyCompany(rec.title_norm, rec.company_norm, companyT)).filter((r) => typeof r.company_sim !== 'number' || r.company_sim >= companyT);
    if (fuzzy.length) return decide('4-ambiguous', 'ambiguous', { reason: 'company_similar_same_title', matches: ids(fuzzy), queue: true });
  }
  if (rec.description_hash) {
    const other = notes(await lookups.byDescriptionHash(rec.description_hash)).filter((r) => r.company_norm !== rec.company_norm);
    if (other.length) return decide('4-ambiguous', 'ambiguous', { reason: 'description_match_other_company', matches: ids(other), queue: true });
  }
  if (rec.title && rec.company) {
    const legacy = notes(await lookups.legacyExact(rec.title, rec.company));
    if (legacy.length) return decide('4-ambiguous', 'ambiguous', { reason: 'legacy_exact', matches: ids(legacy), queue: true });
  }

  // Branch 5.
  return decide('5-new', 'new');
}

// ---------------------------------------------------------------------------
// Postgres lookups
// ---------------------------------------------------------------------------

export const LISTING_COLUMNS = [
  'id', 'source', 'external_id', 'url_normalized', 'title', 'company', 'company_norm', 'title_norm', 'location_norm',
  'dedup_hash', 'description_hash', 'posted_at', 'salary_min', 'salary_max', 'status', 'duplicate_of', 'repost_of',
  'expired_at', 'last_seen', 'record_kind',
];

/**
 * @param {import('pg').ClientBase} client
 * @param {{ table?: string }} [opts]
 * @returns {Lookups}
 */
export function makePgLookups(client, opts = {}) {
  const table = opts.table ?? 'ic_job_listings';
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('invalid table name');
  const cols = LISTING_COLUMNS.join(', ');
  const listing = `coalesce(record_kind,'listing') = 'listing'`;
  const LIMIT = 200;
  return {
    async byExternalId(source, externalId) {
      const r = await client.query(
        `SELECT ${cols} FROM ${table} WHERE source = $1 AND external_id = $2 AND ${listing} ORDER BY duplicate_of NULLS FIRST, id LIMIT ${LIMIT}`,
        [source, externalId],
      );
      return r.rows;
    },
    async byUrl(urlNormalized) {
      const r = await client.query(
        `SELECT ${cols} FROM ${table} WHERE url_normalized = $1 AND ${listing} ORDER BY duplicate_of NULLS FIRST, id LIMIT ${LIMIT}`,
        [urlNormalized],
      );
      return r.rows;
    },
    async byDedupHash(dedupHash) {
      const r = await client.query(`SELECT ${cols} FROM ${table} WHERE dedup_hash = $1 AND ${listing} ORDER BY id LIMIT ${LIMIT}`, [dedupHash]);
      return r.rows;
    },
    async byCompanyDesc(companyNorm, descriptionHash) {
      const r = await client.query(
        `SELECT ${cols} FROM ${table} WHERE company_norm = $1 AND description_hash = $2 AND ${listing} ORDER BY id LIMIT ${LIMIT}`,
        [companyNorm, descriptionHash],
      );
      return r.rows;
    },
    async byCompany(companyNorm, titleNorm) {
      const r = await client.query(
        `SELECT ${cols}, similarity(coalesce(title_norm,''), $2)::float8 AS title_sim FROM ${table} WHERE company_norm = $1 AND ${listing} ORDER BY id LIMIT ${LIMIT}`,
        [companyNorm, titleNorm ?? ''],
      );
      return r.rows;
    },
    async byTitleFuzzyCompany(titleNorm, companyNorm, threshold) {
      await client.query('SELECT set_limit($1::float4)', [threshold]);
      const r = await client.query(
        `SELECT ${cols}, similarity(coalesce(company_norm,''), $2)::float8 AS company_sim FROM ${table}
         WHERE title_norm = $1 AND company_norm % $2 AND ${listing} ORDER BY id LIMIT ${LIMIT}`,
        [titleNorm, companyNorm],
      );
      return r.rows;
    },
    async byDescriptionHash(descriptionHash) {
      const r = await client.query(`SELECT ${cols} FROM ${table} WHERE description_hash = $1 AND ${listing} ORDER BY id LIMIT ${LIMIT}`, [descriptionHash]);
      return r.rows;
    },
    async legacyExact(title, company) {
      const r = await client.query(
        `SELECT ${cols} FROM ${table} WHERE lower(trim(title)) = lower(trim($1)) AND lower(trim(company)) = lower(trim($2)) AND ${listing} ORDER BY id LIMIT ${LIMIT}`,
        [title, company],
      );
      return r.rows;
    },
  };
}

/**
 * In-memory Lookups over an array of rows (tests, dry runs). Uses
 * trigramSimilarity as a stand-in for pg_trgm.
 * @param {ListingRow[]} rows
 * @returns {Lookups}
 */
export function makeMemoryLookups(rows) {
  const listing = (/** @type {ListingRow} */ r) => (r.record_kind ?? 'listing') === 'listing';
  const order = (/** @type {ListingRow[]} */ rs) => rs.sort((x, y) => {
    const xd = x.duplicate_of == null ? 0 : 1;
    const yd = y.duplicate_of == null ? 0 : 1;
    return xd !== yd ? xd - yd : x.id - y.id;
  });
  return {
    async byExternalId(source, externalId) {
      return order(rows.filter((r) => listing(r) && r.source === source && r.external_id === externalId));
    },
    async byUrl(u) {
      return order(rows.filter((r) => listing(r) && r.url_normalized === u));
    },
    async byDedupHash(h) {
      return rows.filter((r) => listing(r) && r.dedup_hash === h).sort((x, y) => x.id - y.id);
    },
    async byCompanyDesc(c, d) {
      return rows.filter((r) => listing(r) && r.company_norm === c && r.description_hash === d);
    },
    async byCompany(c, t) {
      return rows.filter((r) => listing(r) && r.company_norm === c).map((r) => ({ ...r, title_sim: trigramSimilarity(r.title_norm ?? '', t ?? '') }));
    },
    async byTitleFuzzyCompany(t, c, threshold) {
      return rows
        .filter((r) => listing(r) && r.title_norm === t)
        .map((r) => ({ ...r, company_sim: trigramSimilarity(r.company_norm ?? '', c) }))
        .filter((r) => r.company_sim >= threshold);
    },
    async byDescriptionHash(d) {
      return rows.filter((r) => listing(r) && r.description_hash === d);
    },
    async legacyExact(title, company) {
      const t = String(title).trim().toLowerCase();
      const c = String(company).trim().toLowerCase();
      return rows.filter((r) => listing(r) && String(r.title ?? '').trim().toLowerCase() === t && String(r.company ?? '').trim().toLowerCase() === c);
    },
  };
}
