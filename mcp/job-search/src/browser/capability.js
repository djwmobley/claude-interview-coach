// @ts-check
/**
 * Frozen read-only capability object handed to browser adapters (spec
 * section 1). Adapters never see the page, context, or browser; they get
 * exactly these four operations plus `signal`:
 *
 *   goto(url)                navigate through the URL guard; returns scalars
 *   readHtml()               page HTML (never logged by callers)
 *   readJson(extractorName, arg?)  run a NAMED extractor from extractors.js
 *   scrollToBottom(maxSteps) scroll the rendered list, bounded
 *
 * There is no way to submit, fill, or dispatch anything through this object.
 */
import { EXTRACTORS } from './extractors.js';
import { guardUrl, classifyUrl } from '../core/urlguard.js';
import { JobSearchError } from '../core/errors.js';
import { PAGE_MARKER } from './session.js';

/**
 * @typedef {Object} Capability
 * @property {(url: string) => Promise<{ status: number|null, url: string, cfMitigated: string|null }>} goto
 * @property {() => Promise<string>} readHtml
 * @property {(name: string, arg?: unknown) => Promise<unknown>} readJson
 * @property {(maxSteps?: number) => Promise<{ steps: number, atBottom: boolean }>} scrollToBottom
 * @property {(url: string, opts?: { headers?: Record<string, string> }) => Promise<FetchAuthedJsonResult>} fetchAuthedJson
 * @property {AbortSignal} signal
 * @property {string} source
 */

/**
 * @typedef {Object} FetchAuthedJsonResult
 * @property {'valid'|'missing'|'malformed'|'refused'} cookieState 'refused' means the URL itself never
 *   passed the urlguard precheck (no network call and no cookie read were ever attempted)
 * @property {string|null} [refusedReason] classifyUrl()'s own reason, only set when cookieState is 'refused'
 * @property {number|null} status HTTP status, or null when refused/no valid cookie/network failure
 * @property {boolean} ok
 * @property {any} json parsed JSON body, or null when absent/unparseable/not attempted
 */

/**
 * Reads one named cookie via the BROWSER CONTEXT's own cookie jar (Playwright's `context.cookies(urls)`,
 * never `document.cookie` / an in-page read, and never handed to an adapter directly) and classifies it
 * total: 'missing' (absent, or the context/cookie read itself failed), 'malformed' (present but empty
 * once LinkedIn's own surrounding double-quotes are stripped, or containing a character outside a
 * conservative bare-token charset), 'valid' otherwise. Filtering by `forUrl` (rather than reading every
 * cookie in the context) is deliberate and load-bearing: a context-level cookie jar holds the session
 * regardless of which document the PAGE currently has loaded (a fresh tab can be on about:blank and still
 * have a valid LinkedIn session cookie), so this must never depend on the page's current origin.
 * @param {import('playwright-core').Page} page
 * @param {string} name
 * @param {string} forUrl
 * @returns {Promise<{ state: 'valid'|'missing'|'malformed', value: string|null }>}
 */
async function readCookieState(page, name, forUrl) {
  /** @type {any[]} */
  let cookies;
  try {
    cookies = await page.context().cookies(forUrl);
  } catch {
    return { state: 'missing', value: null };
  }
  const c = Array.isArray(cookies) ? cookies.find((k) => k && k.name === name) : null;
  if (!c || typeof c.value !== 'string') return { state: 'missing', value: null };
  const stripped = c.value.replace(/^"|"$/g, '');
  // LinkedIn's own JSESSIONID value is shaped like "ajax:1234567890123456789" (a colon-separated prefix
  // then digits), so the conservative token charset below allows ':' alongside the usual bare-token set.
  if (!stripped || !/^[A-Za-z0-9_:-]+$/.test(stripped)) return { state: 'malformed', value: null };
  return { state: 'valid', value: stripped };
}

/**
 * @param {import('playwright-core').Page} page attached by session.attachPage
 * @param {{ registry: import('../core/urlguard.js').Registry, source: string, signal: AbortSignal, lookup?: import('../core/urlguard.js').Lookup, onPage?: () => Promise<void> }} opts
 * @returns {Capability}
 */
