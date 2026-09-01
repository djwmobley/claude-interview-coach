// @ts-check
/**
 * ATS detector (apply pipeline slice 2, plan `let-s-brainstorm-a-bit-humble-umbrella.md` section
 * "3. ATS detection and apply adapters", first paragraph). classifyApplyUrl(url, {html}) is a TOTAL
 * classification: every input, including garbage, non-string values, and a URL this codebase has never
 * seen, maps to a defined {ats, tenant, confidence} result. `unknown` is the default branch, never a
 * throw -- an unrecognized posting lands directly in needs_human ("apply by hand, then mark applied"),
 * which is the safe failure mode for an apply pipeline.
 *
 * Host source of truth (spec-adversary amendment S2): `new URL(input).hostname` ONLY. Nothing in this
 * file ever runs a regex over the raw URL string to decide the host -- that is exactly the userinfo-trick
 * evasion (`https://boards.greenhouse.io@evil.com/x`, where `new URL(...).hostname` is `evil.com`, not
 * `boards.greenhouse.io`) that a naive substring/regex check on the raw string would fall for. Every host
 * comparison below is either an exact array membership check (Greenhouse's five hosts, Lever's two hosts,
 * SmartRecruiters' two hosts -- copied verbatim from the lists src/core/normalize.js already uses in
 * production, or from the spec where normalize.js has no prior art) or the dot-boundary `hostIs()` helper
 * (host === base || host.endsWith('.' + base)), which is the same helper normalize.js uses and is proven
 * safe against a suffix spoof like `greenhouse.io.example.com` or `evil-greenhouse.io`.
 *
 * confidence is a closed, total enum: 'exact' | 'inferred' | 'low'.
 *   - 'exact': the canonical direct apply-URL shape for that ATS, where the tenant is structurally
 *     load-bearing in the URL itself (e.g. Greenhouse boards.greenhouse.io/<tenant>/jobs/<id>, Lever
 *     jobs.lever.co/<tenant>/<uuid>, Workday <tenant>.wd<N>.myworkdayjobs.com). LinkedIn/Indeed easy-apply
 *     classification is also 'exact' even though tenant is always null for them -- there is nothing
 *     ambiguous about identifying the ATS itself from those URL shapes, only the tenant concept does not
 *     apply (they are classify-only; see ATS_TYPES and the spec's slice list, item 8).
 *   - 'inferred': the tenant is asserted by a query parameter or an embedded iframe an unrelated page
 *     (or an agency repost) could set to any value, e.g. Greenhouse's `/embed/job_app?for=<tenant>` or a
 *     single-tenant Greenhouse iframe found via the `html` option. Real, but not structurally guaranteed.
 *   - 'low': the ats is known but the tenant could not be determined at all (tenant is always null),
 *     or the ats is known only from a loose signal (a bare `gh_jid` query param on an arbitrary host).
 *
 * CONTRACT (spec-adversary amendment S6, enforced starting slice 5, not by this module): only 'exact' is
 * eligible for the automated apply path. 'inferred' and 'low' always route to needs_human -- a tailored
 * document or a submitted application built from a tenant this module is not certain of is a materially
 * worse failure mode than an extra manual click, per the plan's own classifier-traps warning about a
 * staffing-agency repost on `boards.greenhouse.io/embed/job_app?for=agency` tailoring to the wrong company.
 */
import { loadConfig } from '../core/config.js';
import { ATS_TYPES } from '../core/applications.js';

export { ATS_TYPES };

/** The closed, total confidence enum documented above. */
export const CONFIDENCE_LEVELS = Object.freeze(['exact', 'inferred', 'low']);

// ---------------------------------------------------------------------------
// Pinned structural rules (spec-adversary amendment S4): Workday's
// tenant.wd<N>.myworkdayjobs.com hostname shape and Dayforce's
// /CandidatePortal/<lang>/<client>/Posting/View/<id> path shape are code, not
// config data. Keeping them here (never in config/ats-apply.json) means a
// config edit alone can never loosen either match -- only a reviewed code
// change can. Both are copied verbatim from src/core/normalize.js's own
// production regexes for these ATSs (verified against that file directly;
// the code there is the source of truth this module mirrors).
// ---------------------------------------------------------------------------

