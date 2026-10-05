// @ts-check
/**
 * Assisted LinkedIn Easy Apply driver: the ONLY module that clicks, types, selects, uploads, or navigates
 * on the page for this flow (test/easy-apply-lint.test.js enforces that structurally).
 *
 * It speaks raw CDP to exactly one tab (src/browser/cdp-target.js): no Playwright, no CDP domain enables,
 * no page listeners, no request interception (spec G4: nothing may survive a detach that could block
 * Damian's own Submit click). Every page operation is ONE Runtime.callFunctionOn of PAGE_FUNCTION, a
 * self-contained function built from src/apply/easy-apply-guard.js's source text plus pageMain below, so
 * for advance() the ref is resolved, its node identity re-verified, the G1/G2/G3 rules evaluated, and the
 * click performed inside the same call (spec G1). No key events are ever dispatched: text goes in through
 * the native value setter one character at a time (60-160 ms apart) and CR/LF are stripped (spec G4).
 * Server-side pacing (1.5-4 s before every action) lives here too (spec G10).
 *
 * Refs are `e<index>-<fingerprint>`: the element's index in the Easy Apply dialog's
 * `button, input, select, textarea` list plus a hash of (tag, type, id, name, label/name text). A ref whose
 * fingerprint no longer matches is refused as stale, never re-resolved by position alone.
 */
import { PAGE_GUARD_FUNCTIONS } from './easy-apply-guard.js';
import { actionDelayMs, charDelayMs } from './easy-apply-policy.js';
import { sanitizeValue } from './easy-apply-answers.js';

/**
 * In-page main. Runs inside the tab; `G` carries the injected guard functions. Must stay
 * self-contained (no references to anything outside its own body except `G` and DOM globals).
 * @param {{ op: string, ref?: string, value?: unknown, optionText?: string, checked?: boolean }} req
 * @param {any} G
 * @returns {any}
 */
