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

/** G1 allow set: the normalized accessible name must be EXACTLY one of these. Frozen. */
export const ADVANCE_ALLOWED_NAMES = Object.freeze(['next', 'continue', 'review', 'review your application']);

/** G1 deny rule, checked against every name source and every data-* attribute name and value. Deny
 * overrides allow. */
export const DENY_RE = /submit|send|done|apply/i;

/**
 * G1: may this element be clicked as an "advance" button? Total: every input maps to ok:true or a closed
 * refusal reason. Every refusal reason is a stop for the session (the caller never retries a refused
 * click). Rules, in order:
 *   1. not a descriptor -> 'not_button'; tag other than 'button' -> 'not_button' (an <input type=submit>,
 *      a link, a div with role=button are all refused).
 *   2. not inside the Easy Apply dialog -> 'outside_dialog'.
 *   3. disabled -> 'disabled'.
 *   4. any of name, aria-label, aria-labelledby text, innerText, textContent (hidden spans included),
 *      title, value, or any data-* attribute name or value matches DENY_RE -> 'denied_term'. This runs
 *      BEFORE the allow check: deny overrides allow.
 *   5. every non-empty name source (aria-labelledby text, aria-label, visible text) must normalize to a
 *      member of ADVANCE_ALLOWED_NAMES; no non-empty source at all, or any source outside the set (which
 *      covers an aria-label vs text mismatch) -> 'unknown_button'.
 * @param {ButtonDescriptor|null|undefined} d
 * @returns {{ ok: true, reason: null, name: string } | { ok: false, reason: 'not_button'|'outside_dialog'|'disabled'|'denied_term'|'unknown_button', name: string }}
 */
export function classifyAdvanceButton(d) {
  const allowed = ['next', 'continue', 'review', 'review your application'];
  const deny = /submit|send|done|apply/i;
  const norm = (/** @type {unknown} */ s) => (typeof s !== 'string' ? '' : s.normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/[\s.,;:!?…>›→»]+$/g, '')
    .trim());
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not_button', name: '' };
  if (d.tag !== 'button') return { ok: false, reason: 'not_button', name: '' };
  if (!d.inDialog) return { ok: false, reason: 'outside_dialog', name: '' };
  if (d.disabled) return { ok: false, reason: 'disabled', name: '' };
  const strings = [d.ariaLabel, d.labelledByText, d.visibleText, d.textContent, d.title, d.value];
  const dataAttrs = Array.isArray(d.dataAttrs) ? d.dataAttrs : [];
  for (const pair of dataAttrs) {
    if (Array.isArray(pair)) {
      strings.push(String(pair[0] ?? ''));
      strings.push(String(pair[1] ?? ''));
    }
  }
  for (const s of strings) {
    if (typeof s !== 'string' || !s) continue;
    const stripped = s.replace(/[​-‍⁠﻿]/g, '');
    if (deny.test(s) || deny.test(stripped) || deny.test(norm(s))) return { ok: false, reason: 'denied_term', name: norm(s) };
  }
  const sources = [d.labelledByText, d.ariaLabel, d.visibleText].map(norm).filter((s) => s.length > 0);
  if (sources.length === 0) return { ok: false, reason: 'unknown_button', name: '' };
  for (const s of sources) {
    if (!allowed.includes(s)) return { ok: false, reason: 'unknown_button', name: s };
  }
  return { ok: true, reason: null, name: sources[0] };
}

/**
 * G2 terminal-step rule: advance is allowed only with a POSITIVE not-last-step signal. Total:
 *   - a visible Submit-shaped button anywhere in the dialog -> terminal (G3 territory, never click);
 *   - 'review' / 'review your application' -> ok (it leads to LinkedIn's distinct Review screen);
 *   - 'next' / 'continue' -> ok ONLY when every progress value read from the dialog is a finite number,
 *     they all agree (spread of at most 1 point), and the value is below 100;
 *   - anything else (no progress signal, progress at or above 100, disagreeing or NaN values, an unknown
 *     button name) -> terminal.
 * A terminal verdict never clicks; the caller stops with uncertain_last_step.
 * @param {{ buttonName: string, progressValues: number[], submitVisible: boolean }} input
 * @returns {{ ok: true, reason: 'progress_below_100'|'review_button' } | { ok: false, reason: 'uncertain_last_step' }}
 */
export function checkNotLastStep(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'uncertain_last_step' };
  if (input.submitVisible) return { ok: false, reason: 'uncertain_last_step' };
  const name = typeof input.buttonName === 'string' ? input.buttonName : '';
  if (name === 'review' || name === 'review your application') return { ok: true, reason: 'review_button' };
  if (name !== 'next' && name !== 'continue') return { ok: false, reason: 'uncertain_last_step' };
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
 *   4. 'review'    -- a "Review your application" header AND a Submit-shaped button (G3: no further clicks).
 *   5. 'submit_visible' -- a Submit-shaped button without the header (treated as terminal: no clicks).
 *   6. 'form'      -- anything else inside the dialog.
 * @param {{ dialogPresent: boolean, headerTexts: string[], buttonNames: string[], dialogText: string, pageText: string, url: string }} s
 * @returns {{ kind: 'sent'|'challenge'|'no_dialog'|'review'|'submit_visible'|'form' }}
 */
export function classifyStep(s) {
  const sentRe = /application (?:was )?sent|application submitted|your application was submitted/i;
  const challengeTextRe = /unusual activity|security (?:check|verification)|captcha|verify (?:you(?:'re| are) (?:a )?human|your identity)|too many requests|\b429\b|sign in to continue|please sign in/i;
  const challengeUrlRe = /\/(?:checkpoint|authwall|uas\/login|login)(?:[/?#]|$)|[?&]captcha/i;
  const submitRe = /submit/i;
  const reviewHeaderRe = /review your application/i;
  if (!s || typeof s !== 'object') return { kind: 'no_dialog' };
  const dialogText = typeof s.dialogText === 'string' ? s.dialogText : '';
  const pageText = typeof s.pageText === 'string' ? s.pageText : '';
  const url = typeof s.url === 'string' ? s.url : '';
  if (sentRe.test(dialogText) || sentRe.test(pageText)) return { kind: 'sent' };
  if (challengeUrlRe.test(url) || challengeTextRe.test(pageText) || challengeTextRe.test(dialogText)) return { kind: 'challenge' };
  if (!s.dialogPresent) return { kind: 'no_dialog' };
  const names = Array.isArray(s.buttonNames) ? s.buttonNames : [];
  const submitVisible = names.some((n) => typeof n === 'string' && submitRe.test(n));
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
export const PAGE_GUARD_FUNCTIONS = Object.freeze([normalizeName, classifyAdvanceButton, checkNotLastStep, classifyStep, verifyResumeCards]);
