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
import { WORKDAY_LABEL_POLICY } from './profiles/workday.js';

/** Most options a parked choice field persists into pending_question.options (answer-fallback spec F5). */
export const OPTION_CAP = 50;

/**
 * The label policy options are checked against when a profile has none of its own (LinkedIn): option text
 * is employer-authored and reaches the dashboard and the bank, so it is never left unchecked.
 */
const DEFAULT_OPTION_POLICY = WORKDAY_LABEL_POLICY;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/**
 * Sanitize a parked field's option list (spec F5). Every option passes the SAME injection regex and length
 * cap as labels (the profile's labelPolicy, else DEFAULT_OPTION_POLICY). Total, per option: not a string,
 * blank, a control character (a line break could forge a bank line), over the length cap, or
 * instruction-like -> dropped and counted; an exact duplicate -> dropped silently; otherwise kept, until
 * OPTION_CAP is reached (the rest are counted as dropped). An unusable policy keeps nothing (fail closed).
 * @param {unknown} raw
 * @param {any} profile
 * @returns {{ options: string[], dropped: number }}
 */
export function sanitizeOptions(raw, profile) {
  const list = Array.isArray(raw) ? raw : [];
  const lp = profile && profile.labelPolicy !== undefined ? profile.labelPolicy : DEFAULT_OPTION_POLICY;
  const max = lp && typeof lp === 'object' && Number.isInteger(lp.maxLength) ? lp.maxLength : null;
  const inj = rx(lp && typeof lp === 'object' ? lp.injection : null);
  if (max === null || !inj) return { options: [], dropped: list.length };
  /** @type {string[]} */
  const options = [];
  let dropped = 0;
  for (const o of list) {
    if (typeof o !== 'string' || !o.trim() || CONTROL_CHAR_RE.test(o) || o.length > max || inj.test(o)) {
      dropped++;
      continue;
    }
    if (options.includes(o)) continue;
    if (options.length >= OPTION_CAP) {
      dropped++;
      continue;
    }
    options.push(o);
  }
  return { options, dropped };
}

/**
 * The pending_question fields a parked choice field carries (spec F4), from a lease's park record:
 * `options` (re-sanitized), `field_kind`, and `options_dropped` when any were dropped along the way. An
 * empty object when no option survives, so a text question's pending_question is unchanged.
 * @param {any} park
 * @param {any} profile
 * @returns {{ options?: string[], field_kind?: string|null, options_dropped?: number }}
 */
export function pendingOptionFields(park, profile) {
  const pk = park && typeof park === 'object' ? park : {};
  if (!Array.isArray(pk.options) || pk.options.length === 0) return {};
  const s = sanitizeOptions(pk.options, profile);
  if (s.options.length === 0) return {};
  const priorDropped = Number.isInteger(pk.options_dropped) && pk.options_dropped > 0 ? pk.options_dropped : 0;
  const dropped = priorDropped + s.dropped;
  return { options: s.options, field_kind: typeof pk.kind === 'string' ? pk.kind : null, ...(dropped > 0 ? { options_dropped: dropped } : {}) };
}

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
