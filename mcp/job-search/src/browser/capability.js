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
 * Self-contained page.evaluate body for fetchAuthedJson (browser/capability.js only -- never exposed
 * through extractors.js's readJson registry, which is documented as read-only DOM extraction; this one
 * performs a network request). Runs the fetch INSIDE the page's own JS context so the browser's real
 * cookie jar (JSESSIONID etc.) is attached automatically for a same-origin request, exactly like a normal
 * page navigation would send it -- capability.js only has to add the explicit csrf-token header, never
 * the session cookie itself. Must stay a plain, self-contained function (no closures over module state):
 * Playwright serializes it to a string and evaluates it literally in the browser.
 * @param {{ url: string, headers: Record<string, string> }} arg
 */
function fetchJsonInPage(arg) {
  return fetch(arg.url, { method: 'GET', headers: arg.headers, credentials: 'include' }).then(
    (res) => res.text().then((text) => ({ status: res.status, ok: res.ok, text })),
    () => ({ status: null, ok: false, text: null }),
  );
}

/**
 * Reads one named cookie via the page's own browser-context cookie jar (never handed to an adapter
 * directly) and classifies it total: 'missing' (absent, or the context/cookie read itself failed),
 * 'malformed' (present but empty once LinkedIn's own surrounding double-quotes are stripped, or containing
 * a character outside a conservative bare-token charset), 'valid' otherwise.
 * @param {import('playwright-core').Page} page
 * @param {string} name
 * @returns {Promise<{ state: 'valid'|'missing'|'malformed', value: string|null }>}
 */
async function readCookieState(page, name) {
  /** @type {any[]} */
  let cookies;
  try {
    cookies = await page.context().cookies();
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
     * Authed JSON fetch inside the page's own context (item 6a: the logged-in LinkedIn voyager API,
     * generalized for any adapter that needs one). Precheck is the SAME sync urlguard classification
     * every other capability method's navigation goes through (classifyUrl, not the full async guardUrl:
     * this call never navigates the page or leaves the already-connected site, so the DNS-resolution
     * step guardUrl adds for a fresh navigation target is not meaningful here) -- a URL outside the
     * registry is refused before any cookie is even read.
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
      const { state, value } = await readCookieState(page, 'JSESSIONID');
      if (state !== 'valid' || !value) {
        return { cookieState: state, status: null, ok: false, json: null };
      }
      const headers = { ...(opts.headers ?? {}), 'csrf-token': value };
      const r = await page.evaluate(fetchJsonInPage, { url: v.url.toString(), headers });
      checkAbort();
      /** @type {any} */
      let json = null;
      if (typeof r.text === 'string' && r.text) {
        try {
          json = JSON.parse(r.text);
        } catch {
          json = null;
        }
      }
      return { cookieState: 'valid', status: r.status, ok: r.ok, json };
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
