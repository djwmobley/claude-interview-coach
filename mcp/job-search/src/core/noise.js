// @ts-check
/**
 * Noise classification for ranking (spec R2, decisions 1-8). classifyNoise() is a TOTAL classification:
 * every listing maps to exactly one of NOISE_CLASSES. Rule order is fixed by config/noise-rules.json's
 * `priority` field (ascending, first match wins) -- never file position (decision 5/8: no positional
 * assumption on a human-edited config file). A row that matches no config rule falls to the source check,
 * a terminal branch: a known adapter name -> 'ok', 'manual' -> 'ok_manual', anything else (null, empty,
 * unrecognized) -> 'unknown_source' (decision 4).
 *
 * classifyNoise() is pure and synchronous: no I/O, no config load on the hot path when opts.rules /
 * opts.knownSources are supplied (scan-run.js resolves those once per run and passes them in).
 */
import { loadConfig, NOISE_CLASSES } from './config.js';

export { NOISE_CLASSES };

/** @typedef {import('./config.js').LoadedConfig['noiseRules']} NoiseRulesConfig */

/**
 * @typedef {Object} NoiseClassifyInput
 * @property {string|null} [source]
 * @property {string|null} [title]
 * @property {string|null} [company_norm]
 * @property {string|null} [url_normalized]
 * @property {string|null} [external_id]
 * @property {string|null} [description]
 * @property {string|null} [salary_raw]
 */

// ---------------------------------------------------------------------------
// Config-backed defaults (mirrors normalize.js's getDefaultNormalizeOptions pattern)
// ---------------------------------------------------------------------------

/** @type {NoiseRulesConfig | null} */
let cachedRules = null;
/** @type {Set<string> | null} */
let cachedKnownSources = null;

/** Built-in fallback so noise.js is importable without a config directory (unit tests). */
const FALLBACK_RULES = /** @type {NoiseRulesConfig} */ ({
  rules: [
    { class: 'aggregator_repost', priority: 10, aggregatorHosts: ['lensa.com'], aggregatorGmailParsers: ['lensa'] },
    { class: 'fractional_or_founder', priority: 20 },
    { class: 'staffing_generic', priority: 30, staffingFirms: [] },
    { class: 'suspect', priority: 40 },
  ],
  multipliers: { ok: 1, ok_manual: 1, aggregator_repost: 0.6, fractional_or_founder: 0.5, staffing_generic: 0.7, unknown_source: 0.8, suspect: 0.8 },
});

export function getDefaultNoiseRules() {
  if (cachedRules) return cachedRules;
  try {
    cachedRules = loadConfig().noiseRules;
  } catch {
    cachedRules = FALLBACK_RULES;
  }
  return cachedRules;
}

export function getDefaultKnownSources() {
  if (cachedKnownSources) return cachedKnownSources;
  try {
    cachedKnownSources = new Set(Object.keys(loadConfig().adapters.adapters));
  } catch {
    cachedKnownSources = new Set(['greenhouse', 'lever', 'workday', 'dayforce', 'exec', 'indeed', 'linkedin', 'gmail']);
  }
  return cachedKnownSources;
}

/** Test hook: reset cached defaults. */
export function _resetNoiseDefaults() {
  cachedRules = null;
  cachedKnownSources = null;
}

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/**
 * @param {string|null|undefined} urlNormalized
 * @param {readonly string[]} hosts
 */
function urlHostIn(urlNormalized, hosts) {
  if (!urlNormalized || !hosts || hosts.length === 0) return false;
  let host;
  try {
    host = new URL(urlNormalized).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith('.' + h));
}

/** "(est.)" / "(est. based on level)" style marker. Structural only when paired with a gmail-sourced or aggregator-host row (decision 6). */
const EST_MARKER_RE = /\(\s*est\.?[^)]*\)/i;

/**
 * @param {NoiseClassifyInput} rec
 * @param {{ aggregatorHosts?: readonly string[], aggregatorGmailParsers?: readonly string[] }} rule
 */
function matchesAggregatorRepost(rec, rule) {
  const hostAgg = urlHostIn(rec.url_normalized, rule.aggregatorHosts ?? []);
  const parserAgg = rec.source === 'gmail' && typeof rec.external_id === 'string' && (rule.aggregatorGmailParsers ?? []).some((p) => rec.external_id.startsWith(`gmail:${p}:`));
  if (hostAgg || parserAgg) return true;
  // Decision 6: the "(est.)" salary marker is structural evidence ONLY when the row is gmail-sourced or
  // already on an aggregator host -- never applied to a native adapter row (a Greenhouse posting reading
  // "$180K-$220K (est. based on level)" must not false-positive; adversary finding 6).
  if (rec.source === 'gmail' && EST_MARKER_RE.test(rec.salary_raw ?? '')) return true;
  return false;
}

/** Title-only (decision 1: company_norm is NEVER scanned here -- "Founding Farmers Restaurant Group" as a company must not false-positive). */
const FRACTIONAL_WORDS_RE = /\b(fractional|interim\s+cto|co-?founder|founding)\b/i;
const FRACTIONAL_PHRASES_RE = /path to co-?founder|equity[- ]only/i;

