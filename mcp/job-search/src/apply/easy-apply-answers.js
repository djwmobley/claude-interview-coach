// @ts-check
/**
 * Assisted LinkedIn Easy Apply: server-side answer resolution (spec G6). The model passes a field REF
 * only; this module decides the value from the answer bank (src/apply/answers.js's parsed bank) and the
 * application's own account email. The model never supplies a value, and nothing here guesses.
 *
 * Total classification over every field the driver reports (first match wins):
 *   1. "Follow <company>" checkbox (or any label starting with "follow") -> 'leave' (never touched).
 *   2. empty question text -> 'park' (cannot be matched exactly against anything).
 *   3. kind outside {text, textarea, select, radio, checkbox} -> 'park' (file inputs go through the
 *      separate upload_resume action, never through answer).
 *   4. compensation-shaped question (answers.js SALARY_LABEL_RE / HOURLY_RE) -> 'park', always: the bank's
 *      salary floor logic is not applied to LinkedIn's free-form salary questions in this assisted flow.
 *   5. contact label (CONTACT_LABELS, exact normalized match) -> that contact fact's value; 'email' falls
 *      back to the application's own account_email (a database value). No value -> park when required,
 *      blank when optional.
 *   6. the bank's LEARNED tier, exact normalized label match -> that fact's value. An alias-tier or
 *      synonym-tier hit is NOT exact for this purpose and parks (when required) with 'not_exact_learned'.
 *   7. no exact match -> park when required, 'skip_optional' (left blank) when optional.
 * For select/radio, the resolved value must equal exactly one option after answers.js's pinned
 * normalizeText (EEO keys use answers.js's own EEO_TAXONOMY exact spelling table, the same exact-equality
 * machinery the rest of the apply pipeline uses); zero or two-plus candidates park with no_exact_option.
 */
import { normalizeText, taxonomyOptionsFor, SALARY_LABEL_RE, HOURLY_RE } from './answers.js';

/** Exact normalized LinkedIn contact-field labels -> contact fact keys in the answer bank. */
export const CONTACT_LABELS = Object.freeze({
  'first name': 'first_name',
  'last name': 'last_name',
  'email address': 'email',
  email: 'email',
  'mobile phone number': 'phone',
  'phone number': 'phone',
  phone: 'phone',
  'phone country code': 'phone_country_code',
  'location (city)': 'city',
  city: 'city',
});

const FIELD_KINDS = Object.freeze(['text', 'textarea', 'select', 'radio', 'checkbox']);

/**
 * Strip CR/LF (spec G4) so no value can ever carry a line break into a single-line field (a newline in a
 * text field is the closest a value setter gets to an Enter key).
 * @param {unknown} v
 * @returns {string}
 */
export function sanitizeValue(v) {
  return String(v ?? '').replace(/\r\n|\r|\n/g, ' ');
}

/**
 * @param {string} token canonical value token
 * @param {string[]} options site option texts
 * @param {string} key fact key (taxonomy lookup)
 * @returns {string|null} the single matching option, or null for zero or two-plus candidates
 */
function exactOption(token, options, key) {
  const acceptable = new Set(taxonomyOptionsFor(key, token) ?? [normalizeText(token)]);
  const hits = [...new Set(options.filter((o) => acceptable.has(normalizeText(o))))];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * @typedef {{ action: 'fill', value: string|boolean, bankKey: string, source: 'contact'|'learned' }
 *   | { action: 'park', reason: string, bankKey: string|null }
 *   | { action: 'skip_optional', reason: string }
 *   | { action: 'leave', reason: 'follow_company' }} FieldAnswer
 */

/**
 * @param {{ question: string, kind: string, required: boolean, options: string[] }} field
 * @param {{ bank: import('./answers.js').AnswerBank, accountEmail: string|null }} ctx
 * @returns {FieldAnswer}
 */
export function resolveFieldAnswer(field, ctx) {
  const question = typeof field?.question === 'string' ? field.question : '';
  const norm = normalizeText(question);
  const required = Boolean(field?.required);
  const options = Array.isArray(field?.options) ? field.options.filter((o) => typeof o === 'string') : [];
  const kind = typeof field?.kind === 'string' ? field.kind : '';

  if (/^follow\b/.test(norm)) return { action: 'leave', reason: 'follow_company' };
  if (!norm) return { action: 'park', reason: 'empty_question', bankKey: null };
  if (!FIELD_KINDS.includes(kind)) return { action: 'park', reason: 'unsupported_field_kind', bankKey: null };
  if (SALARY_LABEL_RE.test(question) || HOURLY_RE.test(question)) return { action: 'park', reason: 'compensation_question', bankKey: null };

  /** @type {string|null} */
  const contactKey = Object.prototype.hasOwnProperty.call(CONTACT_LABELS, norm) ? /** @type {any} */ (CONTACT_LABELS)[norm] : null;
  if (contactKey) {
    const fact = ctx.bank.facts.get(contactKey);
    let value = fact && typeof fact.value === 'string' && fact.value.trim() ? fact.value.trim() : null;
    if (!value && contactKey === 'email' && typeof ctx.accountEmail === 'string' && ctx.accountEmail.trim()) value = ctx.accountEmail.trim();
    if (!value) return required ? { action: 'park', reason: 'no_bank_fact', bankKey: contactKey } : { action: 'skip_optional', reason: 'no_bank_fact' };
    return finishValue(contactKey, value, kind, options, 'contact', null);
  }

  const label = ctx.bank.labels.get(norm);
  if (!label) return required ? { action: 'park', reason: 'no_exact_match', bankKey: null } : { action: 'skip_optional', reason: 'no_exact_match' };
  if (label.tier !== 'learned') return required ? { action: 'park', reason: 'not_exact_learned', bankKey: label.key } : { action: 'skip_optional', reason: 'not_exact_learned' };
  const fact = ctx.bank.facts.get(label.key);
  if (!fact || fact.value === undefined) return required ? { action: 'park', reason: 'no_bank_fact', bankKey: label.key } : { action: 'skip_optional', reason: 'no_bank_fact' };
  if (fact.type === 'multiselect') return { action: 'park', reason: 'unsupported_fact_type', bankKey: label.key };
  const resolved = fact.type === 'boolean' && label.polarity === 'invert' ? !fact.value : fact.value;
  return finishValue(label.key, resolved, kind, options, 'learned', fact.type);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {string} kind
 * @param {string[]} options
 * @param {'contact'|'learned'} source
 * @param {string|null} factType
 * @returns {FieldAnswer}
 */
function finishValue(key, value, kind, options, source, factType) {
  const isBool = factType === 'boolean' || typeof value === 'boolean';
  if (kind === 'checkbox') {
    if (!isBool) return { action: 'park', reason: 'checkbox_needs_boolean_fact', bankKey: key };
    return { action: 'fill', value: Boolean(value), bankKey: key, source };
  }
  const token = isBool ? (value ? 'yes' : 'no') : String(value);
  if (kind === 'select' || kind === 'radio') {
    if (options.length === 0) return { action: 'park', reason: 'no_options', bankKey: key };
    const picked = exactOption(token, options, key);
    if (picked === null) return { action: 'park', reason: 'no_exact_option', bankKey: key };
    return { action: 'fill', value: picked, bankKey: key, source };
  }
  const text = isBool ? (value ? 'Yes' : 'No') : sanitizeValue(value);
  if (!text.trim()) return { action: 'park', reason: 'no_bank_fact', bankKey: key };
  return { action: 'fill', value: text, bankKey: key, source };
}
