// @ts-check
/**
 * Apply-target resolution (auto-apply PR B, docs/auto-apply-spec.md). A scanned listing's own URL is
 * frequently NOT the real ATS apply page: LinkedIn wraps an external "Apply on company site" link behind
 * a `linkedin.com/safety/go/?url=<encoded>` interstitial; job aggregators/intermediaries (Lensa, Jobot,
 * ZipRecruiter, Glassdoor, talent.com, Adzuna, beBee, Jooble, WhatJobs) commonly redirect once or twice
 * more before landing on the real ATS. This module resolves a CANDIDATE href (already extracted at scan
 * time -- this file never touches a browser or DOM itself) down to a final, classified apply target, or
 * reports it unresolved.
 *
 * isExactTarget is the single gate: `confidence === 'exact'`, per src/apply/ats-detect.js's own contract
 * -- NOT an allow-list of ATS names (a total classification over confidence, never a hand-picked subset
 * of `ats` values). The one refinement on top of that is Workday-specific: ats-detect.js's
 * WORKDAY_HOST_RE matches a Workday tenant HOST for any path at all (there is no path shape in that
 * regex), which is correct for classify-only display purposes but too loose for auto-apply's own
 * decision to treat a URL as a submittable posting -- a bare `https://acme.wd1.myworkdayjobs.com/en-US/
 * External` (the tenant's search/landing page, not a specific job) must never be treated as an exact,
 * automatable apply target. isExactTarget additionally requires a `/job/` path segment for Workday only,
 * mirroring src/adapters/workday.js's own scan-adapter convention (`segs.indexOf('job')`) for what counts
 * as a posting URL on that ATS.
 *
 * Every other ATS's 'exact' tier already carries its own structural path requirement inside
 * classifyApplyUrl itself (Greenhouse's `/jobs/<id>`, Lever's `/<tenant>/<uuid>`, Dayforce's
 * CandidatePortal path, iCIMS's `/jobs/<id>` path), so no further refinement is needed for them here.
 */
import { classifyApplyUrl } from './ats-detect.js';
import { resolveRedirects } from './probe-registry.js';

/**
 * Job-board intermediaries/aggregators known to sit between a scanned listing and the real ATS. A
 * candidate href on one of these hosts is worth a redirect chase (resolveApplyTarget below); anything
 * else that is not already an exact target itself is left unresolved rather than chased -- chasing an
 * arbitrary unknown host's redirects is exactly the "arbitrary destination" risk the probe registry's
 * host allow-list exists to prevent.
 */
export const INTERMEDIARY_HOSTS = Object.freeze([
  'lensa.com', 'jobot.com', 'ziprecruiter.com', 'glassdoor.com', 'talent.com',
  'adzuna.com', 'bebee.com', 'jooble.org', 'whatjobs.com',
]);

/** Dot-boundary host suffix match (identical semantics to urlguard.js's hostMatches). */
function hostIs(host, base) {
  return host === base || host.endsWith('.' + base);
}

/**
 * @param {string} host lowercase
 */
export function isIntermediaryHost(host) {
  const h = String(host ?? '').toLowerCase();
  return INTERMEDIARY_HOSTS.some((d) => hostIs(h, d));
}

/** Workday posting-path requirement (see module doc comment): a literal `/job/` segment, case-insensitive. */
const WORKDAY_POSTING_PATH_RE = /\/job\//i;

/**
 * Decode a LinkedIn `safety/go` interstitial href to the real external URL it wraps, WITHOUT ever
 * fetching or navigating to it (pure string decode). Total: any input that is not a linkedin.com host, not
 * the `/safety/go/` path, missing the `url` query param, or whose decoded value is not itself a parseable
 * http(s) URL returns null rather than throwing or guessing.
 * @param {unknown} href
 * @returns {string|null}
 */
export function decodeLinkedInSafetyGo(href) {
  if (typeof href !== 'string' || !href.trim()) return null;
  /** @type {URL} */
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!hostIs(u.hostname.toLowerCase(), 'linkedin.com')) return null;
  if (!/^\/safety\/go\/?$/i.test(u.pathname)) return null;
  const raw = u.searchParams.get('url');
  if (!raw) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  try {
    const target = new URL(decoded);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return decoded;
}

