// @ts-check
/**
 * Assisted apply: pure page-side decision tables, parameterized by an ATS profile's rules (spec v1
 * clause 1: "Rules pass into the page function as req.rules so one page function remains").
 *
 * Nothing in the assisted flow may ever click Submit. These functions hold the rules that make that true.
 * They have no imports and no module-scope references because src/apply/easy-apply-driver.js injects
 * their SOURCE TEXT (PAGE_GUARD_FUNCTIONS, via Function.prototype.toString) into the one
 * Runtime.callFunctionOn that resolves a ref, re-verifies it, and clicks it. The rules object `R` arrives
 * as plain JSON data (regexes as { source, flags } pairs; see src/apply/assisted/profiles/linkedin.js), so
 * each function compiles what it needs locally.
 *
 * Every function is a total classification: any input maps to a branch, and anything unrecognized lands
 * on the refusing branch. Missing or malformed rules are themselves a refusing branch (fail closed): no
 * advance verdict, everything submit-marked, and no step that permits a click or a finish.
 *
 * src/apply/easy-apply-guard.js keeps the LinkedIn-bound, one-argument exports the rest of the codebase
 * and the existing tests use.
 */

/**
 * @typedef {Object} ButtonDescriptor
 * @property {string} tag lowercase tag name
 * @property {boolean} inDialog true when the element is inside the form scope (the Easy Apply dialog)
 * @property {boolean} disabled
 * @property {string} ariaLabel
 * @property {string} labelledByText text of every aria-labelledby target, joined
 * @property {string} visibleText innerText (rendered text only)
 * @property {string} textContent every text node, hidden spans included
 * @property {string} title
 * @property {string} value the element's value attribute
 * @property {Array<[string, string]>} dataAttrs every data-* attribute as [name, value]
 * @property {string} [id] the element's id attribute (checked with the data-* deny pattern, v2 A1)
 */

/**
 * @typedef {{ source: string, flags?: string }} RegexSpec
 * @typedef {Object} AssistedRules
 * @property {Record<string, string[]>} advanceKinds canonical kind -> normalized names
 * @property {RegexSpec} nameDeny
 * @property {RegexSpec} dataDeny
 * @property {RegexSpec} sent
 * @property {RegexSpec} challengeText
 * @property {RegexSpec} challengeUrl
 * @property {RegexSpec} reviewHeader
 */

/**
 * The one pinned normalization for button names: Unicode NFKC, zero-width characters removed, every
 * whitespace run (non-breaking included) collapsed to one space, lowercased, trimmed, and trailing
 * punctuation or arrow glyphs stripped. Exact comparisons only ever happen after this transform.
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeName(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/[\s.,;:!?…>›→»]+$/g, '')
    .trim();
}

/**
 * A2 + A3: is this element submit-marked under the profile's deny rules? Used both to refuse an advance
 * click and (A3b) to decide whether a Submit control is visible. Total; a non-object is not marked.
 * Unusable rules mark everything (fail closed: a visible Submit means no clicks).
 * @param {{ ariaLabel?: string, labelledByText?: string, visibleText?: string, textContent?: string, title?: string, value?: string, dataAttrs?: Array<[string, string]>, id?: string }|null|undefined} d
 * @param {AssistedRules|null|undefined} R
 * @returns {boolean}
 */