function pageMain(req, G) {
  const ELEMENT_SELECTOR = 'button, input, select, textarea';
  const clip = (/** @type {unknown} */ s, /** @type {number} */ n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const isVisible = (/** @type {Element} */ el) => {
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  };
  function fieldVisible(/** @type {Element} */ el) {
    if (isVisible(el)) return true;
    const anyEl = /** @type {any} */ (el);
    const label = anyEl.id ? document.querySelector(`label[for="${CSS.escape(anyEl.id)}"]`) : el.closest('label');
    if (label && isVisible(label)) return true;
    return Boolean(el.parentElement && isVisible(el.parentElement));
  }
  function findDialog() {
    const all = Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter(isVisible);
    const easy = all.filter((d) => /easy-apply/i.test(d.className) || /^\s*apply to\b/i.test(headerOf(d)));
    return easy.length === 1 ? easy[0] : (easy.length === 0 ? null : easy[0]);
  }
  function headerOf(/** @type {Element} */ d) {
    const id = d.getAttribute('aria-labelledby');
    const byId = id ? document.getElementById(id) : null;
    if (byId) return clip(byId.textContent, 200);
    const h = d.querySelector('h1, h2, h3');
    return h ? clip(h.textContent, 200) : '';
  }
  function hash(/** @type {string} */ s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function labelledBy(/** @type {Element} */ el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return ids.map((id) => { const t = document.getElementById(id); return t ? t.textContent || '' : ''; }).join(' ');
  }
  function fieldLabel(/** @type {Element} */ el) {
    const anyEl = /** @type {any} */ (el);
    if (el instanceof HTMLInputElement && (el.type === 'radio')) {
      const fs = el.closest('fieldset');
      const legend = fs ? fs.querySelector('legend') : null;
      if (legend) return clip(legend.textContent, 500);
    }
    if (anyEl.id) {
      const l = document.querySelector(`label[for="${CSS.escape(anyEl.id)}"]`);
      if (l) return clip(l.textContent, 500);
    }
    const wrap = el.closest('label');
    if (wrap) return clip(wrap.textContent, 500);
    const lb = labelledBy(el);
    if (lb.trim()) return clip(lb, 500);
    return clip(el.getAttribute('aria-label') || '', 500);
  }
  function optionLabel(/** @type {HTMLInputElement} */ radio) {
    if (radio.id) {
      const l = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (l) return clip(l.textContent, 300);
    }
    const wrap = radio.closest('label');
    return wrap ? clip(wrap.textContent, 300) : clip(radio.value, 300);
  }
  function buttonDesc(/** @type {Element} */ el, /** @type {Element|null} */ dialog) {
    const html = /** @type {HTMLElement} */ (el);
    return {
      tag: el.tagName.toLowerCase(),
      inDialog: Boolean(dialog && dialog.contains(el)),
      disabled: Boolean(/** @type {any} */ (el).disabled) || el.getAttribute('aria-disabled') === 'true',
      ariaLabel: el.getAttribute('aria-label') || '',
      labelledByText: labelledBy(el),
      visibleText: html.innerText || '',
      textContent: el.textContent || '',
      title: el.getAttribute('title') || '',
      value: el.getAttribute('value') || '',
      dataAttrs: Array.from(el.attributes).filter((a) => /^data-/i.test(a.name)).map((a) => [a.name, a.value]),
    };
  }
  function buttonName(/** @type {Element} */ el) {
    const d = buttonDesc(el, null);
    return G.normalizeName(d.labelledByText || d.ariaLabel || d.visibleText || d.textContent);
  }
  function fingerprint(/** @type {Element} */ el) {
    const anyEl = /** @type {any} */ (el);
    const text = el.tagName === 'BUTTON' ? buttonName(el) : fieldLabel(el);
    return hash([el.tagName, anyEl.type || '', anyEl.id || '', anyEl.name || '', text].join('|'));
  }
  function elements(/** @type {Element|null} */ dialog) {
    return dialog ? Array.from(dialog.querySelectorAll(ELEMENT_SELECTOR)) : [];
  }
  function resolveRef(/** @type {Element|null} */ dialog, /** @type {unknown} */ ref) {
    const m = /^e(\d+)-([0-9a-z]+)$/.exec(String(ref || ''));
    if (!m) return { el: null, reason: 'bad_ref' };
    const el = elements(dialog)[Number(m[1])];
    if (!el) return { el: null, reason: 'stale_ref' };
    if (fingerprint(el) !== m[2]) return { el: null, reason: 'stale_ref' };
    return { el, reason: null };
  }
  function refOf(/** @type {Element} */ el, /** @type {number} */ i) {
    return `e${i}-${fingerprint(el)}`;
  }
  function progressValues(/** @type {Element|null} */ dialog) {
    if (!dialog) return [];
    /** @type {number[]} */
    const out = [];
    for (const p of Array.from(dialog.querySelectorAll('progress'))) {
      const pe = /** @type {HTMLProgressElement} */ (p);
      out.push(pe.max > 0 ? Math.round((pe.value / pe.max) * 100) : Number.NaN);
    }
    for (const p of Array.from(dialog.querySelectorAll('[role="progressbar"]'))) {
      const now = Number(p.getAttribute('aria-valuenow'));
      const max = Number(p.getAttribute('aria-valuemax') || '100');
      out.push(max > 0 ? Math.round((now / max) * 100) : Number.NaN);
    }
    return out;
  }
  function fieldKind(/** @type {Element} */ el) {
    if (el instanceof HTMLSelectElement) return 'select';
    if (el instanceof HTMLTextAreaElement) return 'textarea';
    if (el instanceof HTMLInputElement) {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'radio') return 'radio';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'file') return 'file';
      if (['text', 'email', 'tel', 'number', 'url', 'search'].includes(t)) return 'text';
      return 'unsupported';
    }
    return 'unsupported';
  }
  function isRequired(/** @type {Element} */ el) {
    const anyEl = /** @type {any} */ (el);
    if (anyEl.required || el.getAttribute('aria-required') === 'true') return true;
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const fs = el.closest('fieldset');
      if (fs && (fs.getAttribute('aria-required') === 'true' || fs.querySelector('input[required]'))) return true;
    }
    return /\*\s*$|\brequired\b/i.test(fieldLabel(el));
  }
  function chooseOptions(/** @type {HTMLSelectElement} */ s) {
    return Array.from(s.options).filter((o) => o.value !== '' && !/^select an option$/i.test(o.text.trim())).map((o) => o.text.trim());
  }
  function radioGroup(/** @type {HTMLInputElement} */ r, /** @type {Element} */ dialog) {
    const fs = r.closest('fieldset');
    const scope = fs || dialog;
    return Array.from(scope.querySelectorAll('input[type="radio"]')).filter((x) => /** @type {HTMLInputElement} */ (x).name === r.name);
  }
  function currentValue(/** @type {Element} */ el, /** @type {Element} */ dialog) {
    if (el instanceof HTMLSelectElement) {
      const o = el.selectedOptions[0];
      return o && o.value !== '' && !/^select an option$/i.test(o.text.trim()) ? o.text.trim() : '';
    }
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const on = radioGroup(el, dialog).find((x) => /** @type {HTMLInputElement} */ (x).checked);
      return on ? optionLabel(/** @type {HTMLInputElement} */ (on)) : '';
    }
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked ? 'checked' : '';
    if (el instanceof HTMLInputElement && el.type === 'file') return el.files && el.files[0] ? el.files[0].name : '';
    return String(/** @type {any} */ (el).value ?? '');
  }
  function alerts(/** @type {Element|null} */ dialog) {
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, [aria-invalid="true"]'))
      .filter((a) => isVisible(a) || a.getAttribute('aria-invalid') === 'true')
      .map((a) => clip(a.getAttribute('aria-invalid') === 'true' && !a.textContent?.trim() ? 'invalid field' : a.textContent, 200))
      .filter((t) => t.length > 0);
  }
  function resumeCards(/** @type {Element|null} */ dialog) {
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll('[data-resume-card], .jobs-document-upload-redesign-card__container, .jobs-resume-picker__resume')).map((c) => {
      const nameEl = c.querySelector('[data-resume-name], .jobs-document-upload-redesign-card__file-name, h3');
      const radio = /** @type {HTMLInputElement|null} */ (c.querySelector('input[type="radio"]'));
      const selected = /--selected\b/.test(c.className) || c.getAttribute('aria-checked') === 'true' || c.getAttribute('aria-selected') === 'true' || Boolean(radio && radio.checked);
      return { name: clip(nameEl ? nameEl.textContent : '', 300), selected };
    });
  }
  function describe() {
    const dialog = findDialog();
    const els = elements(dialog);
    const buttons = [];
    const fields = [];
    const seenRadioNames = new Set();
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.tagName === 'BUTTON') {
        if (!isVisible(el)) continue;
        buttons.push({ ref: refOf(el, i), name: buttonName(el), allowed: G.classifyAdvanceButton(buttonDesc(el, dialog)).ok });
        continue;
      }
      const kind = fieldKind(el);
      if (!fieldVisible(el)) continue;
      if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
      if (kind === 'radio') {
        const name = /** @type {HTMLInputElement} */ (el).name;
        if (seenRadioNames.has(name)) continue;
        seenRadioNames.add(name);
      }
      const options = kind === 'select' ? chooseOptions(/** @type {HTMLSelectElement} */ (el))
        : kind === 'radio' ? radioGroup(/** @type {HTMLInputElement} */ (el), /** @type {Element} */ (dialog)).map((r) => optionLabel(/** @type {HTMLInputElement} */ (r))) : [];
      const value = currentValue(el, /** @type {Element} */ (dialog));
      fields.push({ ref: refOf(el, i), kind, question: fieldLabel(el), required: isRequired(el), options, value, filled: value !== '' });
    }
    const buttonNames = buttons.map((b) => b.name);
    const dialogText = dialog ? clip(/** @type {HTMLElement} */ (dialog).innerText, 4000) : '';
    const pageText = clip(document.body ? document.body.innerText : '', 5000);
    const headerTexts = dialog ? Array.from(dialog.querySelectorAll('h1, h2, h3')).filter(isVisible).map((h) => clip(h.textContent, 200)) : [];
    const step = G.classifyStep({ dialogPresent: Boolean(dialog), headerTexts, buttonNames, dialogText, pageText, url: location.href });
    return {
      url: location.href, dialogPresent: Boolean(dialog), header: dialog ? headerOf(dialog) : '', headerTexts, step,
      progressValues: progressValues(dialog), buttons, fields, alerts: alerts(dialog), resumeCards: resumeCards(dialog), dialogText,
      stepKey: hash([headerTexts.join('|'), fields.map((f) => f.question).join('|'), buttonNames.join('|')].join('#')),
    };
  }
  function setNativeValue(/** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} */ el, /** @type {string} */ v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
  }

  const dialog = findDialog();
  switch (req.op) {
    case 'snapshot':
      return describe();
    case 'open_dialog': {
      if (dialog) return { clicked: false, reason: 'dialog_already_open' };
      const cands = Array.from(document.querySelectorAll('button')).filter((b) => isVisible(b) && !b.closest('[role="dialog"], dialog'))
        .filter((b) => G.normalizeName(/** @type {HTMLElement} */ (b).innerText) === 'easy apply');
      if (cands.length !== 1) return { clicked: false, reason: cands.length === 0 ? 'no_easy_apply_button' : 'ambiguous_easy_apply_button' };
      const b = /** @type {HTMLButtonElement} */ (cands[0]);
      const aria = G.normalizeName(b.getAttribute('aria-label') || '');
      if (aria && !/^easy apply to /.test(aria)) return { clicked: false, reason: 'unexpected_easy_apply_label' };
      if (/submit|send|done/i.test(`${aria} ${b.textContent || ''}`)) return { clicked: false, reason: 'denied_term' };
      if (b.disabled) return { clicked: false, reason: 'disabled' };
      b.click();
      return { clicked: true, reason: null };
    }
    case 'advance': {
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { clicked: false, reason: r.reason };
      if (!isVisible(r.el)) return { clicked: false, reason: 'not_visible' };
      const verdict = G.classifyAdvanceButton(buttonDesc(r.el, dialog));
      if (!verdict.ok) return { clicked: false, reason: verdict.reason, name: verdict.name };
      const snap = describe();
      if (snap.step.kind !== 'form') return { clicked: false, reason: `step_${snap.step.kind}` };
      const submitVisible = snap.buttons.some((b) => /submit/i.test(b.name));
      const terminal = G.checkNotLastStep({ buttonName: verdict.name, progressValues: snap.progressValues, submitVisible });
      if (!terminal.ok) return { clicked: false, reason: terminal.reason, name: verdict.name };
      if (snap.alerts.length > 0) return { clicked: false, reason: 'validation_alert', alerts: snap.alerts };
      const missing = snap.fields.filter((f) => f.required && !f.filled && f.kind !== 'file').map((f) => f.question);
      if (missing.length > 0) return { clicked: false, reason: 'required_empty', missing };
      /** @type {HTMLButtonElement} */ (r.el).click();
      return { clicked: true, reason: null, name: verdict.name };
    }
    case 'fill_text': {
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { ok: false, reason: r.reason };
      if (!isVisible(r.el)) return { ok: false, reason: 'not_visible' };
      if (!(r.el instanceof HTMLInputElement || r.el instanceof HTMLTextAreaElement) || fieldKind(r.el) === 'radio' || fieldKind(r.el) === 'checkbox' || fieldKind(r.el) === 'file' || fieldKind(r.el) === 'unsupported') return { ok: false, reason: 'not_text_field' };
      const v = String(req.value ?? '').replace(/\r\n|\r|\n/g, ' ');
      setNativeValue(r.el, v);
      r.el.dispatchEvent(new Event('input', { bubbles: true }));
      if (req.checked === true) r.el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, readBack: r.el.value };
    }
    case 'select': {
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { ok: false, reason: r.reason };
      if (!(r.el instanceof HTMLSelectElement)) return { ok: false, reason: 'not_select' };
      if (!isVisible(r.el)) return { ok: false, reason: 'not_visible' };
      const opt = Array.from(r.el.options).find((o) => o.text.trim() === String(req.optionText ?? ''));
      if (!opt) return { ok: false, reason: 'option_not_found' };
      setNativeValue(r.el, opt.value);
      r.el.dispatchEvent(new Event('input', { bubbles: true }));
      r.el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, readBack: currentValue(r.el, /** @type {Element} */ (dialog)) };
    }
    case 'radio': {
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { ok: false, reason: r.reason };
      if (!(r.el instanceof HTMLInputElement) || r.el.type !== 'radio') return { ok: false, reason: 'not_radio' };
      if (!fieldVisible(r.el)) return { ok: false, reason: 'not_visible' };
      const target = radioGroup(r.el, /** @type {Element} */ (dialog)).find((x) => optionLabel(/** @type {HTMLInputElement} */ (x)) === String(req.optionText ?? ''));
      if (!target) return { ok: false, reason: 'option_not_found' };
      const t = /** @type {HTMLInputElement} */ (target);
      if (!t.checked) t.click();
      return { ok: true, readBack: currentValue(r.el, /** @type {Element} */ (dialog)) };
    }
    case 'checkbox': {
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { ok: false, reason: r.reason };
      if (!(r.el instanceof HTMLInputElement) || r.el.type !== 'checkbox') return { ok: false, reason: 'not_checkbox' };
      if (!fieldVisible(r.el)) return { ok: false, reason: 'not_visible' };
      if (/^follow\b/i.test(fieldLabel(r.el).trim())) return { ok: false, reason: 'follow_company' };
      if (r.el.checked !== Boolean(req.checked)) r.el.click();
      return { ok: true, readBack: r.el.checked ? 'checked' : '' };
    }
    case 'read_field': {
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { ok: false, reason: r.reason };
      return { ok: true, value: currentValue(r.el, /** @type {Element} */ (dialog)), kind: fieldKind(r.el), question: fieldLabel(r.el), required: isRequired(r.el) };
    }
    case 'file_input': {
      const files = dialog ? Array.from(dialog.querySelectorAll('input[type="file"]')).filter((f) => fieldVisible(f)) : [];
      return files.length === 1 ? files[0] : null;
    }
    case 'applied_badge': {
      const text = clip(document.body ? document.body.innerText : '', 20000);
      if (/\bapplied\s+\d+\s+(?:second|minute|hour|day|week|month)s?\s+ago\b|\bapplication (?:was )?sent\b|\bapplication submitted\b/i.test(text)) return { state: 'applied', evidence: (/\bapplied\s+\d+\s+\w+\s+ago\b|\bapplication (?:was )?sent\b|\bapplication submitted\b/i.exec(text) || [''])[0] };
      if (document.querySelector('[class*="jobs-unified-top-card"], [class*="job-details"], [data-job-id]') || findDialog()) return { state: 'not_applied', evidence: null };
      return { state: 'unknown', evidence: null };
    }
    case 'ready_state':
      return { readyState: document.readyState, url: location.href };
    default:
      return { ok: false, reason: 'unknown_op' };
  }
}

