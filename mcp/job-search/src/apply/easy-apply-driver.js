// @ts-check
/**
 * Assisted apply driver (ATS-agnostic; LinkedIn Easy Apply is the only profile today): the ONLY module that
 * clicks, types, selects, uploads, or navigates on the page for this flow (test/easy-apply-lint.test.js
 * enforces that structurally, which is also why the implementation stays at this path;
 * src/apply/assisted/driver.js re-exports it under the assisted name).
 *
 * The ATS profile (src/apply/assisted/profiles/) supplies the page rules as plain data: every page call
 * carries them as req.rules, and the one page function evaluates the injected guard functions
 * (src/apply/assisted/guard.js) against them, so a single page function serves every profile (spec v1
 * clause 1). createEasyApplyDriver is the LinkedIn-bound entry point existing callers use.
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
import { PAGE_GUARD_FUNCTIONS } from './assisted/guard.js';
import { actionDelayMs, charDelayMs } from './easy-apply-policy.js';
import { sanitizeValue } from './assisted/answers.js';
import { LINKEDIN_PROFILE } from './assisted/profiles/linkedin.js';

/**
 * In-page main. Runs inside the tab; `G` carries the injected guard functions and req.rules the profile's
 * rules (plain data). Must stay self-contained (no references to anything outside its own body except
 * `G`, `req`, and DOM globals). Unusable rules find no form scope and refuse every guard verdict.
 * @param {{ op: string, ref?: string, value?: unknown, optionText?: string, checked?: boolean, rules?: any }} req
 * @param {any} G
 * @returns {any}
 */