export function isSubmitMarked(d, R) {
  const rx = (/** @type {any} */ spec) => {
    if (!spec || typeof spec !== 'object' || typeof spec.source !== 'string' || !spec.source) return null;
    try {
      return new RegExp(spec.source, typeof spec.flags === 'string' ? spec.flags : '');
    } catch {
      return null;
    }
  };
  const nameDeny = R && typeof R === 'object' ? rx(R.nameDeny) : null;
  const dataDeny = R && typeof R === 'object' ? rx(R.dataDeny) : null;
  if (!nameDeny || !dataDeny) return true;
  const strip = (/** @type {string} */ s) => s.replace(/[​-‍⁠﻿]/g, '').normalize('NFKC');
  if (!d || typeof d !== 'object') return false;
  for (const s of [d.ariaLabel, d.labelledByText, d.visibleText, d.textContent, d.title, d.value]) {
    if (typeof s === 'string' && s && (nameDeny.test(s) || nameDeny.test(strip(s)))) return true;
  }
  if (typeof d.id === 'string' && d.id && (dataDeny.test(d.id) || dataDeny.test(strip(d.id)))) return true;
  const attrs = Array.isArray(d.dataAttrs) ? d.dataAttrs : [];
  for (const pair of attrs) {
    if (!Array.isArray(pair)) continue;
    for (const s of [String(pair[0] ?? ''), String(pair[1] ?? '')]) {
      if (s && (dataDeny.test(s) || dataDeny.test(strip(s)))) return true;
    }
  }
  return false;
}

/**
 * G1 (amended A1-A3): may this element be clicked as an "advance" button? Total; every refusal stops the
 * session. Rules, in order:
 *   0. unusable rules -> 'unknown_button' (fail closed).
 *   1. not a descriptor or tag other than 'button' -> 'not_button'.
 *   2. not inside the form scope -> 'outside_dialog'.
 *   3. disabled -> 'disabled'.
 *   4. submit-marked (R.nameDeny on every name source, R.dataDeny on data-* names/values of the button,
 *      descendants, and ancestors up to the scope) -> 'denied_term'. Deny overrides allow.
 *   5. every non-empty source among aria-labelledby text, aria-label, visible text must map to the SAME
 *      canonical kind (R.advanceKinds, checked in key order); no source, an unmapped source, or a kind
 *      mismatch -> 'unknown_button'.
 * @param {ButtonDescriptor|null|undefined} d
 * @param {AssistedRules|null|undefined} R
 * @returns {{ ok: true, reason: null, name: string, kind: string } | { ok: false, reason: 'not_button'|'outside_dialog'|'disabled'|'denied_term'|'unknown_button', name: string, kind: null }}
 */
export function classifyAdvanceButton(d, R) {
  const rx = (/** @type {any} */ spec) => {
    if (!spec || typeof spec !== 'object' || typeof spec.source !== 'string' || !spec.source) return null;
    try {
      return new RegExp(spec.source, typeof spec.flags === 'string' ? spec.flags : '');
    } catch {
      return null;
    }
  };
  const rulesOk = Boolean(R && typeof R === 'object');
  const nameDeny = rulesOk ? rx(/** @type {any} */ (R).nameDeny) : null;
  const dataDeny = rulesOk ? rx(/** @type {any} */ (R).dataDeny) : null;
  const rawKinds = rulesOk ? /** @type {any} */ (R).advanceKinds : null;
  /** @type {Array<[string, string[]]>} */
  const kinds = rawKinds && typeof rawKinds === 'object' && !Array.isArray(rawKinds)
    ? Object.keys(rawKinds).filter((k) => Array.isArray(rawKinds[k])).map((k) => [k, rawKinds[k].filter((/** @type {unknown} */ n) => typeof n === 'string')])
    : [];
  if (!nameDeny || !dataDeny || kinds.length === 0) return { ok: false, reason: 'unknown_button', name: '', kind: null };
  const strip = (/** @type {string} */ s) => s.replace(/[​-‍⁠﻿]/g, '').normalize('NFKC');
  const norm = (/** @type {unknown} */ s) => (typeof s !== 'string' ? '' : s.normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/[\s.,;:!?…>›→»]+$/g, '')
    .trim());
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not_button', name: '', kind: null };
  if (d.tag !== 'button') return { ok: false, reason: 'not_button', name: '', kind: null };
  if (!d.inDialog) return { ok: false, reason: 'outside_dialog', name: '', kind: null };
  if (d.disabled) return { ok: false, reason: 'disabled', name: '', kind: null };
  for (const s of [d.ariaLabel, d.labelledByText, d.visibleText, d.textContent, d.title, d.value]) {
    if (typeof s === 'string' && s && (nameDeny.test(s) || nameDeny.test(strip(s)))) return { ok: false, reason: 'denied_term', name: norm(s), kind: null };
  }
  if (typeof d.id === 'string' && d.id && (dataDeny.test(d.id) || dataDeny.test(strip(d.id)))) return { ok: false, reason: 'denied_term', name: norm(d.id), kind: null };
  for (const pair of Array.isArray(d.dataAttrs) ? d.dataAttrs : []) {
    if (!Array.isArray(pair)) continue;
    for (const s of [String(pair[0] ?? ''), String(pair[1] ?? '')]) {
      if (s && (dataDeny.test(s) || dataDeny.test(strip(s)))) return { ok: false, reason: 'denied_term', name: norm(s), kind: null };
    }
  }
  const sources = [d.labelledByText, d.ariaLabel, d.visibleText].map(norm).filter((s) => s.length > 0);
  if (sources.length === 0) return { ok: false, reason: 'unknown_button', name: '', kind: null };
  /** @type {string|null} */
  let kind = null;
  for (const s of sources) {
    const hit = kinds.find(([, names]) => names.includes(s));
    const k = hit ? hit[0] : null;
    if (!k || (kind && k !== kind)) return { ok: false, reason: 'unknown_button', name: s, kind: null };
    kind = k;
  }
  return { ok: true, reason: null, name: sources[0], kind: /** @type {string} */ (kind) };
}

