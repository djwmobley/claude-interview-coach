// @ts-check
/**
 * Frozen apply capability (apply pipeline slice 5, plan section 3 / amended spec). The second frozen
 * capability object (alongside src/browser/capability.js's read-only scan capability): adapters get
 * exactly `{fill, select, click, upload, screenshot, waitFor}` plus `signal` -- there is no way to
 * navigate, read raw HTML, or reach the page/context/browser objects directly through this object. The
 * unattended submit gate (src/apply/unattended-submit.js) additionally uses `pageState` (a read-only,
 * structured snapshot, never raw HTML) and `clickSingle` (clicks only when exactly one visible, enabled
 * element matches).
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
import crypto from 'node:crypto';
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
 * @property {(req?: PageStateRequest) => Promise<any>} pageState READ-ONLY structured snapshot for the
 *   unattended submit gate (src/apply/submit-gate.js): url, main-frame text, the scope's text and headings,
 *   every input/select/textarea (label, required signals, value, checked, selected option text, file name,
 *   visibility), every button (accessible name sources, data-* attributes, visible, enabled), visible
 *   error/validation elements, one probe per requested selector (the first match's value and its index in
 *   `fields`), the requested extra selectors' visible counts and texts, and each child frame's url and text
 *   (kept separate from the main-frame text so an iframe-only confirmation never counts). Never returns raw
 *   HTML and never changes the page.
 * @property {(selector: string, opts?: { names?: readonly string[]|null }) => Promise<{ clicked: boolean, count: number }>} clickSingle
 *   clicks ONLY when exactly one visible, enabled element matches `selector` (and, when `names` is given,
 *   has a normalized accessible name in that set); otherwise clicks nothing and reports the count.
 * @property {AbortSignal} signal
 * @property {number} applicationId
 */

/**
 * @typedef {Object} PageStateRequest
 * @property {string} [scopeSelector] the form (or Workday applyFlowPage) the audit is scoped to
 * @property {string} [footerSelector] Workday's page footer (its data-* marks count as in scope)
 * @property {string} [submitSelector] the adapter's submit selector, reported as `submitMatches`
 * @property {{ source: string, flags?: string }} [dataDeny] data-* deny pattern for `dataMarked`
 * @property {Array<{ key: string, selector: string }>} [probes]
 * @property {Array<{ key: string, selector: string, nameSelector?: string }>} [extras]
 */

/**
 * In-page snapshot function for pageState(). Self-contained (Playwright serializes its source): no closed-
 * over Node values, never string-built code. Reads only; never dispatches events or changes values.
 * @param {any} req
 */
