// @ts-check
/**
 * The ONLY DOM construction path for src/dashboard/public/ (pr3-spec-decisions.md section 1 and 2).
 * Every attribute name is checked against a closed allow-list; anything not recognized throws instead of
 * being silently accepted, so a future call site cannot introduce a new DOM sink without this file
 * changing first. Untrusted text always reaches the DOM through `.textContent`, never through markup.
 *
 * href/src are NOT settable through the plain attrs object at all: they only exist through `hLink()`,
 * which requires an explicit `urlOk: true` argument and re-validates the URL itself before ever writing
 * the attribute (section 2, rules 2 and 5). `url_ok` absent, false, or the URL failing re-validation all
 * fall back to a plain text span, never a silently broken/empty link.
 */

/** Attribute names `h()` will call setAttribute with directly (section 1's ALLOWED-sink attribute list). */
const SAFE_ATTR_NAMES = new Set([
  'class', 'id', 'type', 'name', 'placeholder', 'title', 'for', 'tabindex', 'role',
  'colspan', 'rowspan', 'min', 'max', 'step', 'pattern', 'disabled', 'readonly',
  'aria-label', 'aria-hidden', 'aria-expanded', 'aria-current', 'aria-live', 'aria-describedby',
  'aria-selected', 'aria-checked', 'aria-controls', 'aria-haspopup', 'aria-disabled', 'aria-pressed', 'aria-modal',
]);

/** @param {string} name */
function isSafeAttrName(name) {
  if (SAFE_ATTR_NAMES.has(name)) return true;
  if (name.startsWith('data-')) return true;
  return false;
}

/**
 * The only place a link's scheme is ever judged safe. No base URL is ever passed to `new URL()`: a
 * relative-looking string throws there and is refused, rather than silently resolving against the
 * dashboard's own origin (section 2 rule 5).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  /** @type {URL} */
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/**
 * The full guarded-link decision as a pure, DOM-free function (section 2 rules 3-5), so it is directly
 * unit-testable with a table of (url_ok, value) pairs without needing a real `document`. `url_ok` absent
 * or not literally `true` maps to false (rule 4's "absent maps to false"); `true` still re-validates the
 * value itself (rule 5), so a server bug claiming `url_ok: true` on a javascript-pseudo-scheme, `data:`, or relative
 * string is still caught here.
 * @param {{ url: unknown, urlOk?: boolean }} opts
 * @returns {boolean}
 */
export function isLinkSafe(opts) {
  return opts.urlOk === true && isSafeHttpUrl(opts.url);
}

/**
 * @typedef {Object} HAttrs
 * @property {string} [className]
 * @property {Record<string,string>} [dataset]
 * @property {string} [text] shorthand for a single textContent value (mutually exclusive with children)
 * @property {Record<string, (ev: Event) => void>} [on] event listeners, attached via addEventListener
 * @property {boolean} [disabled]
 * @property {boolean} [readOnly]
 * @property {boolean} [checked]
 * @property {boolean} [selected]
 * @property {string|number} [value]
 * @property {string} [htmlFor] renders as the `for` attribute
 * @property {Record<string, string|number|boolean>} [attrs] additional safe-listed attributes by name
 * @property {string} [hashHref] internal same-page navigation only: must match /^#(\/[^"]*)?$/, a hash
 *   fragment this app itself constructed (via lib/router.js's buildHash() or a literal `#/...` string),
 *   never a value derived from untrusted listing data. A caller reaching for an external/untrusted URL
 *   must use `hLink()` instead, which requires the distinct `urlOk: true` guard.
 */