/**
 * G2 terminal-step rule (consumes the CANONICAL kind from classifyAdvanceButton, amended A1): advance is
 * allowed only with a POSITIVE not-last-step signal. Rule-free (the kinds' meaning is fixed). Total:
 *   - a Submit control visible anywhere in the scope -> terminal (G3 territory, never click);
 *   - kind 'review' -> ok (it leads to a distinct Review screen);
 *   - kind 'next' -> ok ONLY when every progress value read from the scope is a finite number, they all
 *     agree (spread of at most 1 point), and the value is below 100;
 *   - anything else (no progress signal, progress at or above 100, disagreeing or NaN values, no kind) ->
 *     terminal. A terminal verdict never clicks; the caller stops with uncertain_last_step.
 * @param {{ buttonKind: 'next'|'review'|null|string, progressValues: number[], submitVisible: boolean }} input
 * @returns {{ ok: true, reason: 'progress_below_100'|'review_button' } | { ok: false, reason: 'uncertain_last_step' }}
 */
export function checkNotLastStep(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'uncertain_last_step' };
  if (input.submitVisible) return { ok: false, reason: 'uncertain_last_step' };
  if (input.buttonKind === 'review') return { ok: true, reason: 'review_button' };
  if (input.buttonKind !== 'next') return { ok: false, reason: 'uncertain_last_step' };
  const values = Array.isArray(input.progressValues) ? input.progressValues : [];
  if (values.length === 0) return { ok: false, reason: 'uncertain_last_step' };
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: 'uncertain_last_step' };
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi - lo > 1) return { ok: false, reason: 'uncertain_last_step' };
  if (hi >= 100 || lo < 0) return { ok: false, reason: 'uncertain_last_step' };
  return { ok: true, reason: 'progress_below_100' };
}