/** The one function declaration sent with every Runtime.callFunctionOn. */
export const PAGE_FUNCTION = `function (req) {
${PAGE_GUARD_FUNCTIONS.map((f) => f.toString().replace(/^export\s+/, '')).join('\n')}
const G = { ${PAGE_GUARD_FUNCTIONS.map((f) => f.name).join(', ')} };
return (${pageMain.toString()})(req, G);
}`;

/**
 * @typedef {Object} EasyApplyDriverDeps
 * @property {import('../browser/cdp-target.js').CdpClient} cdp
 * @property {string} targetId the one tab this driver may touch
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [rand]
 * @property {boolean} [pacing] false only in tests; production always paces
 */

/**
 * @param {EasyApplyDriverDeps} deps
 */
export function createEasyApplyDriver(deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  const rand = deps.rand ?? Math.random;
  const pacing = deps.pacing !== false;
  /** @type {string|null} */
  let sessionId = null;

  async function pace() {
    if (pacing) await sleep(actionDelayMs(rand));
  }

  /**
   * One Runtime.callFunctionOn of PAGE_FUNCTION against the tab's global object.
   * @param {Record<string, unknown>} req
   * @param {{ byValue?: boolean }} [o]
   */
  async function call(req, o = {}) {
    if (!sessionId) throw new Error('easy apply driver is not attached');
    const group = `easyapply-${Date.now()}`;
    const g = await deps.cdp.send('Runtime.evaluate', { expression: 'globalThis', objectGroup: group }, sessionId);
    try {
      const r = await deps.cdp.send('Runtime.callFunctionOn', {
        functionDeclaration: PAGE_FUNCTION, objectId: g.result.objectId, arguments: [{ value: req }],
        returnByValue: o.byValue !== false, awaitPromise: false, objectGroup: group,
      }, sessionId);
      if (r.exceptionDetails) throw new Error(`page function threw: ${String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300)}`);
      return o.byValue === false ? { result: r.result, group } : r.result.value;
    } finally {
      if (o.byValue !== false) await deps.cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }, sessionId).catch(() => {});
    }
  }

  const driver = {
    async attach() {
      sessionId = await deps.cdp.attach(deps.targetId);
    },
    async detach() {
      if (sessionId) await deps.cdp.detach(sessionId);
      sessionId = null;
    },
    /** @returns {Promise<any>} */
    snapshot() {
      return call({ op: 'snapshot' });
    },
    /** @returns {Promise<{ readyState: string, url: string }>} */
    readyState() {
      return call({ op: 'ready_state' });
    },
    /**
     * Navigate the tab (the worker passes only a guardUrl-checked LinkedIn job URL).
     * @param {string} url
     * @param {{ timeoutMs?: number, pollMs?: number }} [o]
     */
    async navigate(url, o = {}) {
      if (!sessionId) throw new Error('easy apply driver is not attached');
      await deps.cdp.send('Page.navigate', { url }, sessionId);
      const deadline = Date.now() + (o.timeoutMs ?? 45000);
      while (Date.now() < deadline) {
        await sleep(o.pollMs ?? 500);
        try {
          const s = await driver.readyState();
          if (s.readyState === 'complete' || s.readyState === 'interactive') return s;
        } catch {
          /* context replaced mid-navigation: poll again */
        }
      }
      throw new Error('navigation did not finish in time');
    },
    async openDialog() {
      await pace();
      return call({ op: 'open_dialog' });
    },
    /** @param {string} ref */
    async advance(ref) {
      await pace();
      return call({ op: 'advance', ref });
    },
    /** @param {string} ref */
    readField(ref) {
      return call({ op: 'read_field', ref });
    },
    /**
     * Type `value` one character at a time through the native value setter (no key events), 60-160 ms
     * apart, re-verifying the ref on every character, then fire one change event.
     * @param {string} ref
     * @param {string} value
     */
    async typeText(ref, value) {
      await pace();
      const v = sanitizeValue(value);
      let r = await call({ op: 'fill_text', ref, value: '' });
      if (!r.ok) return r;
      for (let i = 1; i <= v.length; i++) {
        if (pacing) await sleep(charDelayMs(rand));
        r = await call({ op: 'fill_text', ref, value: v.slice(0, i), checked: i === v.length });
        if (!r.ok) return r;
      }
      if (v.length === 0) r = await call({ op: 'fill_text', ref, value: '', checked: true });
      return r;
    },
    /** @param {string} ref @param {string} optionText */
    async chooseOption(ref, optionText) {
      await pace();
      return call({ op: 'select', ref, optionText });
    },
    /** @param {string} ref @param {string} optionText */
    async chooseRadio(ref, optionText) {
      await pace();
      return call({ op: 'radio', ref, optionText });
    },
    /** @param {string} ref @param {boolean} checked */
    async setCheckbox(ref, checked) {
      await pace();
      return call({ op: 'checkbox', ref, checked });
    },
    /**
     * Set the dialog's single file input to `absPath` via DOM.setFileInputFiles (no click, no OS file
     * dialog), then read back the input's own file name.
     * @param {string} absPath
     */
    async uploadFile(absPath) {
      await pace();
      const h = await call({ op: 'file_input' }, { byValue: false });
      try {
        if (!h.result || h.result.subtype === 'null' || !h.result.objectId) return { ok: false, reason: 'file_input_not_found' };
        await deps.cdp.send('DOM.setFileInputFiles', { files: [absPath], objectId: h.result.objectId }, /** @type {string} */ (sessionId));
        const nameRes = await deps.cdp.send('Runtime.callFunctionOn', {
          functionDeclaration: 'function () { return this.files && this.files[0] ? this.files[0].name : ""; }',
          objectId: h.result.objectId, returnByValue: true,
        }, /** @type {string} */ (sessionId));
        return { ok: true, fileName: String(nameRes.result.value ?? '') };
      } finally {
        await deps.cdp.send('Runtime.releaseObjectGroup', { objectGroup: h.group }, /** @type {string} */ (sessionId)).catch(() => {});
      }
    },
    /** @returns {Promise<{ state: 'applied'|'not_applied'|'unknown', evidence: string|null }>} */
    appliedBadge() {
      return call({ op: 'applied_badge' });
    },
    /** @returns {Promise<Buffer>} */
    async screenshot() {
      if (!sessionId) throw new Error('easy apply driver is not attached');
      const r = await deps.cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      return Buffer.from(String(r.data ?? ''), 'base64');
    },
  };
  return driver;
}
