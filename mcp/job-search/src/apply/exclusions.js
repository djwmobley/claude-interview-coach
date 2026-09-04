// @ts-check
/**
 * Apply exclusion gate (spec: "apply exclusion gate", hardened by a spec-adversary pass). Runs before the
 * scheduled auto-apply run and before the dashboard's one-click Apply ever submit to a job: never submit to
 * a listing Damian already applied to, never submit to a blocked employer (Immunotec, former employer;
 * Advisicon, current employer).
 *
 * classifyExclusion() is a TOTAL classification, first match wins, in this order:
 *   a. blocked_company (HARD)             -- tokens of a blocked entry are a subset of the listing's company tokens
 *   b. already_applied_listing (HARD)     -- a non-withdrawn application exists on this listing's dedup tree
 *   b2. previously_withdrawn (NEEDS_HUMAN) -- only a withdrawn application exists on this listing's dedup tree
 *   c. already_applied_history (HARD)     -- company AND title match a prior application (config or DB)
 *   d. applied_company_other_role (NEEDS_HUMAN) -- company matches c but title does not
 *   e. blocked_company_suspect (NEEDS_HUMAN)    -- a blocked token appears in the apply/source URL host or
 *      description, but not in the company itself (staffing-agency indirection)
 *   f. unknown_company (NEEDS_HUMAN)      -- company missing/blank/stoplisted/too short to trust
 *   g. eligible
 *
 * Every listing maps to exactly one branch; there is no silent pass-through. HARD branches (a, b, c) are
 * never auto-applied and never overridable from the dashboard. NEEDS_HUMAN branches (b2, d, e, f) are not
 * auto-applied but the dashboard's one-click Apply may proceed on an EXPLICIT override flag from the caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JobSearchError } from '../core/errors.js';
import { normalizeCompany, normalizeTitle } from '../core/normalize.js';

/** Built-in blocked companies (spec: "Built-ins can never be removed by config"). */
export const BUILT_IN_BLOCKED = Object.freeze(['Immunotec', 'Advisicon']);

/** The closed, total branch enum, in evaluation/precedence order (spec amendment: previously_withdrawn
 * sits between already_applied_listing and already_applied_history). */
export const EXCLUSION_BRANCHES = Object.freeze([
  'blocked_company', 'already_applied_listing', 'previously_withdrawn', 'already_applied_history',
  'applied_company_other_role', 'blocked_company_suspect', 'unknown_company', 'eligible',
]);

/** Branches that must never be auto-applied and are never overridable from the dashboard. */
export const HARD_BRANCHES = Object.freeze(['blocked_company', 'already_applied_listing', 'already_applied_history']);

/** Branches that are not auto-applied but accept an explicit one-click-Apply override. */
export const NEEDS_HUMAN_BRANCHES = Object.freeze(['previously_withdrawn', 'applied_company_other_role', 'blocked_company_suspect', 'unknown_company']);

/** Company strings that never identify a real employer (spec branch f). */
const UNKNOWN_COMPANY_STOPLIST = new Set(['n/a', 'na', 'tbd', 'none', 'unknown', 'confidential', 'undisclosed']);

/** Title similarity threshold for branch c (spec: pg_trgm similarity(title_norm, other) >= 0.5). */
export const TITLE_SIMILARITY_THRESHOLD = 0.5;

/** Max hops walked either up (to find a dedup root) or down (to enumerate a dedup tree) before giving up --
 * a cycle guard, never a throw (spec: "with a cycle guard, max 20 hops, not single-hop"). */
export const MAX_DEDUP_HOPS = 20;

// ---------------------------------------------------------------------------
// Tokenization / company matching
// ---------------------------------------------------------------------------

/**
 * Tokenize a raw company string the same way for every comparison in this module: run it through
 * normalizeCompany() (suffix stripping, alias map, accent/case folding -- the SAME normalization the scan
 * pipeline stores as company_norm) and split the result on whitespace. Never a substring match: "Immunotec
 * Research" tokenizes to ['immunotec','research'] and "Immunotechnology Partners" tokenizes to
 * ['immunotechnology','partners'] -- the two never share a token even though one contains the other as a
 * character run.
 * @param {string|null|undefined} raw
 * @returns {string[]}
 */
export function companyTokens(raw) {
  const norm = normalizeCompany(raw ?? '').company_norm;
  return norm ? norm.split(' ').filter(Boolean) : [];
}

