// @ts-check
/**
 * Assisted apply field policy (spec v1 clause 4, v2 A3, A5, A6): the server-side checks that run on a
 * field BEFORE and AFTER src/apply/assisted/answers.js resolves its value, driven by the ATS profile. The
 * model never chooses a bank key or a value: the bank key comes from the field's own label text here, and
 * every refusal parks the application for a human.
 *
 * A profile without a given policy key skips that check (LinkedIn has none of them, so its behavior is
 * unchanged); a profile that HAS a key but carries an unusable regex fails closed (park).
 */
import { normalizeText } from '../answers.js';

/** @param {any} spec @returns {RegExp|null|undefined} undefined when absent, null when unusable */
function rx(spec) {
  if (spec === undefined) return undefined;
  if (!spec || typeof spec !== 'object' || typeof spec.source !== 'string' || !spec.source) return null;
  try {
    return new RegExp(spec.source, typeof spec.flags === 'string' ? spec.flags : '');
  } catch {
    return null;
  }
}

/**
 * The question text used for matching: trailing required markers stripped when the profile asks for it.
 * @param {unknown} question
 * @param {any} profile
 */
export function matchQuestion(question, profile) {
  const q = typeof question === 'string' ? question : '';
  return profile && profile.stripRequiredMark ? q.replace(/[\s*]+$/g, '').trim() : q;
}

/** Field kinds the server can fill. 'listbox' is a Workday prompt (button + popup option list). */
export const FILLABLE_KINDS = Object.freeze(['text', 'textarea', 'select', 'radio', 'checkbox', 'listbox']);

/**
 * Before resolution. Total, first match wins:
 *   1. label policy (A6): longer than maxLength -> park 'label_too_long'; an instruction-like phrase ->
 *      park 'label_instruction_like'; an unusable injection regex -> park 'label_policy_unusable'.
 *   2. a kind the server cannot fill (a multiselect prompt, a custom widget):
 *      - the site already filled it: in a sensitive class -> park 'sensitive_prefilled_unsupported'; else,
 *        when the profile accepts prefilled values -> 'leave_prefilled' (left as is, listed on the card);
 *      - required and the profile parks those -> park 'unsupported_required_field';
 *      - otherwise 'resolve' (the tool refuses it as not a form field).
 *   3. consent / attestation / e-signature label (A3): resolve ONLY when the bank has an exact LEARNED
 *      label for it; otherwise park 'consent_requires_bank_key' (required or not). Unusable regex -> park.
 *   4. otherwise 'resolve'.
 * @param {{ question: string, kind: string, required: boolean, filled?: boolean }} field
 * @param {{ profile: any, bank: import('../answers.js').AnswerBank }} ctx
 * @returns {{ action: 'resolve'|'leave_prefilled', question: string } | { action: 'park', reason: string, question: string }}
 */
export function preResolvePolicy(field, ctx) {
  const profile = ctx.profile ?? {};
  const question = matchQuestion(field?.question, profile);
  const lp = profile.labelPolicy;
  if (lp !== undefined) {
    const max = lp && typeof lp === 'object' && Number.isInteger(lp.maxLength) ? lp.maxLength : null;
    const inj = rx(lp && typeof lp === 'object' ? lp.injection : null);
    if (max === null || !inj) return { action: 'park', reason: 'label_policy_unusable', question };
    if (question.length > max) return { action: 'park', reason: 'label_too_long', question };
    if (inj.test(question)) return { action: 'park', reason: 'label_instruction_like', question };
  }
  const kind = typeof field?.kind === 'string' ? field.kind : '';
  if (!FILLABLE_KINDS.includes(kind) && kind !== 'file') {
    if (field?.filled) {
      const sens = rx(profile.sensitiveLabel);
      if (sens === null || (sens && sens.test(question))) return { action: 'park', reason: 'sensitive_prefilled_unsupported', question };
      if (profile.acceptPrefilledNonSensitive) return { action: 'leave_prefilled', question };
    }
    if (profile.parkUnsupportedRequired && field?.required) return { action: 'park', reason: 'unsupported_required_field', question };
    return { action: 'resolve', question };
  }
  const consent = rx(profile.consentLabel);
  if (consent === null) return { action: 'park', reason: 'consent_policy_unusable', question };
  if (consent && consent.test(question)) {
    const label = ctx.bank && ctx.bank.labels ? ctx.bank.labels.get(normalizeText(question)) : undefined;
    if (!label || label.tier !== 'learned') return { action: 'park', reason: 'consent_requires_bank_key', question };
  }
  return { action: 'resolve', question };
}

/**
 * After resolution, for a field the SITE already filled (resume parse or a saved draft) in a sensitive
 * class (A5). Total:
 *   - the profile has no sensitive-class rule, the label is not sensitive, or the field is empty -> 'ok';
 *   - unusable sensitive regex -> park;
 *   - the bank gives no value (anything but a fill decision) -> park 'sensitive_prefilled_no_bank_value';
 *   - the prefilled value differs from the bank's -> park 'sensitive_prefilled_mismatch';
 *   - equal -> 'ok'.
 * @param {{ question: string, kind: string, filled: boolean, value: string }} field
 * @param {{ action: string, value?: unknown }} decision
 * @param {string} want the value the server would write (already in read-back form)
 * @param {any} profile
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function sensitivePrefillPolicy(field, decision, want, profile) {
  const re = rx(profile ? profile.sensitiveLabel : undefined);
  if (re === undefined) return { ok: true };
  if (re === null) return { ok: false, reason: 'sensitive_policy_unusable' };
  const question = matchQuestion(field?.question, profile);
  if (!re.test(question) || !field?.filled) return { ok: true };
  if (decision.action !== 'fill') return { ok: false, reason: 'sensitive_prefilled_no_bank_value' };
  const collapse = (/** @type {unknown} */ s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const same = field.kind === 'text' || field.kind === 'textarea' ? String(field.value ?? '') === want : collapse(field.value) === collapse(want);
  return same ? { ok: true } : { ok: false, reason: 'sensitive_prefilled_mismatch' };
}