const WORKDAY_HOST_RE = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/;
// myworkdaysite.com is explicitly NOT Workday: it is a distinct
// candidate/company custom-domain product, structurally unrelated to the
// wd<N>.myworkdayjobs.com tenant-hosted board this regex matches. Do not add
// it here, and do not loosen this regex to a suffix match on
// "myworkday*.com" -- both would silently misclassify it as Workday.
const DAYFORCE_CANDIDATE_PORTAL_RE = /^\/candidateportal\/([a-z]{2}-[a-z]{2})\/([^/]+)\/posting\/view\/(\d+)/i;
const GREENHOUSE_JOBS_PATH_RE = /^\/(?:v1\/boards\/)?([a-z0-9-]+)\/jobs\/(\d+)/i;
const GREENHOUSE_EMBED_PATH_RE = /^\/embed\/job_app/i;
const GREENHOUSE_TENANT_TOKEN_RE = /^[a-z0-9-]+$/i;
const LEVER_PATH_RE = /^\/(?:v0\/postings\/)?([a-z0-9-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/apply)?\/?$/i;
const GH_JID_RE = /^\d+$/;

/**
 * Built-in fallback host registry: identical in content to config/ats-apply.json's default file, so this
 * module is importable (and every host check still works) without a config directory present, e.g. a
 * unit test that never calls loadConfig() itself. Mirrors src/core/normalize.js's own
 * getDefaultNormalizeOptions() fallback pattern and rationale.
 */
const DEFAULT_ATS_OPTIONS = Object.freeze({
  greenhouseHosts: Object.freeze(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'boards-api.greenhouse.io', 'my.greenhouse.io']),
  leverHosts: Object.freeze(['jobs.lever.co', 'api.lever.co']),
  smartrecruitersHosts: Object.freeze(['jobs.smartrecruiters.com', 'careers.smartrecruiters.com']),
  icimsHostSuffix: 'icims.com',
  dayforceHostSuffix: 'dayforcehcm.com',
  linkedinHostSuffix: 'linkedin.com',
  indeedHostSuffix: 'indeed.com',
});

/** @type {typeof DEFAULT_ATS_OPTIONS | null} */
let cachedOptions = null;

/**
 * Lazily build the host registry from config/ats-apply.json, falling back to the built-ins on any load
 * or validation failure so a missing/broken config directory never breaks classification (it only means
 * a config change that was supposed to widen a host list silently did not take effect -- config.js's own
 * loadConfig() is what enforces CONFIG_INVALID for a malformed file at the point it is actually loaded
 * for real use, e.g. bin/config-lock.js and the scan/apply entry points; this module's own fallback is
 * purely an import-time safety net, mirroring normalize.js's identical rationale for its own defaults).
 * @returns {typeof DEFAULT_ATS_OPTIONS}
 */
function getAtsOptions() {
  if (cachedOptions) return cachedOptions;
  let opts = DEFAULT_ATS_OPTIONS;
  try {
    const cfg = loadConfig();
    if (cfg && cfg.atsApply) {
      opts = {
        greenhouseHosts: cfg.atsApply.greenhouse.hosts.map((h) => h.toLowerCase()),
        leverHosts: cfg.atsApply.lever.hosts.map((h) => h.toLowerCase()),
        smartrecruitersHosts: cfg.atsApply.smartrecruiters.hosts.map((h) => h.toLowerCase()),
        icimsHostSuffix: cfg.atsApply.icims.hostSuffix.toLowerCase(),
        dayforceHostSuffix: cfg.atsApply.dayforce.hostSuffix.toLowerCase(),
        linkedinHostSuffix: cfg.atsApply.linkedin.hostSuffix.toLowerCase(),
        indeedHostSuffix: cfg.atsApply.indeed.hostSuffix.toLowerCase(),
      };
    }
  } catch {
    /* built-ins */
  }
  cachedOptions = opts;
  return opts;
}

/** Test hook: reset the cached host registry (mirrors normalize.js's _resetDefaultNormalizeOptions). */
export function _resetAtsOptionsCache() {
  cachedOptions = null;
}

