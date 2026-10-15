// @ts-check
/**
 * Target finder network guard (plan 14.6 as amended by 15.2 item 7). The ONLY fetch path in
 * src/targets/. It exposes get() and nothing else: there is no method parameter, no body parameter, and
 * no way to ask for another verb, so no other verb can be requested through it.
 *
 * Rules, all enforced BEFORE any I/O (a violation throws FetchRefused and records the host, not the URL):
 *   - https only, host must equal a TARGET_FETCH_HOSTS entry exactly (no wildcards), no credentials in the
 *     URL, default port only
 *   - redirects: 'error' mode (Gmail) lets the platform fetch refuse them; 'manual' mode follows at most
 *     maxRedirects hops, re-validating EVERY hop against the registry and recomputing the headers per host
 *     (so Authorization and the SEC User-Agent are stripped structurally on a host change)
 *   - the SEC User-Agent is attached only to sec.gov registry hosts; the bearer token only to
 *     gmail.googleapis.com; a SEC host with no configured User-Agent is refused (never an anonymous call)
 *   - a global request counter (every attempt, every hop) with a hard cap
 *   - a per-request timeout, a body byte cap, and a capped Retry-After
 *
 * Documented exception: the Gmail OAuth token REFRESH (a call to the Google token endpoint) happens inside
 * google-auth-library via src/core/google.js and src/adapters/gmail.js `deps`, not through this guard.
 * Nothing in src/targets/ issues it directly.
 */

export const SEC_FETCH_HOSTS = Object.freeze(['efts.sec.gov', 'data.sec.gov', 'www.sec.gov']);
export const GMAIL_FETCH_HOST = 'gmail.googleapis.com';
export const TARGET_FETCH_HOSTS = Object.freeze([...SEC_FETCH_HOSTS, GMAIL_FETCH_HOST]);

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REQUESTS = 400;
export const DEFAULT_MAX_REDIRECTS = 2;
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

export class FetchRefused extends Error {
  /**
   * @param {string} reason closed code: scheme|host|credentials|port|url_invalid|request_cap|sec_contact_missing|redirect_limit|redirect_invalid|redirect_unexpected
   * @param {string|null} host
   */
  constructor(reason, host = null) {
    super(`fetch refused: ${reason}${host ? ` (${host})` : ''}`);
    this.name = 'FetchRefused';
    this.reason = reason;
    this.host = host;
  }
}

/**
 * @typedef {Object} GuardResponse
 * @property {number} status
 * @property {string} text body decoded as UTF-8, cut at maxBytes
 * @property {boolean} truncated the body was longer than maxBytes
 * @property {string} host final host
 * @property {number} redirects hops followed
 * @property {number|null} retryAfterMs capped Retry-After, when the response carried one
 */

/**
 * Parse Retry-After (delta-seconds or HTTP date) to a capped delay.
 * @param {string|null|undefined} value
 * @param {number} capMs
 * @param {number} [nowMs]
 * @returns {number|null}
 */
export function parseRetryAfter(value, capMs, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  let ms = null;
  if (/^\d{1,9}$/.test(v)) ms = Number(v) * 1000;
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) ms = Math.max(0, t - nowMs);
  }
  if (ms === null) return null;
  return Math.min(ms, capMs);
}

/**
 * @param {Object} opts
 * @param {typeof fetch} opts.fetch injected so tests replay recorded fixtures
 * @param {string|null} [opts.userAgent] SEC contact User-Agent; sent to sec.gov hosts only
 * @param {readonly string[]} [opts.hosts]
 * @param {number} [opts.maxRequests]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBodyBytes]
 * @param {number} [opts.maxRedirects]
 * @param {number} [opts.maxRetryAfterMs]
 * @param {() => number} [opts.now]
 */