/**
 * Classify the page state around the form scope. Total, first match wins:
 *   0. unusable rules -> 'submit_visible' (fail closed: no clicks, no finish). The optional rules
 *      (alreadyApplied, sessionTimeout, authLost.text) are skipped when ABSENT and fail closed the same
 *      way when present but malformed.
 *   1. 'sent'      -- R.sent anywhere (G5: unexpected_submit).
 *   2. 'challenge' -- R.challengeText in page or scope text, or R.challengeUrl on the URL (G11).
 *   3. 'already_applied' -- R.alreadyApplied in page or scope text (v2 A10).
 *   4. 'session_timeout' -- R.sessionTimeout in page or scope text (v2 A11).
 *   5. 'auth_lost' -- a sign-in/create-account panel on the page (s.authGatePresent) or R.authLost.text.
 *   6. 'password_field' -- a password-like input anywhere on the page (v2 A7: the session stops).
 *   7. 'no_dialog' -- no form scope on the page.
 *   8. 'review'    -- an R.reviewHeader header AND a visible Submit control (G3: no clicks).
 *   9. 'submit_visible' -- a visible Submit control without the header (terminal: no clicks).
 *  10. 'form'      -- anything else inside the scope.
 * `submitVisible` is computed by the caller with isSubmitMarked over every visible scope button plus any
 * visible scope element carrying a submit-marked data-* attribute (amended A3b).
 * @param {{ dialogPresent: boolean, headerTexts: string[], submitVisible: boolean, dialogText: string, pageText: string, url: string, authGatePresent?: boolean, passwordPresent?: boolean }} s
 * @param {AssistedRules|null|undefined} R
 * @returns {{ kind: 'sent'|'challenge'|'already_applied'|'session_timeout'|'auth_lost'|'password_field'|'no_dialog'|'review'|'submit_visible'|'form' }}
 */
export function classifyStep(s, R) {
  const rx = (/** @type {any} */ spec) => {
    if (!spec || typeof spec !== 'object' || typeof spec.source !== 'string' || !spec.source) return null;
    try {
      return new RegExp(spec.source, typeof spec.flags === 'string' ? spec.flags : '');
    } catch {
      return null;
    }
  };
  const rulesOk = Boolean(R && typeof R === 'object');
  const sentRe = rulesOk ? rx(/** @type {any} */ (R).sent) : null;
  const challengeTextRe = rulesOk ? rx(/** @type {any} */ (R).challengeText) : null;
  const challengeUrlRe = rulesOk ? rx(/** @type {any} */ (R).challengeUrl) : null;
  const reviewHeaderRe = rulesOk ? rx(/** @type {any} */ (R).reviewHeader) : null;
  if (!sentRe || !challengeTextRe || !challengeUrlRe || !reviewHeaderRe) return { kind: 'submit_visible' };
  const anyR = /** @type {any} */ (R);
  /** Optional rule: undefined when absent, null when present but unusable (fail closed). */
  const opt = (/** @type {any} */ spec) => (spec === undefined ? undefined : rx(spec));
  const alreadyRe = opt(anyR.alreadyApplied);
  const timeoutRe = opt(anyR.sessionTimeout);
  const authText = anyR.authLost === undefined ? undefined : (anyR.authLost && typeof anyR.authLost === 'object' ? rx(anyR.authLost.text) : null);
  if (alreadyRe === null || timeoutRe === null || authText === null) return { kind: 'submit_visible' };
  if (!s || typeof s !== 'object') return { kind: 'no_dialog' };
  const dialogText = typeof s.dialogText === 'string' ? s.dialogText : '';
  const pageText = typeof s.pageText === 'string' ? s.pageText : '';
  const url = typeof s.url === 'string' ? s.url : '';
  if (sentRe.test(dialogText) || sentRe.test(pageText)) return { kind: 'sent' };
  if (challengeUrlRe.test(url) || challengeTextRe.test(pageText) || challengeTextRe.test(dialogText)) return { kind: 'challenge' };
  if (alreadyRe && (alreadyRe.test(pageText) || alreadyRe.test(dialogText))) return { kind: 'already_applied' };
  if (timeoutRe && (timeoutRe.test(pageText) || timeoutRe.test(dialogText))) return { kind: 'session_timeout' };
  if (s.authGatePresent === true || (authText && (authText.test(pageText) || authText.test(dialogText)))) return { kind: 'auth_lost' };
  if (s.passwordPresent === true) return { kind: 'password_field' };
  if (!s.dialogPresent) return { kind: 'no_dialog' };
  const submitVisible = s.submitVisible === true;
  const headers = Array.isArray(s.headerTexts) ? s.headerTexts : [];
  const reviewHeader = headers.some((h) => typeof h === 'string' && reviewHeaderRe.test(h));
  if (reviewHeader && submitVisible) return { kind: 'review' };
  if (submitVisible) return { kind: 'submit_visible' };
  return { kind: 'form' };
}