/**
 * True when every token in `subset` appears in `superset` (exact token membership, order-independent).
 * An empty `subset` never matches anything (an empty/unresolvable company name is not "a subset of
 * everything" -- that would make branch (a) fire on every listing with a blank company).
 * @param {string[]} subset
 * @param {string[]} superset
 * @returns {boolean}
 */
export function isTokenSubset(subset, superset) {
  if (subset.length === 0) return false;
  const set = new Set(superset);
  return subset.every((t) => set.has(t));
}

/**
 * Bidirectional subset-or-equal check for branch (c)/(d)'s "company matches ... both directions": true
 * when either token list is a subset of the other. Two empty lists never match (see isTokenSubset).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
export function tokensMatchBidirectional(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  return isTokenSubset(a, b) || isTokenSubset(b, a);
}

/**
 * Whole-word/whole-phrase containment: true when `entryTokens` appears as a CONTIGUOUS run inside the
 * words of `text` (case-insensitive, split on non-alphanumeric runs) -- e.g. entryTokens ['immunotec']
 * matches the host "immunotecstaffing.com" tokenized to ['immunotecstaffing','com']? No: 'immunotec' is
 * not itself one of those whole words, so it correctly does NOT match (spec: "whole word", never a
 * substring). It DOES match "apply.immunotec-staffing.com" -> ['apply','immunotec','staffing','com'].
 * @param {string|null|undefined} text
 * @param {string[]} entryTokens
 * @returns {boolean}
 */