const PAGE_STATE_FN = (req) => {
  const clip = (/** @type {unknown} */ s, /** @type {number} */ n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const isVisible = (/** @type {Element} */ el) => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return !el.closest('[hidden], [aria-hidden="true"]');
  };
  const textOf = (/** @type {Element|null} */ el) => (el ? clip(/** @type {HTMLElement} */ (el).innerText || el.textContent, 400) : '');
  const labelOf = (/** @type {any} */ el) => {
    const parts = [];
    if (el.labels && el.labels.length) for (const l of Array.from(el.labels)) parts.push(textOf(/** @type {Element} */ (l)));
    const al = el.getAttribute('aria-label');
    if (al) parts.push(clip(al, 400));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\s+/)) { const t = document.getElementById(id); if (t) parts.push(textOf(t)); }
    if (parts.length === 0) {
      const wrap = el.closest('label, fieldset, [data-automation-id^="formField"], .field, .form-group, .application-question, .application--field, [data-field-id], .question-field, [data-testid="question-field"], [data-automation="questionField"]');
      if (wrap) {
        const lg = wrap.querySelector('legend, label, .label, [class*="label" i]');
        parts.push(textOf(lg || wrap));
      }
    }
    if (parts.length === 0 && el.getAttribute('placeholder')) parts.push(clip(el.getAttribute('placeholder'), 200));
    return clip(parts.join(' '), 400);
  };
  const scope = req && typeof req.scopeSelector === 'string' && req.scopeSelector ? document.querySelector(req.scopeSelector) : null;
  const root = scope || document.body || document.documentElement;
  const footer = req && typeof req.footerSelector === 'string' && req.footerSelector ? document.querySelector(req.footerSelector) : null;
  const all = Array.from(root.querySelectorAll('input, select, textarea'));
  const fields = all.filter((el) => {
    const t = (/** @type {any} */ (el).type || '').toLowerCase();
    return !['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(t);
  }).map((el, idx) => {
    const anyEl = /** @type {any} */ (el);
    const tag = el.tagName.toLowerCase();
    const label = labelOf(anyEl);
    const wrapText = textOf(el.closest('label, fieldset, [data-automation-id^="formField"], .field, .form-group, .application-question, .application--field, [data-field-id], .question-field'));
    const asterisk = /\*/.test(label) || /\*/.test(wrapText.slice(0, 200)) || Boolean(el.closest('[data-automation-id^="formField"], .field, .form-group, label')?.querySelector('abbr[title*="required" i], .required, [class*="required" i]'));
    const sel = tag === 'select' ? anyEl.options[anyEl.selectedIndex] : null;
    return {
      idx, tag, type: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (anyEl.type || 'text').toLowerCase(),
      id: anyEl.id || '', name: anyEl.getAttribute('name') || '', label,
      required: Boolean(anyEl.required), ariaRequired: el.getAttribute('aria-required'), asterisk,
      optionalMarker: /\boptional\b/i.test(label), ariaInvalid: el.getAttribute('aria-invalid') === 'true',
      value: tag === 'select' || tag === 'textarea' || anyEl.type !== 'file' ? String(anyEl.value ?? '').slice(0, 4000) : '',
      checked: Boolean(anyEl.checked), selectedText: sel ? clip(sel.textContent, 400) : '',
      fileName: anyEl.type === 'file' && anyEl.files && anyEl.files.length ? String(anyEl.files[0].name) : '',
      visible: isVisible(el) || Boolean(anyEl.labels && Array.from(anyEl.labels).some((l) => isVisible(/** @type {Element} */ (l)))),
      disabled: Boolean(anyEl.disabled) || el.getAttribute('aria-disabled') === 'true',
      automationId: el.getAttribute('data-automation-id') || '',
      el,
    };
  });
  const dataAttrsOf = (/** @type {Element} */ el) => Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, clip(a.value, 200)]);
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')).map((el) => {
    const anyEl = /** @type {any} */ (el);
    const lb = el.getAttribute('aria-labelledby');
    const labelledByText = lb ? lb.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ') : '';
    const visibleText = clip(anyEl.innerText, 300);
    const ariaLabel = clip(el.getAttribute('aria-label'), 300);
    return {
      tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), id: anyEl.id || '',
      automationId: el.getAttribute('data-automation-id') || '',
      name: labelledByText || ariaLabel || visibleText || clip(anyEl.value, 300) || clip(el.getAttribute('title'), 300),
      ariaLabel, labelledByText, visibleText, textContent: clip(el.textContent, 300), title: clip(el.getAttribute('title'), 300), value: clip(anyEl.value, 300),
      dataAttrs: dataAttrsOf(el), visible: isVisible(el), enabled: !anyEl.disabled && el.getAttribute('aria-disabled') !== 'true',
      inScope: Boolean(scope && (scope.contains(el) || (footer && footer.contains(el)))),
    };
  });
  const errorSel = '[role="alert"], [aria-live="assertive"], .error, .errors, .field-error, .error-message, .invalid-feedback, [data-automation-id="errorMessage"], [data-automation-id*="errorBanner" i], [data-testid*="error" i], .application--error, .has-error .help-block';
  const errors = [];
  for (const el of Array.from(document.querySelectorAll(errorSel))) {
    const t = textOf(el);
    if (t && isVisible(el)) errors.push(t.slice(0, 200));
  }
  for (const f of fields) if (f.ariaInvalid && f.visible) errors.push(`invalid field: ${f.label || f.name}`.slice(0, 200));
  const submitMatches = req && typeof req.submitSelector === 'string' && req.submitSelector
    ? Array.from(document.querySelectorAll(req.submitSelector)).map((el) => ({ visible: isVisible(el), enabled: !(/** @type {any} */ (el).disabled) && el.getAttribute('aria-disabled') !== 'true', name: clip(/** @type {any} */ (el).innerText || /** @type {any} */ (el).value || el.getAttribute('aria-label'), 200) }))
    : [];
  /** @type {Record<string, any>} */
  const probes = {};
  for (const p of (req && Array.isArray(req.probes) ? req.probes : [])) {
    let el = null;
    try {
      el = document.querySelector(p.selector);
    } catch {
      el = null;
    }
    if (!el) { probes[p.key] = { found: false }; continue; }
    const hit = fields.find((f) => f.el === el);
    const anyEl = /** @type {any} */ (el);
    const sel = el.tagName === 'SELECT' ? anyEl.options[anyEl.selectedIndex] : null;
    probes[p.key] = {
      found: true, fieldIdx: hit ? hit.idx : -1, value: anyEl.type === 'file' ? '' : String(anyEl.value ?? '').slice(0, 4000), checked: Boolean(anyEl.checked),
      selectedText: sel ? clip(sel.textContent, 400) : '', fileName: anyEl.type === 'file' && anyEl.files && anyEl.files.length ? String(anyEl.files[0].name) : '',
    };
  }
  /** @type {Record<string, any>} */
  const extras = {};
  for (const x of (req && Array.isArray(req.extras) ? req.extras : [])) {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(x.selector)).filter((e) => isVisible(e));
    } catch {
      els = [];
    }
    extras[x.key] = { count: els.length, texts: els.slice(0, 20).map((e) => textOf(x.nameSelector ? (e.querySelector(x.nameSelector) || e) : e)) };
  }
  let dataMarked = false;
  if (req && req.dataDeny && typeof req.dataDeny.source === 'string' && scope) {
    let rx = null;
    try {
      rx = new RegExp(req.dataDeny.source, typeof req.dataDeny.flags === 'string' ? req.dataDeny.flags : '');
    } catch {
      rx = null;
    }
    const scopeEls = [...Array.from(scope.querySelectorAll('*')), ...(footer ? Array.from(footer.querySelectorAll('*')) : [])];
    dataMarked = rx === null || scopeEls.some((e) => isVisible(e) && Array.from(e.attributes).some((a) => a.name.startsWith('data-') && (rx.test(a.name) || rx.test(a.value))));
  }
  return {
    url: location.href,
    title: clip(document.title, 300),
    text: clip(document.body ? document.body.innerText : '', 50000),
    scopeFound: Boolean(scope),
    scopeText: scope ? clip(`${/** @type {HTMLElement} */ (scope).innerText}${footer && !scope.contains(footer) ? ` ${/** @type {HTMLElement} */ (footer).innerText}` : ''}`, 50000) : '',
    scopeHeadings: scope ? Array.from(scope.querySelectorAll('h1, h2, h3')).filter((h) => isVisible(h)).map((h) => clip(h.textContent, 200)) : [],
    headings: Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]')).filter((h) => isVisible(h)).map((h) => clip(h.textContent, 200)),
    fields: fields.map((f) => { const { el, ...rest } = f; return rest; }),
    buttons, errors, submitMatches, probes, extras, dataMarked,
  };
};

