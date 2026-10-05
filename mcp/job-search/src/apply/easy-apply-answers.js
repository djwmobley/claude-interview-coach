// @ts-check
/**
 * Assisted LinkedIn Easy Apply: LinkedIn-bound answer resolution (spec G6). The implementation moved to
 * src/apply/assisted/answers.js, where the contact-label map comes from the ATS profile (spec v1 clause 4).
 * This module keeps the LinkedIn API for existing callers and tests: resolveFieldAnswer here always uses
 * LinkedIn's contact labels (src/apply/assisted/profiles/linkedin.js), so the decisions are identical
 * (pinned by test/assisted-apply-golden.test.js).
 */
import { resolveFieldAnswer as resolveWithProfile, sanitizeValue } from './assisted/answers.js';
import { LINKEDIN_CONTACT_LABELS } from './assisted/profiles/linkedin.js';

/** @typedef {import('./assisted/answers.js').FieldAnswer} FieldAnswer */

export { sanitizeValue };

/** Exact normalized LinkedIn contact-field labels -> contact fact keys in the answer bank. */
export const CONTACT_LABELS = LINKEDIN_CONTACT_LABELS;

/**
 * @param {{ question: string, kind: string, required: boolean, options: string[] }} field
 * @param {{ bank: import('./answers.js').AnswerBank, accountEmail: string|null }} ctx
 * @returns {FieldAnswer}
 */
export function resolveFieldAnswer(field, ctx) {
  return resolveWithProfile(field, { bank: ctx.bank, accountEmail: ctx.accountEmail, contactLabels: LINKEDIN_CONTACT_LABELS });
}