/** ATSs that are classify-only (src/apply/adapters/linkedin-easy.js, indeed-easy.js -- worker.js checks
 * `adapter.classifyOnly` and never automates them). ats-detect.js's own classifyApplyUrl() still reports
 * 'exact' confidence for these (it is certain about the ATS itself, just not about automatability -- see
 * that module's own doc comment), so isExactTarget below excludes them explicitly: an "exact" target for
 * auto-apply purposes must mean "automatable", never merely "identifiable". */
const CLASSIFY_ONLY_ATS = Object.freeze(['linkedin_easy', 'indeed_easy']);

/**
 * The single automation gate (see module doc comment): confidence === 'exact', with the Workday
 * posting-path refinement and the classify-only-ATS exclusion above. Never an allow-list of automatable
 * `ats` values -- CLASSIFY_ONLY_ATS is a deny-list of the two ATSs this codebase already knows, by
 * construction, can never be automated (src/apply/worker.js's classifyOnly gate), not a hand-picked subset
 * of what auto-apply happens to support today.
 * @param {{ ats: string, tenant: string|null, confidence: 'exact'|'inferred'|'low' }|null|undefined} classification
 * @param {string} urlStr the URL `classification` was derived from
 * @returns {boolean}
 */
export function isExactTarget(classification, urlStr) {
  if (!classification || classification.confidence !== 'exact') return false;
  if (CLASSIFY_ONLY_ATS.includes(classification.ats)) return false;
  if (classification.ats !== 'workday') return true;
  if (typeof urlStr !== 'string') return false;
  /** @type {URL} */
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  return WORKDAY_POSTING_PATH_RE.test(u.pathname);
}

/**
 * @typedef {{ resolved: true, url: string, ats: string, confidence: 'exact' }
 *   | { resolved: false, reason: 'no_candidate'|'invalid_url'|'apply_target_unresolved', host?: string|null }} ApplyTargetResult
 */

/**
 * Resolve one candidate apply href to a final, classified apply target. Total classification, never
 * throws (a redirect chase failure is folded into the 'apply_target_unresolved' branch, same as an
 * intermediary that simply never leads anywhere exact).
 *
 * Order:
 *   1. decode a LinkedIn safety/go wrapper if present (no network call);
 *   2. classify the (decoded or original) candidate directly -- an exact target needs no redirect chase;
 *   3. if not already exact and the host is a known intermediary, chase redirects through the probe
 *      registry and classify the FINAL url;
 *   4. anything else (an unknown, non-intermediary host that is not itself exact) is left unresolved --
 *      this function never guesses at an arbitrary host's destination.
 * @param {unknown} candidateHref
 * @param {import('./probe-registry.js').ProbeRegistry} probeRegistry
 * @param {{ fetch?: typeof fetch, lookup?: import('../core/urlguard.js').Lookup, timeoutMs?: number }} [opts]
 * @returns {Promise<ApplyTargetResult>}
 */
export async function resolveApplyTarget(candidateHref, probeRegistry, opts = {}) {
  if (typeof candidateHref !== 'string' || !candidateHref.trim()) {
    return { resolved: false, reason: 'no_candidate' };
  }
  const decoded = decodeLinkedInSafetyGo(candidateHref) ?? candidateHref;
  /** @type {string} */
  let host;
  try {
    host = new URL(decoded).hostname.toLowerCase();
  } catch {
    return { resolved: false, reason: 'invalid_url' };
  }

  const direct = classifyApplyUrl(decoded);
  if (isExactTarget(direct, decoded)) {
    return { resolved: true, url: decoded, ats: direct.ats, confidence: 'exact' };
  }

  if (!isIntermediaryHost(host)) {
    return { resolved: false, reason: 'apply_target_unresolved', host };
  }

  /** @type {{ url: string, status: number, hops: number }} */
  let final;
  try {
    final = await resolveRedirects(decoded, probeRegistry, opts);
  } catch {
    return { resolved: false, reason: 'apply_target_unresolved', host };
  }
  const classification = classifyApplyUrl(final.url);
  if (isExactTarget(classification, final.url)) {
    return { resolved: true, url: final.url, ats: classification.ats, confidence: 'exact' };
  }
  let finalHost = host;
  try {
    finalHost = new URL(final.url).hostname.toLowerCase();
  } catch {
    /* keep the original intermediary host */
  }
  return { resolved: false, reason: 'apply_target_unresolved', host: finalHost };
}