/**
 * G7: after upload (and again at finish), exactly one resume card is selected and it is the uploaded
 * file, compared by exact name after whitespace collapse only (no fuzzy or prefix matching: LinkedIn's
 * "a (1).docx" rename is a mismatch, never a pass). Rule-free.
 * @param {Array<{ name: string, selected: boolean }>} cards
 * @param {string} expectedName
 * @returns {{ ok: boolean, reason: null|'uploaded_not_found'|'uploaded_not_selected'|'multiple_selected' }}
 */
export function verifyResumeCards(cards, expectedName) {
  const clean = (/** @type {unknown} */ s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const list = Array.isArray(cards) ? cards : [];
  const want = clean(expectedName);
  const selected = list.filter((c) => c && c.selected);
  if (selected.length > 1) return { ok: false, reason: 'multiple_selected' };
  const mine = list.filter((c) => c && clean(c.name) === want);
  if (!want || mine.length === 0) return { ok: false, reason: 'uploaded_not_found' };
  if (selected.length === 0 || clean(selected[0].name) !== want) return { ok: false, reason: 'uploaded_not_selected' };
  return { ok: true, reason: null };
}

/**
 * Step-bar progress (Workday, spec v1 clause 3, v2 A2): turn the visible step labels and the active step
 * into the progress value checkNotLastStep consumes. Rule-free and total:
 *   - no labels -> [] (no progress signal: terminal);
 *   - one label -> [100] (the only step is the last one: terminal);
 *   - a readable active index (an integer inside the label list) -> 100 on the last step, otherwise a
 *     value strictly below 100;
 *   - no readable active index (A2 fallback) -> the page header must equal exactly one step label after
 *     the same normalization; that label's position decides as above. No match, or two or more matches,
 *     -> [] (uncertain_last_step). So Next is only ever allowed with a FOLLOWING step label visible.
 * @param {{ labels: string[], active: number|null, headerTexts: string[] }} input
 * @returns {number[]}
 */
export function stepBarProgress(input) {
  const norm = (/** @type {unknown} */ s) => (typeof s !== 'string' ? '' : s.normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/^(?:(?:current|completed) )?step \d+ of \d+\s*/g, '')
    .replace(/[\s.,;:!?…>›→»*]+$/g, '')
    .trim());
  if (!input || typeof input !== 'object') return [];
  const labels = Array.isArray(input.labels) ? input.labels.map(norm) : [];
  const n = labels.length;
  if (n === 0) return [];
  if (n === 1) return [100];
  const at = (/** @type {number} */ i) => (i >= n - 1 ? 100 : Math.floor((i * 100) / (n - 1)));
  if (Number.isInteger(input.active) && /** @type {number} */ (input.active) >= 0 && /** @type {number} */ (input.active) < n) return [at(/** @type {number} */ (input.active))];
  const headers = (Array.isArray(input.headerTexts) ? input.headerTexts : []).map(norm).filter((h) => h.length > 0);
  const hits = labels.map((l, i) => (l && headers.includes(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) return [];
  return [at(hits[0])];
}

/** The functions the driver injects into the page by source text (see the module doc comment). */
export const PAGE_GUARD_FUNCTIONS = Object.freeze([normalizeName, isSubmitMarked, classifyAdvanceButton, checkNotLastStep, classifyStep, verifyResumeCards, stepBarProgress]);