/**
 * In-page half of clickSingle(): find the candidates, and only when there is exactly one, tag it with the
 * caller's nonce so the Node side clicks that one element through Playwright. Self-contained.
 * @param {{ selector: string, names: string[]|null, nonce: string }} req
 */
const CLICK_SINGLE_FN = (req) => {
  const norm = (/** @type {unknown} */ s) => String(s ?? '').normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').toLowerCase().trim().replace(/[\s.,;:!?…>›→»]+$/g, '').trim();
  const isVisible = (/** @type {Element} */ el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return !el.closest('[hidden], [aria-hidden="true"]');
  };
  let els = [];
  try {
    els = Array.from(document.querySelectorAll(req.selector));
  } catch {
    return { count: -1 };
  }
  const candidates = els.filter((el) => {
    const anyEl = /** @type {any} */ (el);
    if (!isVisible(el) || anyEl.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (!req.names) return true;
    const lb = el.getAttribute('aria-labelledby');
    const lbText = lb ? lb.split(/\s+/).map((id) => { const t = document.getElementById(id); return t ? t.textContent : ''; }).join(' ') : '';
    const name = lbText.trim() || el.getAttribute('aria-label') || anyEl.innerText || anyEl.value || el.getAttribute('title') || '';
    return req.names.includes(norm(name));
  });
  for (const el of Array.from(document.querySelectorAll('[data-jobsearch-click]'))) el.removeAttribute('data-jobsearch-click');
  if (candidates.length !== 1) return { count: candidates.length };
  candidates[0].setAttribute('data-jobsearch-click', req.nonce);
  return { count: 1 };
};

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
    async pageState(req = {}) {
      checkAbort();
      const main = await page.evaluate(PAGE_STATE_FN, req);
      /** @type {Array<{ url: string, text: string }>} */
      const frames = [];
      const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
      for (const f of (typeof page.frames === 'function' ? page.frames() : [])) {
        if (f === mainFrame) continue;
        let text = '';
        try {
          text = await f.evaluate(() => String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 20000));
        } catch {
          text = '';
        }
        frames.push({ url: f.url(), text });
      }
      return { ...main, url: page.url(), frames };
    },
    async clickSingle(selector, o = {}) {
      checkAbort();
      const names = Array.isArray(o.names) ? [...o.names] : null;
      const nonce = crypto.randomBytes(12).toString('hex');
      const r = await page.evaluate(CLICK_SINGLE_FN, { selector, names, nonce });
      if (!r || r.count !== 1) return { clicked: false, count: r && Number.isInteger(r.count) ? r.count : -1 };
      checkAbort();
      await page.click(`[data-jobsearch-click="${nonce}"]`);
      return { clicked: true, count: 1 };
    },
  };
  return Object.freeze(cap);
}
