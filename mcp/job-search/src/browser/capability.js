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
import { guardUrl } from '../core/urlguard.js';
import { JobSearchError } from '../core/errors.js';
import { PAGE_MARKER } from './session.js';

/**
 * @typedef {Object} Capability
 * @property {(url: string) => Promise<{ status: number|null, url: string, cfMitigated: string|null }>} goto
 * @property {() => Promise<string>} readHtml
 * @property {(name: string, arg?: unknown) => Promise<unknown>} readJson
 * @property {(maxSteps?: number) => Promise<{ steps: number, atBottom: boolean }>} scrollToBottom
 * @property {AbortSignal} signal
 * @property {string} source
 */

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