/**
 * Dot-boundary host suffix match (identical semantics to src/core/normalize.js's private hostIs helper):
 * exact match or a `.`-delimited subdomain -- never a bare substring match, which is what a suffix-spoof
 * host like `evilicims.com` or `notdayforcehcm.com` would otherwise slip through on.
 * @param {string} host lowercase
 * @param {string} base lowercase
 */
function hostIs(host, base) {
  return host === base || host.endsWith('.' + base);
}

/** @typedef {{ ats: string, tenant: string|null, confidence: 'exact'|'inferred'|'low' }} AtsClassification */

/** @type {AtsClassification} */
const UNKNOWN = Object.freeze({ ats: 'unknown', tenant: null, confidence: 'low' });

const IFRAME_SRC_RE = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

/**
 * Collect every DISTINCT Greenhouse tenant named by a Greenhouse-host iframe embed in `html`
 * (spec-adversary amendment S7). Never first-match-wins: the caller decides ats/tenant/confidence from
 * the SIZE of the returned set (one tenant -> inferred, two-or-more -> unknown, an aggregator page must
 * never silently resolve to whichever tenant's iframe happened to appear first in the markup). Total:
 * malformed HTML, a relative/protocol-relative iframe src (cannot resolve a host without guessing, so it
 * is skipped rather than assumed), or no iframes at all all fall out as an empty set, never a throw.
 * @param {string} html
 * @param {readonly string[]} greenhouseHosts lowercase
 * @returns {Set<string>}
 */
function collectGreenhouseIframeTenants(html, greenhouseHosts) {
  /** @type {Set<string>} */
  const tenants = new Set();
  IFRAME_SRC_RE.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = IFRAME_SRC_RE.exec(html)) !== null) {
    const src = m[1].replace(/&amp;/gi, '&');
    if (!/^https?:\/\//i.test(src)) continue; // relative/protocol-relative src: no host to resolve, skip
    /** @type {URL} */
    let iu;
    try {
      iu = new URL(src);
    } catch {
      continue;
    }
    const ihost = iu.hostname.toLowerCase();
    if (!greenhouseHosts.includes(ihost)) continue;
    const forParam = iu.searchParams.get('for');
    if (forParam && GREENHOUSE_TENANT_TOKEN_RE.test(forParam)) {
      tenants.add(forParam.toLowerCase());
      continue;
    }
    const pm = GREENHOUSE_JOBS_PATH_RE.exec(iu.pathname);
    if (pm) tenants.add(pm[1].toLowerCase());
  }
  return tenants;
}

/**
 * Classify an apply URL (and, optionally, the fetched page's HTML) by ATS. TOTAL: never throws, for any
 * input of any type. See the module doc comment for the confidence contract.
 * @param {unknown} url
 * @param {{ html?: string }} [opts]
 * @returns {AtsClassification}
 */