/**
 * @param {string} tag
 * @param {HAttrs} [attrs]
 * @param {Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  if (attrs.className) el.className = attrs.className;
  if (attrs.dataset) {
    for (const [k, v] of Object.entries(attrs.dataset)) el.dataset[k] = String(v);
  }
  if (attrs.on) {
    for (const [evt, fn] of Object.entries(attrs.on)) el.addEventListener(evt, fn);
  }
  if (attrs.value !== undefined) /** @type {any} */ (el).value = attrs.value;
  if (attrs.checked !== undefined) /** @type {any} */ (el).checked = attrs.checked;
  if (attrs.selected !== undefined) /** @type {any} */ (el).selected = attrs.selected;
  if (attrs.disabled !== undefined) /** @type {any} */ (el).disabled = attrs.disabled;
  if (attrs.readOnly !== undefined) /** @type {any} */ (el).readOnly = attrs.readOnly;
  if (attrs.htmlFor !== undefined) el.setAttribute('for', String(attrs.htmlFor));
  if (attrs.hashHref !== undefined) {
    if (!/^#(\/[^"]*)?$/.test(attrs.hashHref)) throw new Error(`h(): hashHref must be an internal "#/..." fragment, got ${JSON.stringify(attrs.hashHref)}`);
    el.setAttribute('href', attrs.hashHref);
  }
  if (attrs.attrs) {
    for (const [name, value] of Object.entries(attrs.attrs)) {
      if (!isSafeAttrName(name)) throw new Error(`h(): unsafe attribute "${name}"`);
      if (value === false || value === null || value === undefined) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (attrs.text !== undefined) {
    el.textContent = attrs.text;
    return el;
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** @param {string} str */
export function text(str) {
  return document.createTextNode(String(str ?? ''));
}

/** Replace every child of `el` with `children`, using only Node-argument appends (never a string join). */
export function setChildren(el, children) {
  el.replaceChildren();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/**
 * The only guarded href/src construction path (section 2). Renders an `<a>` when `urlOk === true` AND
 * the value passes `isSafeHttpUrl`; otherwise renders a plain `<span>` with the same visible text, never
 * a broken link or one capable of running the javascript pseudo-protocol. `urlOk` is never inferred here: the caller must pass exactly
 * `row.url_ok === true` (see section 2 rule 3) or omit it, and an absent/false `urlOk` always falls to
 * the text branch (rule 4's "absent maps to false").
 * @param {{ url: unknown, urlOk?: boolean, text: string, className?: string, target?: '_blank' }} opts
 */
export function hLink(opts) {
  const ok = isLinkSafe(opts);
  if (!ok) {
    return h('span', { className: opts.className, text: opts.text });
  }
  const el = h('a', { className: opts.className, text: opts.text });
  el.setAttribute('href', /** @type {string} */ (opts.url));
  el.setAttribute('rel', 'noopener noreferrer');
  if (opts.target === '_blank') el.setAttribute('target', '_blank');
  return el;
}

/** Remove all children of `el`. */
export function clear(el) {
  el.replaceChildren();
}

/**
 * The only iframe-construction path (section 6 item 2: stored report/research HTML renders only inside
 * `<iframe sandbox>` with zero `allow-*` tokens, `allow-scripts` and `allow-same-origin` never together).
 * `src` must be a same-origin, closed-prefix API path this dashboard itself constructs (`/api/documents/
 * file?...` or `/api/report/preview.html?...`), never an arbitrary caller-supplied URL: this is a
 * structural guard, not a URL the front end ever receives from untrusted listing data.
 * @param {{ src: string, title: string, className?: string }} opts
 */
export function hSandboxedIframe(opts) {
  if (!/^\/api\/(documents\/file|report\/preview\.html)\?/.test(opts.src)) {
    throw new Error('hSandboxedIframe(): src must be a same-origin /api/documents/file or /api/report/preview.html path');
  }
  const el = document.createElement('iframe');
  el.setAttribute('sandbox', '');
  el.setAttribute('src', opts.src);
  el.setAttribute('title', opts.title);
  if (opts.className) el.className = opts.className;
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Geometry/presentation attribute names `hSvg()` allows. Never `href`/`xlink:href` (no URL sink in charts). */
const SAFE_SVG_ATTR_NAMES = new Set([
  'class', 'role', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'preserveAspectRatio',
  'text-anchor', 'dominant-baseline', 'stroke-width', 'stroke-linecap', 'stroke-dasharray',
  'aria-hidden', 'aria-label', 'focusable',
]);

/**
 * The SVG counterpart to `h()`, used only by `charts.js`. Same closed-attribute discipline: every
 * fill/stroke color comes from a CSS class (`.bar--accent { fill: var(--accent); }`), never an inline style
 * or a raw `fill="#hex"` attribute, so chart colors stay inside the same total classification as every
 * other DOM write in this package.
 * @param {string} tag
 * @param {Record<string, string|number>} [attrs]
 * @param {Array<Node|string|null|undefined|false>} [children]
 */
export function hSvg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (!SAFE_SVG_ATTR_NAMES.has(name)) throw new Error(`hSvg(): unsafe attribute "${name}"`);
    if (value === undefined || value === null) continue;
    el.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}