function pageMain(req, G) {
  const ELEMENT_SELECTOR = 'button, input, select, textarea';
  const R = req.rules && typeof req.rules === 'object' ? req.rules : null;
  const toRe = (/** @type {any} */ spec) => {
    if (!spec || typeof spec !== 'object' || typeof spec.source !== 'string' || !spec.source) return null;
    try {
      return new RegExp(spec.source, typeof spec.flags === 'string' ? spec.flags : '');
    } catch {
      return null;
    }
  };
  // Native accessors, read through the prototypes so a page-defined instance property cannot answer for
  // them (amended A4: the label that is checked is the label that is clicked).
  const innerTextOf = (/** @type {Element} */ el) => {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
    return d && d.get ? String(d.get.call(el) ?? '') : String(/** @type {any} */ (el).innerText ?? '');
  };
  const textContentOf = (/** @type {Element} */ el) => {
    const d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    return d && d.get ? String(d.get.call(el) ?? '') : String(el.textContent ?? '');
  };
  const dataAttrsOf = (/** @type {Element} */ el) => Array.from(el.attributes).filter((a) => /^data-/i.test(a.name)).map((a) => [a.name, a.value]);
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
    const sc = R && R.scope && typeof R.scope === 'object' ? R.scope : null;
    if (!sc || typeof sc.containerSelector !== 'string' || !sc.containerSelector) return null;
    const all = Array.from(document.querySelectorAll(sc.containerSelector)).filter(isVisible);
    // anyContainer (Workday): the selector itself identifies the scope; anything but exactly one visible
    // match is no scope at all (no fields, no clicks).
    if (sc.anyContainer === true) return all.length === 1 ? all[0] : null;
    const classRe = toRe(sc.classPattern);
    const headerRe = toRe(sc.headerPattern);
    if (!classRe || !headerRe) return null;
    const easy = all.filter((d) => classRe.test(d.className) || headerRe.test(headerOf(d)));
    return easy.length === 1 ? easy[0] : (easy.length === 0 ? null : easy[0]);
  }
  /** The profile's footer (Workday's Next/Back bar lives outside the flow container), or null. */
  function findFooter(/** @type {Element|null} */ dialog) {
    const sc = R && R.scope && typeof R.scope === 'object' ? R.scope : null;
    if (!dialog || !sc || typeof sc.footerSelector !== 'string' || !sc.footerSelector) return null;
    const all = Array.from(document.querySelectorAll(sc.footerSelector)).filter((f) => isVisible(f) && !dialog.contains(f));
    return all.length === 1 ? all[0] : null;
  }
  function inScope(/** @type {Element} */ el, /** @type {Element|null} */ dialog) {
    if (!dialog) return false;
    if (dialog.contains(el)) return true;
    const footer = findFooter(dialog);
    return Boolean(footer && footer.contains(el));
  }
  function isListbox(/** @type {Element} */ el) {
    const L = R && R.listbox && typeof R.listbox === 'object' ? R.listbox : null;
    return Boolean(L && typeof L.triggerSelector === 'string' && L.triggerSelector && el.matches(L.triggerSelector));
  }
  /** A7: password-like inputs are never listed, read, or written. */
  function isPasswordLike(/** @type {Element} */ el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if ((el.type || '').toLowerCase() === 'password') return true;
    const names = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('autocomplete'), el.getAttribute('data-automation-id')].map((x) => String(x || '')).join(' ');
    return /pass(?:word|code|phrase)|\bpwd\b/i.test(names);
  }
  function stepBar(/** @type {string[]} */ headerTexts) {
    const P = R && R.progress && typeof R.progress === 'object' ? R.progress : null;
    const out = { labels: /** @type {string[]} */ ([]), active: /** @type {number|null} */ (null), headerTexts };
    if (!P || typeof P.containerSelector !== 'string' || typeof P.stepSelector !== 'string' || typeof P.activeSelector !== 'string') return out;
    const bars = Array.from(document.querySelectorAll(P.containerSelector)).filter(isVisible);
    if (bars.length !== 1) return out;
    const steps = Array.from(bars[0].querySelectorAll(P.stepSelector)).filter(isVisible);
    // Live Workday (2026-10-05 read-only probe): each step holds a screen-reader label ("current step 1
    // of 6") and the visible step name in separate <label>s; the step name is what the header matches.
    const stepName = (/** @type {Element} */ s) => {
      const names = Array.from(s.querySelectorAll('label')).map((l) => clip(l.textContent, 200)).filter((t) => t && !/^(?:(?:current|completed)\s+)?step\s+\d+\s+of\s+\d+$/i.test(t));
      return names.length > 0 ? names.join(' ') : clip(s.textContent, 200);
    };
    out.labels = steps.map(stepName);
    const act = steps.map((s, i) => (s.matches(P.activeSelector) ? i : -1)).filter((i) => i >= 0);
    out.active = act.length === 1 ? act[0] : null;
    return out;
  }
  function popupItems() {
    const L = R && R.listbox && typeof R.listbox === 'object' ? R.listbox : null;
    if (!L || typeof L.popupSelector !== 'string' || typeof L.optionSelector !== 'string') return { ok: false, reason: 'no_listbox_rules', items: [] };
    const pops = Array.from(document.querySelectorAll(L.popupSelector)).filter(isVisible);
    if (pops.length !== 1) return { ok: false, reason: pops.length === 0 ? 'no_popup' : 'multiple_popups', items: [] };
    return { ok: true, reason: null, items: Array.from(pops[0].querySelectorAll(L.optionSelector)).filter(isVisible) };
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
    const aria = clip(el.getAttribute('aria-label') || '', 500);
    // Live Workday listbox buttons carry "<question> <current value> Required" as their aria-label; the
    // question is what is left once the button's own text and the trailing Required are removed.
    if (aria && isListbox(el)) {
      const shown = clip(innerTextOf(el), 300);
      let q = aria.replace(/\s+required\s*$/i, '');
      if (shown && q.endsWith(shown)) q = q.slice(0, q.length - shown.length);
      return clip(q, 500);
    }
    return aria;
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
    // A3: data-* on the button, every descendant, and every ancestor up to (not including) the dialog.
    /** @type {Array<string[]>} */
    const dataAttrs = [...dataAttrsOf(el)];
    for (const d of Array.from(el.querySelectorAll('*'))) dataAttrs.push(...dataAttrsOf(d));
    const footer = dialog ? findFooter(dialog) : null;
    for (let a = el.parentElement; a && a !== dialog && a !== footer; a = a.parentElement) dataAttrs.push(...dataAttrsOf(a));
    return {
      tag: el.tagName.toLowerCase(),
      inDialog: inScope(el, dialog),
      id: el.getAttribute('id') || '',
      disabled: Boolean(/** @type {any} */ (el).disabled) || el.getAttribute('aria-disabled') === 'true',
      ariaLabel: el.getAttribute('aria-label') || '',
      labelledByText: labelledBy(el),
      visibleText: innerTextOf(el),
      textContent: textContentOf(el),
      title: el.getAttribute('title') || '',
      value: el.getAttribute('value') || '',
      dataAttrs,
    };
  }
  function buttonName(/** @type {Element} */ el) {
    const d = buttonDesc(el, null);
    return G.normalizeName(d.labelledByText || d.ariaLabel || d.visibleText || d.textContent);
  }
  function fingerprint(/** @type {Element} */ el) {
    const anyEl = /** @type {any} */ (el);
    // A listbox prompt's button text IS its value, so its fingerprint uses the field label instead.
    const text = el.tagName === 'BUTTON' && !isListbox(el) ? buttonName(el) : fieldLabel(el);
    return hash([el.tagName, anyEl.type || '', anyEl.id || '', anyEl.name || '', text].join('|'));
  }
  function elements(/** @type {Element|null} */ dialog) {
    if (!dialog) return [];
    const footer = findFooter(dialog);
    return [...Array.from(dialog.querySelectorAll(ELEMENT_SELECTOR)), ...(footer ? Array.from(footer.querySelectorAll(ELEMENT_SELECTOR)) : [])];
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
  function progressValues(/** @type {Element|null} */ dialog, /** @type {string[]} */ headerTexts) {
    if (!dialog) return [];
    if (R && R.progress && typeof R.progress === 'object' && R.progress.mode === 'stepBar') return G.stepBarProgress(stepBar(headerTexts));
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
  /** Workday multiselect prompt container of a field, or null (its value is the selected-item chips). */
  function multiselectOf(/** @type {Element} */ el) {
    const M = R && R.multiselect && typeof R.multiselect === 'object' ? R.multiselect : null;
    return M && typeof M.containerSelector === 'string' && M.containerSelector ? el.closest(M.containerSelector) : null;
  }
  function fieldKind(/** @type {Element} */ el) {
    if (isListbox(el)) return 'listbox';
    if (isPasswordLike(el)) return 'password';
    if (multiselectOf(el)) return 'multiselect';
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
    if (isListbox(el) && /\brequired\s*$/i.test(el.getAttribute('aria-label') || '')) return true;
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
    if (isPasswordLike(el)) return '';
    const ms = multiselectOf(el);
    if (ms) {
      const sel = R.multiselect.selectedSelector;
      return typeof sel === 'string' && sel ? Array.from(ms.querySelectorAll(sel)).filter(isVisible).map((x) => clip(x.textContent, 200)).filter(Boolean).join('; ') : '';
    }
    if (isListbox(el)) {
      const t = clip(innerTextOf(el), 300);
      const ph = toRe(R && R.listbox ? R.listbox.placeholder : null);
      return ph && ph.test(t) ? '' : t;
    }
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
      if (el.tagName === 'BUTTON' && !isListbox(el)) {
        if (!isVisible(el)) continue;
        const desc = buttonDesc(el, dialog);
        const verdict = G.classifyAdvanceButton(desc, R);
        buttons.push({ ref: refOf(el, i), name: buttonName(el), allowed: verdict.ok, kind: verdict.kind, submitMarked: G.isSubmitMarked(desc, R) });
        continue;
      }
      const kind = fieldKind(el);
      // A7: a password-like input is never listed (its value never leaves the page); passwordPresent
      // below stops the session instead.
      if (kind === 'password') continue;
      if (!fieldVisible(el)) continue;
      // Workday renders unlabeled, invisible helper inputs inside its prompt widgets (2026-10-05 probe);
      // they are not questions, so a profile can drop them.
      if (R && R.skipUnlabeledHidden === true && !isVisible(el) && !fieldLabel(el).trim()) continue;
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
    // A3b: a Submit control is visible when any visible dialog button is submit-marked (A2 + A3), or any
    // visible dialog element carries a submit-marked data-* attribute.
    const footer = findFooter(dialog);
    const scopeAll = dialog ? [...Array.from(dialog.querySelectorAll('*')), ...(footer ? Array.from(footer.querySelectorAll('*')) : [])] : [];
    const markedElement = scopeAll.some((x) => G.isSubmitMarked({ dataAttrs: dataAttrsOf(x) }, R) && isVisible(x));
    const submitVisible = buttons.some((b) => b.submitMarked) || markedElement;
    const dialogText = dialog ? clip(`${/** @type {HTMLElement} */ (dialog).innerText}${footer ? ` ${/** @type {HTMLElement} */ (footer).innerText}` : ''}`, 20000) : '';
    const pageText = clip(document.body ? document.body.innerText : '', 5000);
    const headerTexts = dialog ? Array.from(dialog.querySelectorAll('h1, h2, h3')).filter(isVisible).map((h) => clip(h.textContent, 200)) : [];
    const authSel = R && R.authLost && typeof R.authLost === 'object' && typeof R.authLost.selector === 'string' ? R.authLost.selector : '';
    const authGatePresent = authSel ? Array.from(document.querySelectorAll(authSel)).some(isVisible) : false;
    const passwordPresent = Array.from(document.querySelectorAll('input')).some((x) => isPasswordLike(x) && fieldVisible(x));
    const step = G.classifyStep({ dialogPresent: Boolean(dialog), headerTexts, submitVisible, dialogText, pageText, url: location.href, authGatePresent, passwordPresent }, R);
    const U = R && R.upload && typeof R.upload === 'object' ? R.upload : null;
    const uploadedFiles = U && typeof U.itemSelector === 'string'
      ? Array.from(document.querySelectorAll(U.itemSelector)).filter((x) => isVisible(x) && inScope(x, dialog)).map((x) => {
        const n = typeof U.nameSelector === 'string' ? x.querySelector(U.nameSelector) : null;
        return clip(n ? n.textContent : x.textContent, 300);
      })
      : [];
    return {
      url: location.href, dialogPresent: Boolean(dialog), header: dialog ? headerOf(dialog) : '', headerTexts, step, submitVisible,
      progressValues: progressValues(dialog, headerTexts), buttons, fields, alerts: alerts(dialog), resumeCards: resumeCards(dialog), uploadedFiles, dialogText,
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
      const firstDesc = JSON.stringify(buttonDesc(r.el, dialog));
      const verdict = G.classifyAdvanceButton(JSON.parse(firstDesc), R);
      if (!verdict.ok) return { clicked: false, reason: verdict.reason, name: verdict.name };
      const snap = describe();
      if (snap.step.kind !== 'form') return { clicked: false, reason: `step_${snap.step.kind}` };
      const terminal = G.checkNotLastStep({ buttonKind: verdict.kind, progressValues: snap.progressValues, submitVisible: snap.submitVisible });
      if (!terminal.ok) return { clicked: false, reason: terminal.reason, name: verdict.name };
      if (snap.alerts.length > 0) return { clicked: false, reason: 'validation_alert', alerts: snap.alerts };
      const missing = snap.fields.filter((f) => f.required && !f.filled && f.kind !== 'file').map((f) => f.question);
      if (missing.length > 0) return { clicked: false, reason: 'required_empty', missing };
      // A4: re-verify immediately before the click, still inside this one call: same node, same
      // fingerprint, identical descriptor (labels, text, data-* scan), still connected and visible.
      const again = resolveRef(findDialog(), req.ref);
      if (again.el !== r.el || !r.el.isConnected || !isVisible(r.el) || JSON.stringify(buttonDesc(r.el, findDialog())) !== firstDesc) {
        return { clicked: false, reason: 'changed_before_click' };
      }
      HTMLElement.prototype.click.call(r.el);
      return { clicked: true, reason: null, name: verdict.name, kind: verdict.kind };
    }
    case 'fill_text': {
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { ok: false, reason: r.reason };
      if (!isVisible(r.el)) return { ok: false, reason: 'not_visible' };
      if (!(r.el instanceof HTMLInputElement || r.el instanceof HTMLTextAreaElement) || fieldKind(r.el) !== (r.el instanceof HTMLTextAreaElement ? 'textarea' : 'text')) return { ok: false, reason: 'not_text_field' };
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
      if (isPasswordLike(r.el)) return { ok: false, reason: 'password_field' };
      return { ok: true, value: currentValue(r.el, /** @type {Element} */ (dialog)), kind: fieldKind(r.el), question: fieldLabel(r.el), required: isRequired(r.el) };
    }
    case 'open_listbox': {
      // Opens a listbox prompt (a button that pops an option list). No timers here: the popup renders
      // after this call returns, and list_options / pick_option are separate calls (spec v1 clause 3).
      const r = resolveRef(dialog, req.ref);
      if (!r.el) return { ok: false, reason: r.reason };
      if (!isListbox(r.el)) return { ok: false, reason: 'not_listbox' };
      if (!isVisible(r.el)) return { ok: false, reason: 'not_visible' };
      if (G.isSubmitMarked(buttonDesc(r.el, dialog), R)) return { ok: false, reason: 'denied_term' };
      HTMLElement.prototype.click.call(r.el);
      return { ok: true };
    }
    case 'list_options': {
      const p = popupItems();
      if (!p.ok) return { ok: false, reason: p.reason };
      return { ok: true, options: p.items.map((o) => clip(innerTextOf(o), 300)) };
    }
    case 'pick_option': {
      // A4: normalized exact match only; zero or two-plus matches refuse without clicking.
      const p = popupItems();
      if (!p.ok) return { ok: false, reason: p.reason };
      const want = G.normalizeName(String(req.optionText ?? ''));
      const hits = want ? p.items.filter((o) => G.normalizeName(innerTextOf(o)) === want) : [];
      if (hits.length !== 1) return { ok: false, reason: hits.length === 0 ? 'no_exact_option' : 'ambiguous_option' };
      HTMLElement.prototype.click.call(hits[0]);
      return { ok: true, picked: clip(innerTextOf(hits[0]), 300) };
    }
    case 'file_input': {
      const files = dialog ? Array.from(dialog.querySelectorAll('input[type="file"]')).filter((f) => fieldVisible(f)) : [];
      return files.length === 1 ? files[0] : null;
    }
    case 'applied_badge': {
      const ae = R && R.appliedEvidence && typeof R.appliedEvidence === 'object' ? R.appliedEvidence : null;
      const matchRe = ae ? toRe(ae.match) : null;
      const extractRe = ae ? toRe(ae.extract) : null;
      if (!ae || !matchRe || !extractRe || typeof ae.pageSelector !== 'string' || !ae.pageSelector) return { state: 'unknown', evidence: null };
      const text = clip(document.body ? document.body.innerText : '', 20000);
      if (matchRe.test(text)) return { state: 'applied', evidence: (extractRe.exec(text) || [''])[0] };
      if (document.querySelector(ae.pageSelector) || findDialog()) return { state: 'not_applied', evidence: null };
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
 * @property {{ rules: any }} [profile] the ATS profile (createEasyApplyDriver defaults to LinkedIn)
 */

/**
 * LinkedIn-bound driver (the pre-refactor entry point): the LinkedIn profile unless one is given.
 * @param {EasyApplyDriverDeps} deps
 */
export function createEasyApplyDriver(deps) {
  return createAssistedDriver({ ...deps, profile: deps.profile ?? LINKEDIN_PROFILE });
}

/**
 * ATS-agnostic assisted driver. A profile is required: there is no default rule set.
 * @param {EasyApplyDriverDeps & { profile: { rules: any } }} deps
 */
export function createAssistedDriver(deps) {
  if (!deps || !deps.profile || typeof deps.profile !== 'object' || !deps.profile.rules || typeof deps.profile.rules !== 'object') {
    throw new Error('assisted driver: a profile with rules is required');
  }
  const rules = JSON.parse(JSON.stringify(deps.profile.rules));
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
        functionDeclaration: PAGE_FUNCTION, objectId: g.result.objectId, arguments: [{ value: { ...req, rules } }],
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
    /**
     * Open a listbox prompt (Workday). The popup renders after this returns; listOptions/pickOption are
     * separate calls, with a short server-side wait between them.
     * @param {string} ref
     */
    async openListbox(ref) {
      await pace();
      const r = await call({ op: 'open_listbox', ref });
      await sleep(400);
      return r;
    },
    /** @returns {Promise<{ ok: boolean, reason?: string, options?: string[] }>} */
    listOptions() {
      return call({ op: 'list_options' });
    },
    /** @param {string} optionText */
    async pickOption(optionText) {
      await pace();
      const r = await call({ op: 'pick_option', optionText });
      await sleep(300);
      return r;
    },
    /**
     * The CDP target id of the tab this driver's session is attached to, read from Chrome (A12), or null.
     * @returns {Promise<string|null>}
     */
    async currentTargetId() {
      if (!sessionId) return null;
      try {
        const r = await deps.cdp.send('Target.getTargetInfo', {}, sessionId);
        return r && r.targetInfo && typeof r.targetInfo.targetId === 'string' ? r.targetInfo.targetId : null;
      } catch {
        return null;
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
