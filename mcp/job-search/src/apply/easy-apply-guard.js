// @ts-check
/**
 * Assisted LinkedIn Easy Apply: LinkedIn-bound guard exports (spec G1, G2, G3, G5, G7, G11).
 *
 * Operator decision 2026-10-04: a headless session fills a LinkedIn Easy Apply form in the scan Chrome and
 * STOPS at LinkedIn's own Review screen; Damian clicks Submit himself. Nothing in this flow may ever click
 * Submit.
 *
 * The rule-parameterized implementations now live in src/apply/assisted/guard.js (the ATS-agnostic
 * assisted driver; spec v1 clause 1) and LinkedIn's rules are data in
 * src/apply/assisted/profiles/linkedin.js. This module keeps the one-argument LinkedIn API and the
 * LinkedIn constants for existing callers and tests; each wrapper passes the LinkedIn rules, so the
 * decisions are identical (pinned by test/assisted-apply-golden.test.js). PAGE_GUARD_FUNCTIONS is the
 * rule-parameterized set the driver injects into the page; the driver supplies the rules as req.rules.
 */
import * as core from './assisted/guard.js';
import { LINKEDIN_RULES } from './assisted/profiles/linkedin.js';

/** @typedef {import('./assisted/guard.js').ButtonDescriptor} ButtonDescriptor */

/** @param {{ source: string, flags?: string }} spec */
const toRegExp = (spec) => new RegExp(spec.source, spec.flags ?? '');

export const normalizeName = core.normalizeName;
export const checkNotLastStep = core.checkNotLastStep;
export const verifyResumeCards = core.verifyResumeCards;

/** G1 canonical kinds (amended rule A1): LinkedIn's advance kinds. Frozen. */
export const ADVANCE_KINDS = Object.freeze({
  next: LINKEDIN_RULES.advanceKinds.next,
  review: LINKEDIN_RULES.advanceKinds.review,
});

/** Every name accepted by some kind (derived from ADVANCE_KINDS). */
export const ADVANCE_ALLOWED_NAMES = Object.freeze([...ADVANCE_KINDS.next, ...ADVANCE_KINDS.review]);

/** A2: deny on every name source (name, aria-label, labelledby text, innerText, textContent, title, value). */
export const DENY_NAME_RE = toRegExp(LINKEDIN_RULES.nameDeny);

/** A3: deny on data-* attribute names AND values of the button, its descendants, and its ancestors up to
 * (not including) the dialog. The bare "easy-apply"/"apply" token no longer denies here. */
export const DENY_DATA_RE = toRegExp(LINKEDIN_RULES.dataDeny);

/**
 * A2 + A3 under LinkedIn's rules. See src/apply/assisted/guard.js isSubmitMarked.
 * @param {Parameters<typeof core.isSubmitMarked>[0]} d
 */
export function isSubmitMarked(d) {
  return core.isSubmitMarked(d, LINKEDIN_RULES);
}

/**
 * G1 under LinkedIn's rules. See src/apply/assisted/guard.js classifyAdvanceButton.
 * @param {ButtonDescriptor|null|undefined} d
 * @returns {{ ok: true, reason: null, name: string, kind: 'next'|'review' } | { ok: false, reason: 'not_button'|'outside_dialog'|'disabled'|'denied_term'|'unknown_button', name: string, kind: null }}
 */
export function classifyAdvanceButton(d) {
  return /** @type {any} */ (core.classifyAdvanceButton(d, LINKEDIN_RULES));
}

/**
 * Step classification under LinkedIn's rules. See src/apply/assisted/guard.js classifyStep.
 * @param {Parameters<typeof core.classifyStep>[0]} s
 */
export function classifyStep(s) {
  return core.classifyStep(s, LINKEDIN_RULES);
}

/** The functions the driver injects into the page by source text (rule-parameterized; see above). */
export const PAGE_GUARD_FUNCTIONS = core.PAGE_GUARD_FUNCTIONS;