export function createFetchGuard(opts) {
  const fetchImpl = opts.fetch;
  const hosts = new Set(opts.hosts ?? TARGET_FETCH_HOSTS);
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const retryCap = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const now = opts.now ?? Date.now;
  const userAgent = typeof opts.userAgent === 'string' && opts.userAgent.trim() ? opts.userAgent.trim() : null;
  let requestCount = 0;

  /**
   * Validate a URL against the registry. Throws FetchRefused; returns the parsed URL.
   * @param {string} raw
   * @returns {URL}
   */
  function validate(raw) {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      throw new FetchRefused('url_invalid');
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:') throw new FetchRefused('scheme', host);
    if (u.username || u.password) throw new FetchRefused('credentials', host);
    if (u.port !== '') throw new FetchRefused('port', host);
    if (!hosts.has(host)) throw new FetchRefused('host', host);
    return u;
  }

  /**
   * Headers are recomputed from scratch for every hop and host.
   * @param {URL} u
   * @param {{ bearer?: string|null, accept?: string }} o
   * @returns {Record<string, string>}
   */
  function headersFor(u, o) {
    const host = u.hostname.toLowerCase();
    /** @type {Record<string, string>} */
    const h = { Accept: o.accept ?? '*/*' };
    if (SEC_FETCH_HOSTS.includes(host)) {
      if (!userAgent) throw new FetchRefused('sec_contact_missing', host);
      h['User-Agent'] = userAgent;
    }
    if (host === GMAIL_FETCH_HOST && o.bearer) h.Authorization = `Bearer ${o.bearer}`;
    return h;
  }

  /**
   * @param {Response} res
   * @param {number} maxBytes
   * @returns {Promise<{ text: string, truncated: boolean }>}
   */
  async function readBody(res, maxBytes) {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let truncated = false;
    const body = /** @type {any} */ (res).body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = maxBytes - total;
        if (value.length > room) {
          if (room > 0) chunks.push(value.subarray(0, room));
          total = maxBytes;
          truncated = true;
          try { await reader.cancel(); } catch { /* best effort */ }
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    } else if (typeof res.arrayBuffer === 'function') {
      const buf = new Uint8Array(await res.arrayBuffer());
      truncated = buf.length > maxBytes;
      chunks.push(truncated ? buf.subarray(0, maxBytes) : buf);
    } else if (typeof res.text === 'function') {
      const t = Buffer.from(await res.text(), 'utf8');
      truncated = t.length > maxBytes;
      chunks.push(truncated ? t.subarray(0, maxBytes) : t);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }

  /**
   * GET one URL (the only verb this module has).
   * @param {string} url
   * @param {{ bearer?: string|null, accept?: string, maxBytes?: number, timeoutMs?: number, redirect?: 'manual'|'error' }} [o]
   * @returns {Promise<GuardResponse>}
   */
  async function get(url, o = {}) {
    const redirectMode = o.redirect === 'error' ? 'error' : 'manual';
    const maxBytes = o.maxBytes ?? defaultMaxBytes;
    const timeoutMs = o.timeoutMs ?? defaultTimeout;
    let u = validate(url);
    let hops = 0;
    for (;;) {
      if (requestCount >= maxRequests) throw new FetchRefused('request_cap', u.hostname.toLowerCase());
      const headers = headersFor(u, o);
      requestCount += 1;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      let parsed;
      try {
        res = await fetchImpl(u.toString(), { method: 'GET', headers, redirect: redirectMode, signal: ctrl.signal });
        const status = res.status;
        const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
        const retryAfterMs = parseRetryAfter(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null, retryCap, now());
        if (status >= 300 && status < 400 && location) {
          if (redirectMode === 'error') throw new FetchRefused('redirect_unexpected', u.hostname.toLowerCase());
          if (hops >= maxRedirects) throw new FetchRefused('redirect_limit', u.hostname.toLowerCase());
          let next;
          try {
            next = new URL(location, u);
          } catch {
            throw new FetchRefused('redirect_invalid', u.hostname.toLowerCase());
          }
          u = validate(next.toString());
          hops += 1;
          continue;
        }
        parsed = { status, retryAfterMs, ...(await readBody(res, maxBytes)) };
      } finally {
        clearTimeout(timer);
      }
      return { status: parsed.status, text: parsed.text, truncated: parsed.truncated, host: u.hostname.toLowerCase(), redirects: hops, retryAfterMs: parsed.retryAfterMs };
    }
  }

  return {
    get,
    validate,
    get requestCount() { return requestCount; },
    maxRequests,
    hosts: [...hosts],
  };
}

/** @typedef {ReturnType<typeof createFetchGuard>} FetchGuard */
