// @ts-check
/**
 * URL guard (spec section 4): the single chokepoint for every outbound
 * `fetch` and browser `goto`.
 *
 * TOTAL classification. A URL is allowed only by positive match to a
 * registered adapter domain AND one of that adapter's pathPatterns. Every
 * other input, including "unknown" and "could not resolve", is refused.
 * There is no allow-list of exceptions; there is only the registry.
 *
 * Checks, in order:
 *   1. parseable URL
 *   2. no embedded credentials
 *   3. scheme https (http only for hosts in the empty-by-default httpAllowedHosts list)
 *   4. host is not an IP literal, not localhost/.local/.localhost/.internal/.home.arpa
 *   5. host belongs to exactly one registered adapter (suffix match on domains[])
 *   6. path + query matches one of that adapter's pathPatterns
 *   7. (async) DNS resolves and every address is public: no loopback, private,
 *      link-local, CGNAT, multicast, reserved, unique-local, or v4-mapped private
 *   8. after every redirect, steps 1-7 run again on the Location target
 *   9. the final post-redirect path must match the adapter's pathPatterns
 *
 * Nothing here imports playwright. Callers pass a `fetch` and `lookup`
 * implementation so tests can stub the network.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { JobSearchError } from './errors.js';

/** Non-GET methods are refused unless the (source, path) pair is listed here. */
export const POST_ALLOWED = Object.freeze([
  { source: 'linkedin', pattern: /^\/voyager\/api\/(voyagerJobsDashJobSearch|graphql)$/ },
  { source: 'workday', pattern: /^\/wday\/cxs\/[a-z0-9_-]+\/[a-z0-9_-]+\/jobs$/i },
]);

export const MAX_REDIRECTS = 5;

/**
 * @typedef {Object} RegistryEntry
 * @property {string} source adapter name (indeed, linkedin, greenhouse, ..., exec:<slug>)
 * @property {string[]} domains bare hostnames; a URL host matches when equal or a subdomain
 * @property {RegExp[]} pathPatterns tested against pathname + search
 */

/**
 * @typedef {Object} Registry
 * @property {RegistryEntry[]} entries
 * @property {Set<string>} httpAllowedHosts
 */

/**
 * Build the registry from the loaded config (adapters.json + exec-boards.json).
 * Exec boards get one entry each (`exec:<slug>`) so a board's domain only
 * admits that board's path patterns.
 * @param {import('./config.js').LoadedConfig} cfg
 * @returns {Registry}
 */
export function buildRegistry(cfg) {
  /** @type {RegistryEntry[]} */
  const entries = [];
  for (const [name, a] of Object.entries(cfg.adapters.adapters)) {
    if (a.domains.length === 0) continue;
    entries.push({ source: name, domains: a.domains.map((d) => d.toLowerCase()), pathPatterns: a.pathPatterns.map((p) => new RegExp(p)) });
  }
  for (const b of cfg.execBoards.boards) {
    entries.push({ source: `exec:${b.slug}`, domains: b.domains.map((d) => d.toLowerCase()), pathPatterns: b.pathPatterns.map((p) => new RegExp(p)) });
  }
  return { entries, httpAllowedHosts: new Set(cfg.adapters.httpAllowedHosts.map((h) => h.toLowerCase())) };
}

/**
 * Build a registry from plain data (tests, ad hoc).
 * @param {Array<{ source: string, domains: string[], pathPatterns: string[] }>} list
 * @param {string[]} [httpAllowedHosts]
 * @returns {Registry}
 */
