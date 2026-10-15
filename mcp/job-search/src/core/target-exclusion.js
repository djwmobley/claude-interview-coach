// @ts-check
/**
 * Target finder exclusion wrapper. Signals are about companies, not job listings, so this does NOT call
 * src/apply/exclusions.js classifyExclusion() (which needs a DB client and a listing.id dedup walk). It
 * reuses that module's pure matchers and its BUILT_IN_BLOCKED / EXCLUSION_BRANCHES / isUnknownCompany,
 * evaluates the branches a signal can reach (a blocked_company, e blocked_company_suspect, f
 * unknown_company, plus an optional applied-company list for d applied_company_other_role, g eligible),
 * and maps EVERY one of the 8 classifyExclusion branches to a signal verdict through
 * SIGNAL_EXCLUSION_MAP. The listing-id branches (already_applied_listing, previously_withdrawn,
 * already_applied_history) are mapped but unreachable here by design; an unmapped branch name is
 * needs-review, never a pass.
 *
 * Normalization (step 0): NFKC, zero-width / soft-hyphen / Cf strip, whitespace collapse. Matching runs on
 * the normal form (whole-token / whole-phrase) AND on the space-stripped form (letters and digits only,
 * accents folded). A space-stripped-only match can never be not-target: it is needs-review (suspect).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILT_IN_BLOCKED, companyTokens, isTokenSubset, tokensMatchBidirectional, containsWholePhrase, isUnknownCompany,
} from '../apply/exclusions.js';
import { stripZeroWidth, normalizeCompany } from './normalize.js';
import { getEnv } from './config.js';

/**
 * NFKC, strip zero-width / format characters (incl. soft hyphen), collapse whitespace, trim.
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeName(s) {
  if (s === null || s === undefined) return '';
  let t = typeof s === 'string' ? s : (typeof s === 'number' || typeof s === 'boolean' ? String(s) : '');
  t = t.normalize('NFKC');
  t = stripZeroWidth(t);
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Letters and digits only, lowercase, accents folded. "Ad vis-icon" and "Advisicon" collide here.
 * @param {string} s
 */
