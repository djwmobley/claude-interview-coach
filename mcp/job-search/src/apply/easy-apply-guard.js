// @ts-check
/**
 * Assisted LinkedIn Easy Apply: pure decision tables (spec G1, G2, G3, G5, G7, G11).
 *
 * Operator decision 2026-10-04: a headless session fills a LinkedIn Easy Apply form in the scan Chrome and
 * STOPS at LinkedIn's own Review screen; Damian clicks Submit himself. Nothing in this flow may ever click
 * Submit. This module holds the rules that make that true, as pure functions with no imports and no
 * module-scope references, because src/apply/easy-apply-driver.js injects their SOURCE TEXT
 * (PAGE_GUARD_FUNCTIONS, via Function.prototype.toString) into the one Runtime.callFunctionOn that
 * resolves a ref, re-verifies it, and clicks it (G1: "resolve, re-verify, and click in ONE
 * Runtime.callFunctionOn"). The same functions are unit tested here in Node, so the page and the tests
 * evaluate identical code.
 *
 * Every function is a total classification: any input maps to a branch, and anything unrecognized lands
 * on the refusing branch (an unknown button name, an empty name, an ambiguous progress signal, a missing
 * descriptor). There is no allow-by-default path.
 *
 * Keep every function here self-contained: no imports, no closures over module constants (each function
 * re-declares the small constants it needs), because only the function bodies travel into the page.
 */

/**
 * @typedef {Object} ButtonDescriptor
 * @property {string} tag lowercase tag name
 * @property {boolean} inDialog true when the element is inside the Easy Apply dialog
 * @property {boolean} disabled
 * @property {string} ariaLabel
 * @property {string} labelledByText text of every aria-labelledby target, joined
 * @property {string} visibleText innerText (rendered text only)
 * @property {string} textContent every text node, hidden spans included
 * @property {string} title
 * @property {string} value the element's value attribute
 * @property {Array<[string, string]>} dataAttrs every data-* attribute as [name, value]
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
 * G1 canonical kinds (amended rule A1, post spec-adversary): every non-empty name source must normalize to
 * a member of ONE kind's set, and all sources must agree on that kind. Frozen.
 */
export const ADVANCE_KINDS = Object.freeze({
  next: Object.freeze(['next', 'continue', 'continue to next step']),
  review: Object.freeze(['review', 'review your application']),
});

/** Every name accepted by some kind (derived from ADVANCE_KINDS). */
export const ADVANCE_ALLOWED_NAMES = Object.freeze([...ADVANCE_KINDS.next, ...ADVANCE_KINDS.review]);

/** A2: deny on every name source (name, aria-label, labelledby text, innerText, textContent, title, value). */
export const DENY_NAME_RE = /submit|send|done|\bapply\b/i;

/** A3: deny on data-* attribute names AND values of the button, its descendants, and its ancestors up to
 * (not including) the dialog. The bare "easy-apply"/"apply" token no longer denies here. */
export const DENY_DATA_RE = /submit|send|done/i;

/**
 * A2 + A3: is this element submit-marked? Used both to refuse an advance click and (A3b) to decide whether
 * a Submit control is visible in the dialog. Total; a non-object is not marked (callers that need a click
 * verdict use classifyAdvanceButton, which refuses non-objects separately).
 * @param {{ ariaLabel?: string, labelledByText?: string, visibleText?: string, textContent?: string, title?: string, value?: string, dataAttrs?: Array<[string, string]> }|null|undefined} d
 * @returns {boolean}
 */