export function registryFrom(list, httpAllowedHosts = []) {
  return {
    entries: list.map((e) => ({ source: e.source, domains: e.domains.map((d) => d.toLowerCase()), pathPatterns: e.pathPatterns.map((p) => new RegExp(p)) })),
    httpAllowedHosts: new Set(httpAllowedHosts.map((h) => h.toLowerCase())),
  };
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** @param {string} ip dotted quad */
function v4Octets(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/**
 * True when an IPv4 address is NOT globally routable (loopback, private,
 * link-local, CGNAT, multicast, reserved, this-network, broadcast).
 * @param {string} ip
 */
export function isPrivateV4(ip) {
  const o = v4Octets(ip);
  if (!o) return true; // unparseable: refuse
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && o[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand an IPv6 address to 8 hextets (numbers). Returns null when invalid.
 * Handles the embedded-v4 tail (::ffff:1.2.3.4).
 * @param {string} ip
 */
export function expandV6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded IPv4 tail
  const v4tail = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4tail) {
    const o = v4Octets(v4tail[1]);
    if (!o) return null;
    s = s.slice(0, s.length - v4tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const zeros = halves.length === 2 ? Array.from({ length: missing }, () => '0') : [];
  const parts = [...head, ...zeros, ...tail];
  const out = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

/**
 * True when an IPv6 address is NOT globally routable.
 * @param {string} ip
 */
export function isPrivateV6(ip) {
  const h = expandV6(ip);
  if (!h) return true;
  const allZeroPrefix = h.slice(0, 5).every((x) => x === 0);
  if (h.every((x) => x === 0)) return true; // ::
  if (allZeroPrefix && h[5] === 0 && h[6] === 0 && h[7] === 1) return true; // ::1
  if (allZeroPrefix && h[5] === 0xffff) {
    // ::ffff:a.b.c.d v4-mapped
    return isPrivateV4(`${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`);
  }
  if (allZeroPrefix && h[5] === 0) {
    // ::a.b.c.d v4-compatible (deprecated): refuse
    return true;
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64: refuse, cannot see the v4 policy
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2001 && h[1] === 0) return true; // teredo: refuse
  if (h[0] === 0x2002) return true; // 6to4: refuse
  return false;
}

/**
 * Classify one resolved address. Total: every string maps to public | private | invalid.
 * @param {string} ip
 * @returns {'public'|'private'|'invalid'}
 */
export function classifyAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateV4(ip) ? 'private' : 'public';
  if (fam === 6) return isPrivateV6(ip) ? 'private' : 'public';
  return 'invalid';
}

const FORBIDDEN_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.localdomain', '.lan', '.onion'];

/**
 * @param {string} host lowercase
 * @returns {string|null} reason when the host name itself is refused
 */
export function hostNameProblem(host) {
  if (!host) return 'empty_host';
  if (host === 'localhost') return 'localhost';
  if (host.startsWith('[') || net.isIP(host) !== 0) return 'ip_literal';
  for (const s of FORBIDDEN_HOST_SUFFIXES) if (host.endsWith(s)) return 'forbidden_suffix';
  if (!/^[a-z0-9.-]+$/.test(host)) return 'bad_host_chars';
  if (host.endsWith('.')) return 'trailing_dot';
  return null;
}

/**
 * Dot-boundary host suffix match: exact match or a `.`-delimited subdomain, never a bare substring match
 * (so `greenhouse.io.example.com` never matches `greenhouse.io`). Exported (apply pipeline slice 5) so
 * src/browser/session.js's apply-mode route policy reuses this exact function rather than re-implementing
 * its own suffix-matching logic -- the amended spec's explicit instruction ("Reuse urlguard's hostMatches
 * for all host comparisons; no new suffix-matching code").
 * @param {string} host
 * @param {string} domain
 */
export function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

// ---------------------------------------------------------------------------
// Synchronous classification
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} UrlVerdict
 * @property {boolean} allowed
 * @property {string} reason 'ok' or the refusal branch
 * @property {string|null} source registry source when matched
 * @property {URL|null} url parsed URL when parseable
 */

/**
 * Synchronous part of the guard (steps 1-6). Never throws.
 * @param {string} input
 * @param {Registry} registry
 * @param {{ method?: string, source?: string }} [opts] when `source` is given the URL must belong to that adapter
 * @returns {UrlVerdict}
 */
export function classifyUrl(input, registry, opts = {}) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { allowed: false, reason: 'invalid_url', source: null, url: null };
  }
  if (url.username || url.password) return { allowed: false, reason: 'credentials_in_url', source: null, url };
  const host = url.hostname.toLowerCase();
  const hostProblem = hostNameProblem(host);
  if (hostProblem) return { allowed: false, reason: `host_${hostProblem}`, source: null, url };
  if (url.protocol === 'http:') {
    if (!registry.httpAllowedHosts.has(host)) return { allowed: false, reason: 'scheme_not_https', source: null, url };
  } else if (url.protocol !== 'https:') {
    return { allowed: false, reason: 'scheme_not_https', source: null, url };
  }
  // Only the scheme's default port: a registered host on an arbitrary port is a different service.
  if (url.port !== '') return { allowed: false, reason: 'nonstandard_port', source: null, url };
  const candidates = registry.entries.filter((e) => e.domains.some((d) => hostMatches(host, d)));
  if (candidates.length === 0) return { allowed: false, reason: 'host_not_registered', source: null, url };
  const scoped = opts.source ? candidates.filter((e) => e.source === opts.source) : candidates;
  if (scoped.length === 0) return { allowed: false, reason: 'host_belongs_to_other_source', source: candidates[0].source, url };
  const target = url.pathname + url.search;
  const match = scoped.find((e) => e.pathPatterns.some((re) => re.test(target)));
  if (!match) return { allowed: false, reason: 'path_not_matching', source: scoped[0].source, url };
  const method = String(opts.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    if (method !== 'POST') return { allowed: false, reason: 'method_not_allowed', source: match.source, url };
    const ok = POST_ALLOWED.some((p) => p.source === match.source && p.pattern.test(url.pathname));
    if (!ok) return { allowed: false, reason: 'post_not_allowed_for_path', source: match.source, url };
  }
  return { allowed: true, reason: 'ok', source: match.source, url };
}

// ---------------------------------------------------------------------------
// Asynchronous resolution
// ---------------------------------------------------------------------------

/**
 * @typedef {(host: string) => Promise<Array<{ address: string, family: number }>>} Lookup
 */

/** Default DNS lookup: all addresses, no verbatim reordering games. */
export const defaultLookup = /** @type {Lookup} */ (async (host) => dns.lookup(host, { all: true, verbatim: true }));

/**
 * Resolve the host and require every address to be public. Total: any
 * failure to resolve, empty answer, or one private address refuses.
 * @param {string} host
 * @param {Lookup} [lookup]
 * @returns {Promise<{ ok: boolean, reason: string, addresses: number }>}
 */
export async function checkResolvedAddresses(host, lookup = defaultLookup) {
  let answers;
  try {
    answers = await lookup(host);
  } catch {
    return { ok: false, reason: 'dns_failed', addresses: 0 };
  }
  if (!answers || answers.length === 0) return { ok: false, reason: 'dns_empty', addresses: 0 };
  for (const a of answers) {
    const cls = classifyAddress(String(a.address));
    if (cls !== 'public') return { ok: false, reason: `address_${cls}`, addresses: answers.length };
  }
  return { ok: true, reason: 'ok', addresses: answers.length };
}

/**
 * Full guard: sync classification then DNS. Throws URL_REJECTED on refusal.
 * @param {string} input
 * @param {Registry} registry
 * @param {{ method?: string, source?: string, lookup?: Lookup }} [opts]
 * @returns {Promise<{ url: URL, source: string }>}
 */
export async function guardUrl(input, registry, opts = {}) {
  const v = classifyUrl(input, registry, { method: opts.method, source: opts.source });
  if (!v.allowed || !v.url || !v.source) {
    throw new JobSearchError('URL_REJECTED', `url refused: ${v.reason}`, { details: { reason: v.reason, host: v.url ? v.url.hostname : null } });
  }
  const r = await checkResolvedAddresses(v.url.hostname.toLowerCase(), opts.lookup);
  if (!r.ok) throw new JobSearchError('URL_REJECTED', `url refused: ${r.reason}`, { details: { reason: r.reason, host: v.url.hostname } });
  return { url: v.url, source: v.source };
}

/**
 * Guarded fetch with manual redirect handling: every hop is re-classified and
 * re-resolved; the final URL must match the adapter's pathPatterns. Only the
 * fields the caller needs are returned (never the raw Response object's
 * headers as a whole).
 * @param {string} input
 * @param {Registry} registry
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, source?: string, fetch?: typeof fetch, lookup?: Lookup, signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, url: string, hops: number, text: string, contentType: string|null, retryAfter: string|null, cfMitigated: string|null }>}
 */
export async function guardedFetch(input, registry, opts = {}) {
  const f = opts.fetch ?? fetch;
  let current = String(input);
  let method = String(opts.method ?? 'GET').toUpperCase();
  let body = opts.body;
  let source = opts.source;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const g = await guardUrl(current, registry, { method, source, lookup: opts.lookup });
    source = source ?? g.source;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        throw new JobSearchError('INTERNAL', 'aborted');
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    let res;
    try {
      res = await f(g.url.toString(), { method, headers: opts.headers ?? {}, body: method === 'POST' ? body : undefined, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new JobSearchError('URL_REJECTED', 'redirect without location', { details: { reason: 'redirect_no_location' } });
      current = new URL(loc, g.url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    // Final URL must match the adapter's patterns (already guaranteed by guardUrl on this hop).
    const text = await res.text();
    return {
      status: res.status,
      url: g.url.toString(),
      hops: hop,
      text,
      contentType: res.headers.get('content-type'),
      retryAfter: res.headers.get('retry-after'),
      cfMitigated: res.headers.get('cf-mitigated'),
    };
  }
  throw new JobSearchError('URL_REJECTED', 'too many redirects', { details: { reason: 'too_many_redirects' } });
}