export function makeCapability(page, opts) {
  const { registry, source, signal } = opts;
  const checkAbort = () => {
    if (signal.aborted) throw new JobSearchError('INTERNAL', 'run aborted', { details: { source } });
  };
  /** @type {Capability} */
  const cap = {
    source,
    signal,
    async goto(url) {
      checkAbort();
      const g = await guardUrl(url, registry, { source, lookup: opts.lookup });
      if (opts.onPage) await opts.onPage();
      // Fragment marker lets session.reconcile() recognize our pages after a crash without reading content.
      const target = new URL(g.url.toString());
      target.hash = PAGE_MARKER;
      const res = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      checkAbort();
      // Re-check the landing URL after any navigation-time redirect.
      const finalUrl = page.url();
      await guardUrl(finalUrl, registry, { source, lookup: opts.lookup });
      const cf = res ? res.headers()['cf-mitigated'] ?? null : null;
      return { status: res ? res.status() : null, url: finalUrl.split('?')[0], cfMitigated: cf };
    },
    async readHtml() {
      checkAbort();
      return page.content();
    },
    async readJson(name, arg) {
      checkAbort();
      const fn = /** @type {Record<string, Function>} */ (EXTRACTORS)[name];
      if (typeof fn !== 'function' || !Object.prototype.hasOwnProperty.call(EXTRACTORS, name)) {
        throw new JobSearchError('VALIDATION', `unknown extractor: ${String(name).slice(0, 40)}`);
      }
      // Only named, module-owned functions reach page.evaluate; `arg` must be serializable.
      const body = /** @type {any} */ (fn);
      const payload = arg === undefined ? null : JSON.parse(JSON.stringify(arg));
      return page.evaluate(body, payload);
    },
    /**
     * Authed JSON fetch via the browser context's own cookie jar (item 6a, hardened by the item-6
     * follow-up fix: the logged-in LinkedIn voyager API, generalized for any adapter that needs one).
     * Precheck is the SAME sync urlguard classification every other capability method's navigation goes
     * through (classifyUrl, not the full async guardUrl: the DNS-resolution step guardUrl adds is not
     * meaningful for a target on a host this same capability is already connected to) -- a URL outside
     * the registry is refused before any cookie is even read.
     *
     * Deliberately NOT implemented as an in-page `fetch()` via page.evaluate (the item 6 original design):
     * that runs as same-origin-or-not from the PAGE's current document, so a fresh tab on about:blank (or
     * any page not already on this host) has the request blocked by the browser's own cross-origin
     * policy regardless of how valid the session cookie is. A real top-level navigation (page.goto) is
     * not subject to that restriction -- it behaves exactly like a user following a link -- and the
     * browser attaches whatever cookies the CONTEXT holds for the destination host automatically, so this
     * works identically whether the page was already on linkedin.com or on about:blank. This is the
     * "equivalent that does not depend on the current page origin" alternative to Playwright's
     * page.request/context.request, which stay off-limits for this file (test/safety.test.js's forbidden
     * call-surface list; that surface is reserved for src/apply/'s own reviewed, write-capable module).
     * Custom headers ride along via page.setExtraHTTPHeaders(), scoped to just this one navigation and
     * reset in a finally block so no later, unrelated navigation on this page ever inherits them.
     * @param {string} url
     * @param {{ headers?: Record<string, string> }} [opts]
     * @returns {Promise<FetchAuthedJsonResult>}
     */
    async fetchAuthedJson(url, opts = {}) {
      checkAbort();
      const v = classifyUrl(url, registry, { source, method: 'GET' });
      if (!v.allowed || !v.url) {
        return { cookieState: 'refused', refusedReason: v.reason, status: null, ok: false, json: null };
      }
      const { state, value } = await readCookieState(page, 'JSESSIONID', v.url.origin);
      if (state !== 'valid' || !value) {
        return { cookieState: state, status: null, ok: false, json: null };
      }
      const headers = { ...(opts.headers ?? {}), 'csrf-token': value };
      /** @type {any} */
      let res = null;
      try {
        await page.setExtraHTTPHeaders(headers);
        res = await page.goto(v.url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch {
        res = null;
      } finally {
        try {
          await page.setExtraHTTPHeaders({});
        } catch {
          // best-effort reset; a page/context already gone by this point has nothing left to pollute
        }
      }
      checkAbort();
      if (!res) return { cookieState: 'valid', status: null, ok: false, json: null };
      const status = res.status();
      const ok = res.ok();
      /** @type {string|null} */
      let text = null;
      try {
        text = await res.text();
      } catch {
        text = null;
      }
      /** @type {any} */
      let json = null;
      if (typeof text === 'string' && text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { cookieState: 'valid', status, ok, json };
    },
    async scrollToBottom(maxSteps = 8) {
      let steps = 0;
      let atBottom = false;
      for (let i = 0; i < Math.min(20, Math.max(1, maxSteps)); i++) {
        checkAbort();
        const scrollBody = /** @type {any} */ (EXTRACTORS.scrollStep);
        const r = /** @type {{ before: number, after: number, atBottom: boolean }} */ (await page.evaluate(scrollBody));
        steps++;
        atBottom = r.atBottom;
        if (atBottom && r.after === r.before) break;
        await page.waitForTimeout(400 + Math.floor(Math.random() * 400));
      }
      return { steps, atBottom };
    },
  };
  return Object.freeze(cap);
}