export function isSubmitMarked(d) {
  const nameDeny = /submit|send|done|\bapply\b/i;
  const dataDeny = /submit|send|done/i;
  const strip = (/** @type {string} */ s) => s.replace(/[​-‍⁠﻿]/g, '').normalize('NFKC');
  if (!d || typeof d !== 'object') return false;
  for (const s of [d.ariaLabel, d.labelledByText, d.visibleText, d.textContent, d.title, d.value]) {
    if (typeof s === 'string' && s && (nameDeny.test(s) || nameDeny.test(strip(s)))) return true;
  }
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
 *   1. not a descriptor or tag other than 'button' -> 'not_button'.
 *   2. not inside the Easy Apply dialog -> 'outside_dialog'.
 *   3. disabled -> 'disabled'.
 *   4. submit-marked (A2 on every name source, A3 on data-* names/values of the button, descendants, and
 *      ancestors up to the dialog) -> 'denied_term'. Deny overrides allow.
 *   5. every non-empty source among aria-labelledby text, aria-label, visible text must map to the SAME
 *      canonical kind (ADVANCE_KINDS); no source, an unmapped source, or a kind mismatch -> 'unknown_button'.
 * @param {ButtonDescriptor|null|undefined} d
 * @returns {{ ok: true, reason: null, name: string, kind: 'next'|'review' } | { ok: false, reason: 'not_button'|'outside_dialog'|'disabled'|'denied_term'|'unknown_button', name: string, kind: null }}
 */
export function classifyAdvanceButton(d) {
  const kinds = { next: ['next', 'continue', 'continue to next step'], review: ['review', 'review your application'] };
  const nameDeny = /submit|send|done|\bapply\b/i;
  const dataDeny = /submit|send|done/i;
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
  for (const pair of Array.isArray(d.dataAttrs) ? d.dataAttrs : []) {
    if (!Array.isArray(pair)) continue;
    for (const s of [String(pair[0] ?? ''), String(pair[1] ?? '')]) {
      if (s && (dataDeny.test(s) || dataDeny.test(strip(s)))) return { ok: false, reason: 'denied_term', name: norm(s), kind: null };
    }
  }
  const sources = [d.labelledByText, d.ariaLabel, d.visibleText].map(norm).filter((s) => s.length > 0);
  if (sources.length === 0) return { ok: false, reason: 'unknown_button', name: '', kind: null };
  /** @type {'next'|'review'|null} */
  let kind = null;
  for (const s of sources) {
    const k = kinds.next.includes(s) ? 'next' : kinds.review.includes(s) ? 'review' : null;
    if (!k || (kind && k !== kind)) return { ok: false, reason: 'unknown_button', name: s, kind: null };
    kind = k;
  }
  return { ok: true, reason: null, name: sources[0], kind: /** @type {'next'|'review'} */ (kind) };
}

/**
 * G2 terminal-step rule (consumes the CANONICAL kind from classifyAdvanceButton, amended A1): advance is
 * allowed only with a POSITIVE not-last-step signal. Total:
 *   - a Submit control visible anywhere in the dialog -> terminal (G3 territory, never click);
 *   - kind 'review' -> ok (it leads to LinkedIn's distinct Review screen);
 *   - kind 'next' -> ok ONLY when every progress value read from the dialog is a finite number, they all
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
 * Classify the page state around the Easy Apply dialog. Total, first match wins:
 *   1. 'sent'      -- an "application sent/submitted" confirmation anywhere (G5: unexpected_submit).
 *   2. 'challenge' -- a CAPTCHA/security check, "unusual activity", a login/authwall/checkpoint URL, or a
 *                     429 / too-many-requests page (G11: the circuit breaker trips).
 *   3. 'no_dialog' -- no Easy Apply dialog on the page.
 *   4. 'review'    -- a "Review your application" header AND a visible Submit control (G3: no clicks).
 *   5. 'submit_visible' -- a visible Submit control without the header (terminal: no clicks).
 *   6. 'form'      -- anything else inside the dialog.
 * `submitVisible` is computed by the caller with the A2+A3 scans (isSubmitMarked) over every visible dialog
 * button plus any visible dialog element carrying a submit-marked data-* attribute (amended A3b), never
 * from button names alone.
 * @param {{ dialogPresent: boolean, headerTexts: string[], submitVisible: boolean, dialogText: string, pageText: string, url: string }} s
 * @returns {{ kind: 'sent'|'challenge'|'no_dialog'|'review'|'submit_visible'|'form' }}
 */
export function classifyStep(s) {
  const sentRe = /application (?:was )?sent|application submitted|your application was submitted/i;
  const challengeTextRe = /unusual activity|security (?:check|verification)|captcha|verify (?:you(?:'re| are) (?:a )?human|your identity)|too many requests|\b429\b|sign in to continue|please sign in/i;
  const challengeUrlRe = /\/(?:checkpoint|authwall|uas\/login|login)(?:[/?#]|$)|[?&]captcha/i;
  const reviewHeaderRe = /review your application/i;
  if (!s || typeof s !== 'object') return { kind: 'no_dialog' };
  const dialogText = typeof s.dialogText === 'string' ? s.dialogText : '';
  const pageText = typeof s.pageText === 'string' ? s.pageText : '';
  const url = typeof s.url === 'string' ? s.url : '';
  if (sentRe.test(dialogText) || sentRe.test(pageText)) return { kind: 'sent' };
  if (challengeUrlRe.test(url) || challengeTextRe.test(pageText) || challengeTextRe.test(dialogText)) return { kind: 'challenge' };
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
 * "a (1).docx" rename is a mismatch, never a pass).
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

/** The functions the driver injects into the page by source text (see the module doc comment). */
export const PAGE_GUARD_FUNCTIONS = Object.freeze([normalizeName, isSubmitMarked, classifyAdvanceButton, checkNotLastStep, classifyStep, verifyResumeCards]);
