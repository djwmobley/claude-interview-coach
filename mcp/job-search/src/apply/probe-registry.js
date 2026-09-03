// @ts-check
/**
 * Probe registry (auto-apply PR B, docs/auto-apply-spec.md): a SEPARATE, narrower URL guard used only for
 * redirect-chasing an apply target to its final destination during bin/auto-apply.js's prepare phase and
 * bin/probe-apply-link.js. This is deliberately its OWN registry, never a relaxation of
 * src/core/urlguard.js's own registry: urlguard's registry exists to gate what the scan/apply browser is
 * allowed to navigate or POST to for real content fetches, and its pathPatterns intentionally REJECT some
 * ATSs' apply-form paths on purpose (see that module's own doc comment) -- loosening it so a probe could
 * also use it would silently also loosen what a scan/apply run is allowed to do. A probe only ever needs
 * to know "did this redirect land on a public, registered host", never "does this path look like the
 * specific page shape this ATS's list/detail routes are validated against" -- so this registry has NO
 * pathPatterns concept at all: once a host matches, every path on it is allowed.
 *
 * TOTAL classification, same discipline as urlguard.js: a public HTTPS host on the registry's host list
 * is allowed on ANY path; every other host, scheme, malformed URL, or userinfo-embedded credential is
 * refused. Private/loopback/link-local/CGNAT/reserved addresses are refused after DNS resolution by
 * reusing urlguard.js's own hostNameProblem/checkResolvedAddresses verbatim, never a second, divergent
 * re-implementation of the same address classification.
 */
import { hostNameProblem, checkResolvedAddresses, defaultLookup } from '../core/urlguard.js';
import { JobSearchError } from '../core/errors.js';

/** Redirect hop cap (mirrors urlguard.js's MAX_REDIRECTS). A chain needing a 6th hop is refused. */
export const MAX_PROBE_REDIRECTS = 5;

/**
 * @typedef {Object} ProbeRegistry
 * @property {string[]} hosts lowercase bare hostnames; a URL host matches when equal or a subdomain
 */

/**
 * Build a probe registry from a plain host list (tests, bin/probe-apply-link.js's CLI, or
 * buildProbeRegistryFromAtsApply below). Mirrors urlguard.js's registryFrom() naming/shape but carries no
 * pathPatterns at all -- see the module doc comment.
 * @param {string[]} hosts
 * @returns {ProbeRegistry}
 */
export function registryFrom(hosts) {
  return { hosts: (hosts ?? []).map((h) => String(h).toLowerCase()) };
}

/**
 * Build the production probe registry from config/ats-apply.json's own host lists plus the fixed
 * intermediary-host list (src/apply/apply-target.js's INTERMEDIARY_HOSTS) -- every host a redirect chain
 * starting at a known aggregator/intermediary is allowed to pass through or land on. Workday itself has
 * no fixed tenant list (every tenant is `<tenant>.wd<N>.myworkdayjobs.com`), so the bare
 * `myworkdayjobs.com` suffix is registered directly: hostMatches' dot-boundary suffix rule already makes
 * any tenant subdomain match, the same way ats-detect.js's WORKDAY_HOST_RE matches any tenant by regex.
 * @param {import('../core/config.js').LoadedConfig['atsApply']} atsApply
 * @param {readonly string[]} intermediaryHosts
 * @returns {ProbeRegistry}
 */
export function buildProbeRegistryFromAtsApply(atsApply, intermediaryHosts) {
  const hosts = [
    ...atsApply.greenhouse.hosts,
    ...atsApply.lever.hosts,
    ...atsApply.smartrecruiters.hosts,
    atsApply.icims.hostSuffix,
    atsApply.dayforce.hostSuffix,
    'myworkdayjobs.com',
    ...intermediaryHosts,
  ];
  return registryFrom(hosts);
}

/**
 * Dot-boundary host suffix match (identical semantics to urlguard.js's hostMatches / ats-detect.js's
 * hostIs): exact match or a `.`-delimited subdomain, never a bare substring match.
 * @param {string} host
 * @param {string} domain
 */