export function strippedForm(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * @typedef {Object} SignalExclusionMapping
 * @property {'not-target'|'needs-review'|null} class null = no exclusion, continue
 * @property {string|null} rule rule id in config/target-rules.json
 */

/** The total mapping from every classifyExclusion branch to a signal verdict. No branch falls through to target. */
export const SIGNAL_EXCLUSION_MAP = Object.freeze(/** @type {Record<string, SignalExclusionMapping>} */ ({
  blocked_company: { class: 'not-target', rule: 'excl_blocked_company' },
  already_applied_listing: { class: 'needs-review', rule: 'excl_applied_before' },
  previously_withdrawn: { class: 'needs-review', rule: 'excl_applied_before' },
  already_applied_history: { class: 'needs-review', rule: 'excl_applied_before' },
  applied_company_other_role: { class: 'needs-review', rule: 'excl_applied_before' },
  blocked_company_suspect: { class: 'needs-review', rule: 'excl_blocked_suspect' },
  unknown_company: { class: 'needs-review', rule: 'excl_unknown_company' },
  eligible: { class: null, rule: null },
}));

/**
 * @param {string} branch any string
 * @returns {SignalExclusionMapping}
 */
export function mapExclusionBranch(branch) {
  const m = Object.prototype.hasOwnProperty.call(SIGNAL_EXCLUSION_MAP, branch) ? SIGNAL_EXCLUSION_MAP[branch] : undefined;
  return m ?? { class: 'needs-review', rule: 'excl_unmapped_branch' };
}

/** The branch names SIGNAL_EXCLUSION_MAP covers; a test asserts this equals EXCLUSION_BRANCHES in src/apply/exclusions.js. */
export const MAPPED_BRANCHES = Object.freeze(Object.keys(SIGNAL_EXCLUSION_MAP));

/**
 * @typedef {Object} BlockedList
 * @property {string[]} entries BUILT_IN_BLOCKED first, then the configured affiliates
 * @property {'ok'|'missing'|'invalid'} status
 * @property {string|null} error
 */

/** @param {string} [configDir] */
export function blockedAffiliatesPath(configDir = getEnv().JOBSEARCH_CONFIG_DIR) {
  return path.join(configDir, 'blocked-affiliates.json');
}

/**
 * Load config/blocked-affiliates.json fresh from disk. Never throws: a missing or invalid file yields
 * the built-ins only with status 'missing'/'invalid', and the classifier then refuses to emit target
 * (rule excl_blocklist_unavailable) so an unattended run keeps going but nothing escapes silently.
 * @param {string} [configDir]
 * @returns {BlockedList}
 */
export function loadBlockedAffiliates(configDir = getEnv().JOBSEARCH_CONFIG_DIR) {
  const file = blockedAffiliatesPath(configDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { entries: [...BUILT_IN_BLOCKED], status: 'missing', error: err instanceof Error ? err.message.slice(0, 200) : 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    const list = parsed.blocked_affiliates;
    if (!Array.isArray(list)) throw new Error('blocked_affiliates must be an array');
    /** @type {string[]} */
    const extra = [];
    for (const [i, e] of list.entries()) {
      if (typeof e !== 'string' || !normalizeName(e)) throw new Error(`blocked_affiliates[${i}] must be a non-empty string`);
      extra.push(e);
    }
    return { entries: [...BUILT_IN_BLOCKED, ...extra], status: 'ok', error: null };
  } catch (err) {
    return { entries: [...BUILT_IN_BLOCKED], status: 'invalid', error: err instanceof Error ? err.message.slice(0, 200) : 'invalid' };
  }
}

/**
 * Seed config/blocked-affiliates.json from the tracked empty example, never overwriting an existing file.
 * @param {string} [configDir]
 * @returns {'seeded'|'exists'|'no_example'}
 */
export function seedBlockedAffiliates(configDir = getEnv().JOBSEARCH_CONFIG_DIR) {
  const target = blockedAffiliatesPath(configDir);
  if (fs.existsSync(target)) return 'exists';
  const example = path.join(configDir, 'blocked-affiliates.example.json');
  if (!fs.existsSync(example)) return 'no_example';
  try {
    fs.copyFileSync(example, target, fs.constants.COPYFILE_EXCL);
  } catch {
    return 'exists';
  }
  return 'seeded';
}

/**
 * @typedef {Object} ExclusionParties
 * @property {unknown} company the target company
 * @property {unknown[]} [aliases] alias group: other names of the same company
 * @property {unknown[]} [otherParties] acquirer, investor, PE firm, anything else named
 * @property {unknown[]} [texts] free text (excerpt, evidence URL) searched for blocked names
 */

/**
 * @typedef {Object} SignalExclusionResult
 * @property {string} branch one of EXCLUSION_BRANCHES
 * @property {'not-target'|'needs-review'|null} class
 * @property {string|null} rule
 * @property {Record<string, unknown>} detail
 */

/**
 * Evaluate the exclusion branches for one signal. Total: always returns a branch.
 * @param {ExclusionParties} parties
 * @param {{ blocked: string[], appliedCompanies?: string[], strippedMinLength?: number }} ctx
 * @returns {SignalExclusionResult}
 */
export function classifySignalExclusion(parties, ctx) {
  const minLen = ctx.strippedMinLength ?? 4;
  const companyName = normalizeName(parties.company);
  const companyNorm = normalizeCompany(companyName).company_norm;
  const companyToks = companyNorm ? companyNorm.split(' ').filter(Boolean) : [];
  const aliasNames = (parties.aliases ?? []).map(normalizeName).filter(Boolean);
  const otherNames = (parties.otherParties ?? []).map(normalizeName).filter(Boolean);
  const textNames = (parties.texts ?? []).map(normalizeName).filter(Boolean);

  const blockedEntries = ctx.blocked.map((e) => ({ entry: e, toks: companyTokens(normalizeName(e)), stripped: strippedForm(normalizeName(e)) }));

  /** @param {'company'|'alias'|'party'|'text'} field @param {string} value */
  const hitsFor = (field, value) => {
    /** @type {Array<{ field: string, value: string, entry: string, via: 'token'|'phrase'|'stripped' }>} */
    const hits = [];
    const toks = companyTokens(value);
    const stripped = strippedForm(value);
    for (const b of blockedEntries) {
      if (b.toks.length === 0) continue;
      let via = /** @type {'token'|'phrase'|'stripped'|null} */ (null);
      if (field === 'text') {
        if (containsWholePhrase(value, b.toks)) via = 'phrase';
      } else if (isTokenSubset(b.toks, toks) || containsWholePhrase(value, b.toks)) {
        via = field === 'party' ? 'phrase' : 'token';
      }
      if (!via && b.stripped.length >= minLen && stripped.includes(b.stripped)) via = 'stripped';
      if (via) hits.push({ field, value: value.slice(0, 120), entry: b.entry, via });
    }
    return hits;
  };

  const companyHits = [...(companyName ? hitsFor('company', companyName) : []), ...aliasNames.flatMap((a) => hitsFor('alias', a))];
  const hardCompany = companyHits.find((h) => h.via === 'token');
  if (hardCompany) return branchResult('blocked_company', { matched: hardCompany });

  const suspectHits = [
    ...companyHits.filter((h) => h.via !== 'token'),
    ...otherNames.flatMap((o) => hitsFor('party', o)),
    ...textNames.flatMap((t) => hitsFor('text', t)),
  ];
  if (suspectHits.length > 0) return branchResult('blocked_company_suspect', { matched: suspectHits[0], match_count: suspectHits.length });

  if (isUnknownCompany(companyName, companyNorm)) return branchResult('unknown_company', { company_norm: companyNorm });

  for (const a of ctx.appliedCompanies ?? []) {
    if (tokensMatchBidirectional(companyToks, companyTokens(normalizeName(a)))) {
      return branchResult('applied_company_other_role', { applied_company: a });
    }
  }
  return branchResult('eligible', {});
}

/** @param {string} branch @param {Record<string, unknown>} detail @returns {SignalExclusionResult} */
function branchResult(branch, detail) {
  const m = mapExclusionBranch(branch);
  return { branch, class: m.class, rule: m.rule, detail };
}
