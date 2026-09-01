// @ts-check
/**
 * Frozen apply capability (apply pipeline slice 5, plan section 3 / amended spec). The second frozen
 * capability object (alongside src/browser/capability.js's read-only scan capability): adapters get
 * exactly `{fill, select, click, upload, screenshot, waitFor}` plus `signal` -- there is no way to
 * navigate, read raw HTML, or reach the page/context/browser objects directly through this object.
 *
 * Constructed ONLY by src/apply/worker.js: test/apply-capability-lint.test.js asserts exactly one
 * constructor callsite for makeApplyCapability across src/ (the amended spec's own lint requirement), and
 * a second lint test asserts nothing under src/adapters/ (the SCAN side) ever imports this module.
 *
 * `upload()` resolves its relPath argument through src/core/documents.js's resolveOutputPath -- the exact
 * same safe-path machinery the dashboard's document-linking routes already use -- so an upload source can
 * only ever be a real, existing file under output/. `screenshot()` never accepts or returns a caller-
 * controlled path: it captures the page's own bytes and hands them to src/apply/screenshot.js's write-side
 * confinement helper, which builds the destination path itself.
 */
import { JobSearchError } from '../core/errors.js';
import { resolveOutputPath } from '../core/documents.js';
import { writeApplicationScreenshot } from './screenshot.js';

/**
 * @typedef {Object} ElementInfo
 * @property {string} tagName lowercase
 * @property {string|null} [type] input[type] when present
 * @property {string|null} [name]
 * @property {string|null} [id]
 * @property {string} text innerText/textContent, trimmed, capped
 * @property {string|null} value current value, when the element has one
 * @property {boolean} [required]
 * @property {string[]|null} options option label texts, for a <select>; null otherwise
 */

/**
 * @typedef {Object} ApplyCapability
 * @property {(selector: string, value: string) => Promise<void>} fill
 * @property {(selector: string, value: string) => Promise<void>} select
 * @property {(selector: string) => Promise<void>} click
 * @property {(selector: string, relPath: string) => Promise<string|null>} upload resolves relPath under
 *   output/ and sets it as the file input's value; returns the filename the browser's own file input now
 *   reports (read back from the DOM), or null if the browser did not register a file -- the adapter's own
 *   confirmation that at least the LOCAL half of the upload took, independent of whether the network
 *   request the browser then fires is allowed through by the route policy (see the module doc comment on
 *   the residual blind spot this cannot close).
 * @property {() => Promise<{ relPath: string, absPath: string }>} screenshot
 * @property {(selector: string, opts?: { timeoutMs?: number, state?: 'visible'|'attached', optional?: boolean, all?: boolean }) => Promise<ElementInfo|ElementInfo[]|null>} waitFor
 *   single-match mode (default) waits for and returns one element's shape, or throws UNRECOGNIZED_PAGE on
 *   timeout unless `optional` (then null); `all: true` waits for at least one match then returns every
 *   matching element's shape as an array, or `[]` on timeout -- adapters use this to enumerate an unknown/
 *   variable set of screening-question fields without a separate "list" verb.
 * @property {AbortSignal} signal
 * @property {number} applicationId
 */

/**
 * @param {import('playwright-core').Page} page attached by session.attachPage({mode:'apply', ...})
 * @param {{ signal: AbortSignal, applicationId: number, outputRoot: string }} opts
 * @returns {ApplyCapability}
 */
export function makeApplyCapability(page, opts) {
  const { signal, applicationId, outputRoot } = opts;
  const checkAbort = () => {
    if (signal.aborted) throw new JobSearchError('INTERNAL', 'run aborted', { details: { application_id: applicationId } });
  };

  /** @type {ApplyCapability} */
  const cap = {
    signal,
    applicationId,
    async fill(selector, value) {
      checkAbort();
      await page.fill(selector, String(value ?? ''));
    },
    async select(selector, value) {
      checkAbort();
      await page.selectOption(selector, value);
    },
    async click(selector) {
      checkAbort();
      await page.click(selector);
    },
    async upload(selector, relPath) {
      checkAbort();
      const resolved = resolveOutputPath(outputRoot, relPath);
      if (!resolved.ok) throw new JobSearchError('VALIDATION', `cannot upload: ${resolved.reason}`, { details: { reason: resolved.reason } });
      await page.setInputFiles(selector, resolved.absPath);
      return page.$eval(selector, (/** @type {any} */ el) => (el.files && el.files.length ? el.files[0].name : null));
    },
    async screenshot() {
      checkAbort();
      const buffer = await page.screenshot({ type: 'png' });
      return writeApplicationScreenshot(outputRoot, applicationId, buffer);
    },
    async waitFor(selector, o = {}) {
      checkAbort();
      const timeoutMs = o.timeoutMs ?? 15000;
      const state = o.state ?? 'visible';
      // Self-contained, no closed-over Node values: Playwright serializes this function's own source and
      // re-runs it inside the page, so it is written out in full at each call site below rather than
      // shared via a Node-side reference (a reference would not cross the page boundary) and NEVER via
      // string concatenation into `new Function`/`eval` (which would be a code-injection footgun the
      // moment any interpolated value came from page content).
      if (o.all) {
        try {
          await page.waitForSelector(selector, { timeout: timeoutMs, state });
        } catch {
          return [];
        }
        return page.$$eval(selector, (els) => els.map((/** @type {any} */ el) => ({
          tagName: el.tagName.toLowerCase(),
          type: el.getAttribute ? el.getAttribute('type') : null,
          name: el.getAttribute ? el.getAttribute('name') : null,
          id: el.id || null,
          text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
          value: 'value' in el ? el.value : null,
          required: Boolean(el.hasAttribute && (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true')),
          options: el.tagName === 'SELECT' ? Array.from(el.options).map((/** @type {any} */ opt) => String(opt.textContent).trim()) : null,
        })));
      }
      try {
        await page.waitForSelector(selector, { timeout: timeoutMs, state });
      } catch (err) {
        if (o.optional) return null;
        throw new JobSearchError('UNRECOGNIZED_PAGE', `waitFor timed out: ${String(selector).slice(0, 200)}`, { details: { selector: String(selector).slice(0, 200) } });
      }
      return page.$eval(selector, (el) => ({
        tagName: el.tagName.toLowerCase(),
        type: el.getAttribute ? el.getAttribute('type') : null,
        name: el.getAttribute ? el.getAttribute('name') : null,
        id: el.id || null,
        text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
        value: 'value' in el ? el.value : null,
        required: Boolean(el.hasAttribute && (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true')),
        options: el.tagName === 'SELECT' ? Array.from(/** @type {any} */ (el).options).map((/** @type {any} */ opt) => String(opt.textContent).trim()) : null,
      }));
    },
  };
  return Object.freeze(cap);
}