function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * Synchronous classification, never throws:
 *   1. parseable URL, https only (no httpAllowedHosts escape hatch here -- a probe target that only
 *      answers on http is refused, same as every other apply surface in this codebase)
 *   2. no embedded credentials, standard port only
 *   3. host is not an IP literal, not localhost/.local/.localhost/.internal/.home.arpa/etc (reuses
 *      urlguard's own hostNameProblem)
 *   4. host belongs to the registry -- ANY path is allowed once the host matches (the one deliberate
 *      difference from urlguard.js's classifyUrl, which also gates on pathPatterns)
 * @param {string} input
 * @param {ProbeRegistry} registry
 * @returns {{ allowed: boolean, reason: string, url: URL|null }}
 */
export function classifyProbeUrl(input, registry) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { allowed: false, reason: 'invalid_url', url: null };
  }
  if (url.username || url.password) return { allowed: false, reason: 'credentials_in_url', url };
  if (url.protocol !== 'https:') return { allowed: false, reason: 'scheme_not_https', url };
  if (url.port !== '') return { allowed: false, reason: 'nonstandard_port', url };
  const host = url.hostname.toLowerCase();
  const hostProblem = hostNameProblem(host);
  if (hostProblem) return { allowed: false, reason: `host_${hostProblem}`, url };
  if (!registry.hosts.some((d) => hostMatches(host, d))) return { allowed: false, reason: 'host_not_registered', url };
  return { allowed: true, reason: 'ok', url };
}

/**
 * Full guard: sync classification then DNS (reuses urlguard.js's checkResolvedAddresses verbatim). Throws
 * URL_REJECTED on refusal.
 * @param {string} input
 * @param {ProbeRegistry} registry
 * @param {{ lookup?: import('../core/urlguard.js').Lookup }} [opts]
 * @returns {Promise<{ url: URL }>}
 */
export async function guardProbeUrl(input, registry, opts = {}) {
  const v = classifyProbeUrl(input, registry);
  if (!v.allowed || !v.url) {
    throw new JobSearchError('URL_REJECTED', `probe url refused: ${v.reason}`, { details: { reason: v.reason, host: v.url ? v.url.hostname : null } });
  }
  const r = await checkResolvedAddresses(v.url.hostname.toLowerCase(), opts.lookup ?? defaultLookup);
  if (!r.ok) throw new JobSearchError('URL_REJECTED', `probe url refused: ${r.reason}`, { details: { reason: r.reason, host: v.url.hostname } });
  return { url: v.url };
}

/**
 * Follow HTTP redirects (manual, re-guarded at every hop, capped at MAX_PROBE_REDIRECTS) to the final
 * URL. Never gates on path -- only on host + DNS, per this module's own registry. A non-redirect response
 * (2xx/4xx/5xx) at any hop is the final answer; a redirect with no Location header, or exceeding the hop
 * cap, throws URL_REJECTED.
 * @param {string} input
 * @param {ProbeRegistry} registry
 * @param {{ fetch?: typeof fetch, lookup?: import('../core/urlguard.js').Lookup, timeoutMs?: number }} [opts]
 * @returns {Promise<{ url: string, status: number, hops: number }>}
 */
export async function resolveRedirects(input, registry, opts = {}) {
  const f = opts.fetch ?? fetch;
  let current = String(input);
  for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop++) {
    const g = await guardProbeUrl(current, registry, { lookup: opts.lookup });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
    /** @type {Response} */
    let res;
    try {
      res = await f(g.url.toString(), { method: 'GET', redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new JobSearchError('URL_REJECTED', 'redirect without location', { details: { reason: 'redirect_no_location' } });
      current = new URL(loc, g.url).toString();
      continue;
    }
    return { url: g.url.toString(), status: res.status, hops: hop };
  }
  throw new JobSearchError('URL_REJECTED', 'too many redirects', { details: { reason: 'too_many_redirects' } });
}