export function containsWholePhrase(text, entryTokens) {
  if (!text || entryTokens.length === 0) return false;
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i + entryTokens.length <= words.length; i++) {
    let match = true;
    for (let j = 0; j < entryTokens.length; j++) {
      if (words[i + j] !== entryTokens[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Total classification (spec branch f): true when `rawCompany`/`companyNorm` can never identify a real
 * employer -- null/blank, stoplisted (n/a, na, tbd, none, unknown, confidential, undisclosed, checked
 * against the raw lowercased/trimmed text since normalizeCompany() rewrites "confidential" into a
 * `confidential:<slug>` form before this ever sees it), or fewer than 2 alphabetic characters in the
 * normalized form (spec's literal wording; this is a deliberately blunt rule -- see the module's BLIND
 * SPOTS note in the PR body for the false-positive risk on short real names like "3M").
 * @param {string|null|undefined} rawCompany
 * @param {string} companyNorm
 * @returns {boolean}
 */
export function isUnknownCompany(rawCompany, companyNorm) {
  const raw = String(rawCompany ?? '').trim().toLowerCase();
  if (!raw) return true;
  if (!companyNorm || !companyNorm.trim()) return true;
  if (UNKNOWN_COMPANY_STOPLIST.has(raw)) return true;
  if (companyNorm.startsWith('confidential:')) return true;
  const alphaCount = (companyNorm.match(/[a-z]/g) ?? []).length;
  return alphaCount < 2;
}

// ---------------------------------------------------------------------------
// Config load (spec section 2): missing/invalid = hard error, never a silent fallback
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AppliedHistoryEntry
 * @property {string} company
 * @property {string|null} title null/absent is legal -- matches on company only (branch d, never branch c)
 * @property {string|null} applied_on
 * @property {string|null} source
 */

/**
 * @typedef {Object} ExclusionConfig
 * @property {string[]} blockedCompanies BUILT_IN_BLOCKED plus config's own blocked_companies, in that order
 * @property {AppliedHistoryEntry[]} appliedHistory
 */

/** @param {string} configDir */
export function exclusionConfigPath(configDir) {
  return path.join(configDir, 'apply-exclusions.json');
}

/**
 * Load and validate config/apply-exclusions.json fresh from disk every call (spec: "the dashboard process
 * must read the file fresh on every classifyExclusion call... no process-lifetime cache" -- auto-apply's
 * own caller loads once per run simply by calling this once itself and reusing the return value; this
 * function does not cache regardless of caller). Missing file, unreadable file, invalid JSON, or a JSON
 * value that is not an object are ALL a hard CONFIG_INVALID error -- never a fallback to the tracked
 * .example.json (spec: "The example file is never a fallback") and never an empty-but-valid config
 * synthesized in its place. Empty `blocked_companies`/`applied_history` arrays ARE valid (built-ins still
 * apply either way).
 * @param {string} configDir
 * @returns {ExclusionConfig}
 */
export function loadExclusionConfig(configDir) {
  const file = exclusionConfigPath(configDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new JobSearchError('CONFIG_INVALID', `apply-exclusions.json missing or unreadable: ${file}`, {
      hint: 'copy config/apply-exclusions.example.json to config/apply-exclusions.json and fill in real values',
      details: { file, err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
    });
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JobSearchError('CONFIG_INVALID', `apply-exclusions.json is not valid JSON: ${file}`, {
      details: { file, err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JobSearchError('CONFIG_INVALID', `apply-exclusions.json must be a JSON object: ${file}`);
  }
  const blockedRaw = parsed.blocked_companies;
  if (blockedRaw !== undefined && !Array.isArray(blockedRaw)) {
    throw new JobSearchError('CONFIG_INVALID', `apply-exclusions.json blocked_companies must be an array: ${file}`);
  }
  const historyRaw = parsed.applied_history;
  if (historyRaw !== undefined && !Array.isArray(historyRaw)) {
    throw new JobSearchError('CONFIG_INVALID', `apply-exclusions.json applied_history must be an array: ${file}`);
  }
  /** @type {AppliedHistoryEntry[]} */
  const appliedHistory = (historyRaw ?? []).map((entry, i) => {
    if (!entry || typeof entry !== 'object' || typeof entry.company !== 'string' || !entry.company.trim()) {
      throw new JobSearchError('CONFIG_INVALID', `apply-exclusions.json applied_history[${i}] must be an object with a non-empty "company" string: ${file}`);
    }
    return {
      company: entry.company,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : null,
      applied_on: typeof entry.applied_on === 'string' ? entry.applied_on : null,
      source: typeof entry.source === 'string' ? entry.source : null,
    };
  });
  const blockedCompanies = [...BUILT_IN_BLOCKED, ...(blockedRaw ?? []).map((c) => String(c))];
  return { blockedCompanies, appliedHistory };
}

// ---------------------------------------------------------------------------
// Dedup tree walking (spec: "Root = walk duplicate_of up to the top with a cycle guard (max 20 hops), not
// single-hop")
// ---------------------------------------------------------------------------

/**
 * Walk duplicate_of upward from `listingId` to find its dedup root, one hop at a time, with a cycle guard:
 * stops (returning the last valid id) as soon as it would revisit an id already seen, or after
 * MAX_DEDUP_HOPS hops, or when duplicate_of is null/the row does not exist. Never throws.
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {number} [maxHops]
 * @returns {Promise<number>}
 */
export async function walkDuplicateRoot(client, listingId, maxHops = MAX_DEDUP_HOPS) {
  const visited = new Set([listingId]);
  let current = listingId;
  for (let hop = 0; hop < maxHops; hop++) {
    const r = await client.query('SELECT duplicate_of FROM ic_job_listings WHERE id = $1', [current]);
    if (r.rowCount === 0) return current;
    const next = r.rows[0].duplicate_of === null || r.rows[0].duplicate_of === undefined ? null : Number(r.rows[0].duplicate_of);
    if (next === null || visited.has(next)) return current;
    visited.add(next);
    current = next;
  }
  return current;
}

/**
 * Breadth-first enumerate every listing id whose duplicate_of chain resolves (directly or transitively) to
 * `rootId`, plus rootId itself -- "any listing sharing that root" (spec branches b/b2). Cycle-safe (a
 * visited-set guard) and depth-bounded (MAX_DEDUP_HOPS levels), so a corrupt duplicate_of graph can never
 * cause an unbounded query loop; it simply stops enumerating further descendants.
 * @param {import('pg').ClientBase} client
 * @param {number} rootId
 * @param {number} [maxHops]
 * @returns {Promise<number[]>}
 */
export async function collectDuplicateTreeIds(client, rootId, maxHops = MAX_DEDUP_HOPS) {
  const ids = new Set([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const r = await client.query('SELECT id FROM ic_job_listings WHERE duplicate_of = ANY($1::int[])', [frontier]);
    /** @type {number[]} */
    const next = [];
    for (const row of r.rows) {
      const id = Number(row.id);
      if (!ids.has(id)) { ids.add(id); next.push(id); }
    }
    frontier = next;
  }
  return Array.from(ids);
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number[]} listingIds
 * @param {string} stateClause SQL fragment already safe to inline (no user input) -- `<> 'withdrawn'` or `= 'withdrawn'`
 * @param {number|null} [excludeApplicationId] one application row to ignore -- see classifyExclusion's
 *   `excludeApplicationId` doc comment for why this exists (a one-click-Apply re-click reusing its OWN
 *   still-drafting application must not see that same row as "already applied").
 * @returns {Promise<boolean>}
 */
async function anyApplicationWithState(client, listingIds, stateClause, excludeApplicationId = null) {
  if (listingIds.length === 0) return false;
  const r = await client.query(
    `SELECT 1 FROM ic_job_applications WHERE listing_id = ANY($1::int[]) AND state ${stateClause} AND ($2::int IS NULL OR id <> $2::int) LIMIT 1`,
    [listingIds, excludeApplicationId],
  );
  return r.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Title similarity (spec branch c: pg_trgm similarity(title_norm, other) >= 0.5, done in SQL for both DB
// rows and config entries so no JS-vs-pg_trgm parity test is needed)
// ---------------------------------------------------------------------------

/**
 * One batched pg_trgm call: title_norm equality OR similarity >= threshold, for every candidate title in
 * `candidateTitles`, against `titleNorm`. Returns a same-length boolean array. An empty `candidateTitles`
 * short-circuits to `[]` without a query.
 * @param {import('pg').ClientBase} client
 * @param {string} titleNorm
 * @param {string[]} candidateTitles already-normalized (title_norm) strings
 * @param {number} [threshold]
 * @returns {Promise<boolean[]>}
 */
export async function batchTitleMatches(client, titleNorm, candidateTitles, threshold = TITLE_SIMILARITY_THRESHOLD) {
  if (candidateTitles.length === 0) return [];
  const r = await client.query(
    `SELECT ord, (t = $1 OR similarity($1, t) >= $3) AS is_match
     FROM unnest($2::text[]) WITH ORDINALITY AS u(t, ord)
     ORDER BY ord`,
    [titleNorm, candidateTitles, threshold],
  );
  return r.rows.map((row) => Boolean(row.is_match));
}

// ---------------------------------------------------------------------------
// classifyExclusion
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ExclusionListing
 * @property {number} id
 * @property {string|null} company raw company string
 * @property {string|null} [companyNorm] pre-computed company_norm; recomputed from `company` when absent
 * @property {string|null} title raw title string
 * @property {string|null} [titleNorm] pre-computed title_norm; recomputed from `title` when absent
 * @property {string|null} [applyUrl]
 * @property {string|null} [sourceUrl]
 * @property {string|null} [description]
 */

/**
 * @typedef {Object} ExclusionContext
 * @property {import('pg').ClientBase} client
 * @property {ExclusionConfig} config
 * @property {number|null} [excludeApplicationId] one application row to ignore when checking
 *   already_applied_listing/previously_withdrawn. ONLY for the one-click-Apply route re-checking a listing
 *   that already has ITS OWN application (typically still 'drafting') from an earlier click on the SAME
 *   listing -- that in-progress application is not "already applied to a different posting", it is the
 *   very click this call is continuing, and the pre-existing DUPLICATE_APPLICATION handling already governs
 *   re-entry into it. Never set for auto-apply's own selection pass (which only ever considers listings
 *   that have no application at all) or for the pre-submit recheck (which is deliberately checking the
 *   CURRENT application, not excluding it, at the one moment that matters most).
 */

/**
 * @typedef {Object} ExclusionResult
 * @property {typeof EXCLUSION_BRANCHES[number]} branch
 * @property {string} reason human-readable, safe to show in the dashboard/report
 * @property {Record<string, unknown>} evidence
 */

/** @param {string} branch @param {string} reason @param {Record<string, unknown>} [evidence] @returns {ExclusionResult} */
function result(branch, reason, evidence = {}) {
  return { branch, reason, evidence };
}

/**
 * Total, first-match-wins classification (see the module doc comment for the full branch order). Requires
 * a DB client in `ctx` -- branches (b), (b2), and (c) all need to query ic_job_listings/ic_job_applications
 * (dedup-tree walking and title similarity are not computable from `listing` alone).
 * @param {ExclusionListing} listing
 * @param {ExclusionContext} ctx
 * @returns {Promise<ExclusionResult>}
 */
export async function classifyExclusion(listing, ctx) {
  const { client, config } = ctx;
  const excludeApplicationId = ctx.excludeApplicationId ?? null;
  const companyNorm = listing.companyNorm ?? normalizeCompany(listing.company ?? '').company_norm;
  const listingTokens = companyNorm ? companyNorm.split(' ').filter(Boolean) : [];
  const titleNorm = listing.titleNorm ?? null;

  // (a) blocked_company (HARD): a blocked entry's tokens are a subset of the listing's company tokens.
  for (const entry of config.blockedCompanies) {
    const entryTokens = companyTokens(entry);
    if (isTokenSubset(entryTokens, listingTokens)) {
      return result('blocked_company', `company matches blocked employer "${entry}"`, { blocked_entry: entry, company_norm: companyNorm });
    }
  }

  // (b)/(b2): walk the dedup tree once, reuse for both.
  const rootId = await walkDuplicateRoot(client, listing.id);
  const treeIds = await collectDuplicateTreeIds(client, rootId);
  const hasNonWithdrawn = await anyApplicationWithState(client, treeIds, "<> 'withdrawn'", excludeApplicationId);
  if (hasNonWithdrawn) {
    return result('already_applied_listing', 'an active (non-withdrawn) application already exists for this listing or a listing it duplicates', { root_id: rootId, tree_ids: treeIds });
  }
  const hasWithdrawn = await anyApplicationWithState(client, treeIds, "= 'withdrawn'", excludeApplicationId);
  if (hasWithdrawn) {
    return result('previously_withdrawn', 'a previously withdrawn application exists for this listing or a listing it duplicates', { root_id: rootId, tree_ids: treeIds });
  }

  // (c)/(d): company + title match against config applied_history or other listings with a non-withdrawn
  // application. Build the candidate reference set first (JS-side company subset check, cheap and exact),
  // then resolve title similarity for the surviving candidates in ONE batched SQL call.
  /** @type {Array<{ title: string|null, source: string }>} */
  const companyMatches = [];
  for (const entry of config.appliedHistory) {
    const entryTokens = companyTokens(entry.company);
    if (tokensMatchBidirectional(listingTokens, entryTokens)) {
      companyMatches.push({ title: entry.title ? normalizeTitle(entry.title).title_norm : null, source: entry.source ?? entry.company });
    }
  }
  if (listingTokens.length > 0) {
    const otherApplied = await client.query(
      `SELECT DISTINCT l.company_norm, l.title_norm
       FROM ic_job_listings l
       JOIN ic_job_applications a ON a.listing_id = l.id AND a.state <> 'withdrawn'
       WHERE l.id <> ALL($1::int[]) AND l.company_norm IS NOT NULL AND l.company_norm <> ''`,
      [treeIds],
    );
    for (const row of otherApplied.rows) {
      const otherTokens = String(row.company_norm ?? '').split(' ').filter(Boolean);
      if (tokensMatchBidirectional(listingTokens, otherTokens)) {
        companyMatches.push({ title: row.title_norm ?? null, source: 'previously applied listing' });
      }
    }
  }
  if (companyMatches.length > 0) {
    const withTitle = companyMatches.filter((m) => m.title);
    if (titleNorm && withTitle.length > 0) {
      const matches = await batchTitleMatches(client, titleNorm, withTitle.map((m) => /** @type {string} */ (m.title)));
      const hitIdx = matches.findIndex(Boolean);
      if (hitIdx !== -1) {
        return result('already_applied_history', `already applied to "${withTitle[hitIdx].title}" at this company (${withTitle[hitIdx].source})`, { matched_title: withTitle[hitIdx].title, source: withTitle[hitIdx].source });
      }
    }
    return result('applied_company_other_role', `already applied to a different role at this company (${companyMatches[0].source})`, { source: companyMatches[0].source });
  }

  // (e) blocked_company_suspect (NEEDS_HUMAN): a blocked token as a whole word/phrase in the apply URL
  // host, source URL host, or description -- but the company field itself did not already match (a) above.
  for (const entry of config.blockedCompanies) {
    const entryTokens = companyTokens(entry);
    const applyHost = hostOf(listing.applyUrl);
    const sourceHost = hostOf(listing.sourceUrl);
    if (containsWholePhrase(applyHost, entryTokens) || containsWholePhrase(sourceHost, entryTokens) || containsWholePhrase(listing.description, entryTokens)) {
      return result('blocked_company_suspect', `blocked employer "${entry}" appears in the apply URL, source URL, or description but not in the listed company (possible staffing-agency indirection)`, { blocked_entry: entry });
    }
  }

  // (f) unknown_company (NEEDS_HUMAN)
  if (isUnknownCompany(listing.company, companyNorm)) {
    return result('unknown_company', 'company is missing, blank, a placeholder value, or too short to trust', { company_norm: companyNorm });
  }

  // (g) eligible
  return result('eligible', 'no exclusion applies');
}

/** @param {string|null|undefined} url */
function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