/** @param {NoiseClassifyInput} rec */
function matchesFractionalOrFounder(rec) {
  const title = String(rec.title ?? '').toLowerCase();
  if (FRACTIONAL_WORDS_RE.test(title) || FRACTIONAL_PHRASES_RE.test(title)) return true;
  if (rec.description) {
    const desc = String(rec.description).toLowerCase();
    if (FRACTIONAL_WORDS_RE.test(desc) || FRACTIONAL_PHRASES_RE.test(desc)) return true;
  }
  return false;
}

/** Direct-hire escape (decision 3): a description saying this IS the employer, not a staffing firm posting on its behalf. */
const DIRECT_HIRE_RE = /\b(our own|internal(?:ly)?|join our leadership)\b/i;

/** @param {NoiseClassifyInput} rec */
function isCompanyOwnCareersHost(rec) {
  if (!rec.url_normalized || !rec.company_norm) return false;
  let host;
  try {
    host = new URL(rec.url_normalized).hostname.toLowerCase();
  } catch {
    return false;
  }
  const slug = rec.company_norm.replace(/[^a-z0-9]/g, '');
  if (!slug) return false;
  const hostCore = host.replace(/^www\./, '').split('.')[0];
  return hostCore === slug || (hostCore.length > 3 && hostCore.includes(slug));
}

/**
 * @param {NoiseClassifyInput} rec
 * @param {{ staffingFirms?: readonly string[] }} rule
 */
function matchesStaffingGeneric(rec, rule) {
  const firms = rule.staffingFirms ?? [];
  if (!rec.company_norm || firms.length === 0 || !firms.includes(rec.company_norm)) return false;
  if (isCompanyOwnCareersHost(rec)) return false;
  if (rec.description) {
    return !DIRECT_HIRE_RE.test(rec.description);
  }
  // No description available: friction over escape (decision 3) -- still classify staffing_generic so the
  // report shows the class and the operator can see why, rather than silently trusting the company name.
  return true;
}

const SUSPECT_TITLE_RE = /\b(virtual\s+cto|advisor|equity|commission)\b/i;
/** @param {NoiseClassifyInput} rec */
function matchesSuspect(rec) {
  const title = String(rec.title ?? '').toLowerCase();
  if (SUSPECT_TITLE_RE.test(title)) return true;
  if (rec.company_norm && rec.company_norm.length > 0 && rec.company_norm.length < 4) return true;
  return false;
}

/** @type {Record<string, (rec: NoiseClassifyInput, rule: any) => boolean>} */
const MATCHERS = {
  aggregator_repost: matchesAggregatorRepost,
  fractional_or_founder: matchesFractionalOrFounder,
  staffing_generic: matchesStaffingGeneric,
  suspect: matchesSuspect,
};

/**
 * Total classification of a listing's noise_class (spec R2.1).
 * @param {NoiseClassifyInput} rec
 * @param {{ rules?: NoiseRulesConfig, knownSources?: Set<string> }} [opts]
 * @returns {string} one of NOISE_CLASSES
 */
export function classifyNoise(rec, opts = {}) {
  const cfg = opts.rules ?? getDefaultNoiseRules();
  const knownSources = opts.knownSources ?? getDefaultKnownSources();
  const sortedRules = [...cfg.rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sortedRules) {
    const matcher = MATCHERS[rule.class];
    if (matcher && matcher(rec, rule)) return rule.class;
  }
  // Terminal source check (decision 4): lowercase-trimmed compare, total classification of source.
  const source = String(rec.source ?? '').trim().toLowerCase();
  if (!source) return 'unknown_source';
  if (source === 'manual') return 'ok_manual';
  const lookup = source.startsWith('exec:') ? 'exec' : source;
  return knownSources.has(lookup) ? 'ok' : 'unknown_source';
}

/**
 * Apply a noise_class multiplier to a raw prescore, rounding the same way prescore() does.
 * @param {number} raw
 * @param {string} noiseClass
 * @param {{ rules?: NoiseRulesConfig }} [opts]
 */
export function weightedPrescore(raw, noiseClass, opts = {}) {
  const cfg = opts.rules ?? getDefaultNoiseRules();
  const mult = typeof cfg.multipliers[noiseClass] === 'number' ? cfg.multipliers[noiseClass] : 1;
  return Math.max(0, Math.min(100, Math.round(raw * mult)));
}

/**
 * Lint config/noise-rules.json against config/noise-fixtures.json (decision 8): every fixture's expected
 * class must still hold under the CURRENT rule set. Used by bin/config-lock.js (both check and --write)
 * and by test/noise.test.js so drift in either file is caught in the same place.
 * @param {NoiseRulesConfig} rules
 * @param {Array<{ name: string, listing: NoiseClassifyInput, expected_class: string }>} fixtures
 * @param {{ knownSources?: Set<string> }} [opts]
 * @returns {{ ok: boolean, failures: Array<{ name: string, expected: string, actual: string }> }}
 */
export function lintNoiseFixtures(rules, fixtures, opts = {}) {
  /** @type {Array<{ name: string, expected: string, actual: string }>} */
  const failures = [];
  for (const f of fixtures) {
    const actual = classifyNoise(f.listing, { rules, knownSources: opts.knownSources });
    if (actual !== f.expected_class) failures.push({ name: f.name, expected: f.expected_class, actual });
  }
  return { ok: failures.length === 0, failures };
}