export function classifyApplyUrl(url, opts = {}) {
  const html = opts && typeof opts.html === 'string' ? opts.html : null;

  // Total input guard (spec-adversary amendment S1): non-string, empty/whitespace, anything not shaped
  // like http(s)://, or a URL the WHATWG parser itself rejects all fall through to the same 'unknown'
  // branch below rather than throwing. Mirrors normalizeUrl()'s identical guard in normalize.js.
  if (typeof url !== 'string') return { ...UNKNOWN };
  const raw = url.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return { ...UNKNOWN };
  /** @type {URL} */
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ...UNKNOWN };
  }

  // S2: hostname is the ONLY host source of truth. new URL('https://boards.greenhouse.io@evil.com/x')
  // .hostname is 'evil.com', never 'boards.greenhouse.io' -- the userinfo-before-@ trick is defeated by
  // construction here, not by a special case.
  const host = u.hostname.toLowerCase();
  const o = getAtsOptions();

  if (o.greenhouseHosts.includes(host)) {
    const m = GREENHOUSE_JOBS_PATH_RE.exec(u.pathname);
    if (m) return { ats: 'greenhouse', tenant: m[1].toLowerCase(), confidence: 'exact' };
    if (GREENHOUSE_EMBED_PATH_RE.test(u.pathname)) {
      const forParam = u.searchParams.get('for');
      if (forParam && GREENHOUSE_TENANT_TOKEN_RE.test(forParam)) {
        // A staffing-agency repost can set `for=` to any tenant it wants (plan's own classifier-trap
        // warning), so this is asserted-by-query-param, not structurally guaranteed: 'inferred', never
        // 'exact'.
        return { ats: 'greenhouse', tenant: forParam.toLowerCase(), confidence: 'inferred' };
      }
    }
    // A registered Greenhouse host with no recognized path shape: still definitely Greenhouse, tenant
    // unknown.
    return { ats: 'greenhouse', tenant: null, confidence: 'low' };
  }

  if (o.leverHosts.includes(host)) {
    const m = LEVER_PATH_RE.exec(u.pathname);
    if (m) return { ats: 'lever', tenant: m[1].toLowerCase(), confidence: 'exact' };
    return { ats: 'lever', tenant: null, confidence: 'low' };
  }

  const wd = WORKDAY_HOST_RE.exec(host);
  if (wd) return { ats: 'workday', tenant: wd[1].toLowerCase(), confidence: 'exact' };

  if (hostIs(host, o.dayforceHostSuffix)) {
    const m = DAYFORCE_CANDIDATE_PORTAL_RE.exec(u.pathname);
    if (m) return { ats: 'dayforce', tenant: m[2].toLowerCase(), confidence: 'inferred' };
    return { ats: 'dayforce', tenant: null, confidence: 'low' };
  }

  if (o.smartrecruitersHosts.includes(host)) {
    // No prior art in this codebase for SmartRecruiters tenant extraction (spec-adversary amendment S5):
    // ats is certain from the host, tenant stays null until verified against real postings.
    return { ats: 'smartrecruiters', tenant: null, confidence: 'low' };
  }

  if (hostIs(host, o.icimsHostSuffix)) {
    // Same rationale as SmartRecruiters (S5): *.icims.com covers the careers-<x>/jobs-<x> prefix shapes
    // too (hostIs is a suffix match), but tenant extraction ships only after verification.
    return { ats: 'icims', tenant: null, confidence: 'low' };
  }

  if (hostIs(host, o.linkedinHostSuffix)) {
    // Classify-only (spec item 8 / amendment S9): LinkedIn Easy Apply is deliberately never automated,
    // so 'exact' here means "certainly LinkedIn", not "certainly automatable".
    if (/^\/jobs\/view\//i.test(u.pathname) || u.searchParams.has('currentJobId')) {
      return { ats: 'linkedin_easy', tenant: null, confidence: 'exact' };
    }
    return { ...UNKNOWN };
  }

  if (hostIs(host, o.indeedHostSuffix)) {
    // Classify-only, same rationale as LinkedIn above.
    if (host === 'apply.indeed.com' || (/^\/viewjob/i.test(u.pathname) && u.searchParams.has('jk'))) {
      return { ats: 'indeed_easy', tenant: null, confidence: 'exact' };
    }
    return { ...UNKNOWN };
  }

  // Not a registered ATS host directly. Two weaker, URL/page-content signals remain before giving up
  // (S6/S7), checked in this order: a single unambiguous Greenhouse iframe embed on the page, then a
  // bare gh_jid query param on the page's own URL.
  if (html) {
    const tenants = collectGreenhouseIframeTenants(html, o.greenhouseHosts);
    if (tenants.size === 1) return { ats: 'greenhouse', tenant: [...tenants][0], confidence: 'inferred' };
    // Two or more distinct tenants on one page: an aggregator/multi-posting page. Never first-match-wins.
    if (tenants.size >= 2) return { ...UNKNOWN };
  }

  const ghJid = u.searchParams.get('gh_jid');
  if (ghJid && GH_JID_RE.test(ghJid)) {
    // The id alone does not name a tenant, and the current host is not a registered Greenhouse board
    // host, so there is nothing to qualify it against (mirrors normalize.js's identical branch for the
    // same case, which also cannot produce a canonical URL without a known board).
    return { ats: 'greenhouse', tenant: null, confidence: 'low' };
  }

  return { ...UNKNOWN };
}
