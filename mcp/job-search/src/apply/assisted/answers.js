// @ts-check
/**
 * Assisted apply: server-side answer resolution (spec G6; v1 clause 4: contact labels come from the
 * profile). The model passes a field REF only; this module decides the value from the answer bank
 * (src/apply/answers.js's parsed bank), the profile's contact-label map, and the application's own account
 * email. The model never supplies a value, and nothing here guesses.
 *
 * Total classification over every field the driver reports (first match wins):
 *   1. "Follow <company>" checkbox (or any label starting with "follow") -> 'leave' (never touched).
 *   2. empty question text -> 'park' (cannot be matched exactly against anything).
 *   3. kind outside {text, textarea, select, radio, checkbox} -> 'park' (file inputs go through the
 *      separate upload_resume action, never through answer).
 *   4. compensation-shaped question (answers.js SALARY_LABEL_RE / HOURLY_RE) -> 'park', always.
 *   5. contact label (ctx.contactLabels, exact normalized own-key match) -> that contact fact's value;
 *      'email' falls back to the application's own account_email (a database value). No value -> park when
 *      required, blank when optional. A missing or non-object contactLabels map has no contact labels.
 *   6. the bank's LEARNED tier, exact normalized label match -> that fact's value. An alias-tier or
 *      synonym-tier hit is NOT exact for this purpose and parks (when required) with 'not_exact_learned'.
 *   7. no exact match -> park when required, 'skip_optional' (left blank) when optional.
 * For select/radio, answers.js's shared matchCandidates (answer-fallback spec F2) places the value: the
 * fact's value, then its ranked fallbacks (FALLBACK_KEYS enum keys only), each by exact match after the
 * pinned normalizeText (EEO keys use EEO_TAXONOMY's exact spellings). Two-plus options for a candidate, or
 * zero for every candidate, park with no_exact_option. A fill picked by a fallback carries fallbackRank.
 */
import { normalizeText, matchCandidates, answerCandidates, SALARY_LABEL_RE, HOURLY_RE } from '../answers.js';

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
 * @typedef {{ action: 'fill', value: string|boolean, bankKey: string, source: 'contact'|'learned', fallbackRank?: number }
 *   | { action: 'park', reason: string, bankKey: string|null }
 *   | { action: 'skip_optional', reason: string }
 *   | { action: 'leave', reason: 'follow_company' }} FieldAnswer
 */

/**
 * @param {{ question: string, kind: string, required: boolean, options: string[] }} field
 * @param {{ bank: import('../answers.js').AnswerBank, accountEmail: string|null, contactLabels?: Readonly<Record<string, string>> }} ctx
 * @returns {FieldAnswer}
 */
export function resolveFieldAnswer(field, ctx) {
  const question = typeof field?.question === 'string' ? field.question : '';
  const norm = normalizeText(question);
  const required = Boolean(field?.required);
  const options = Array.isArray(field?.options) ? field.options.filter((o) => typeof o === 'string') : [];
  const kind = typeof field?.kind === 'string' ? field.kind : '';
  const labels = ctx.contactLabels && typeof ctx.contactLabels === 'object' ? ctx.contactLabels : {};

  if (/^follow\b/.test(norm)) return { action: 'leave', reason: 'follow_company' };
  if (!norm) return { action: 'park', reason: 'empty_question', bankKey: null };
  if (!FIELD_KINDS.includes(kind)) return { action: 'park', reason: 'unsupported_field_kind', bankKey: null };
  if (SALARY_LABEL_RE.test(question) || HOURLY_RE.test(question)) return { action: 'park', reason: 'compensation_question', bankKey: null };

  /** @type {string|null} */
  const contactKey = Object.prototype.hasOwnProperty.call(labels, norm) && typeof /** @type {any} */ (labels)[norm] === 'string' ? /** @type {any} */ (labels)[norm] : null;
  if (contactKey) {
    const fact = ctx.bank.facts.get(contactKey);
    let value = fact && typeof fact.value === 'string' && fact.value.trim() ? fact.value.trim() : null;
    if (!value && contactKey === 'email' && typeof ctx.accountEmail === 'string' && ctx.accountEmail.trim()) value = ctx.accountEmail.trim();
    if (!value) return required ? { action: 'park', reason: 'no_bank_fact', bankKey: contactKey } : { action: 'skip_optional', reason: 'no_bank_fact' };
    return finishValue(contactKey, value, kind, options, 'contact', null, null);
  }

  const label = ctx.bank.labels.get(norm);
  if (!label) return required ? { action: 'park', reason: 'no_exact_match', bankKey: null } : { action: 'skip_optional', reason: 'no_exact_match' };
  if (label.tier !== 'learned') return required ? { action: 'park', reason: 'not_exact_learned', bankKey: label.key } : { action: 'skip_optional', reason: 'not_exact_learned' };
  const fact = ctx.bank.facts.get(label.key);
  if (!fact || fact.value === undefined) return required ? { action: 'park', reason: 'no_bank_fact', bankKey: label.key } : { action: 'skip_optional', reason: 'no_bank_fact' };
  if (fact.type === 'multiselect') return { action: 'park', reason: 'unsupported_fact_type', bankKey: label.key };
  const resolved = fact.type === 'boolean' && label.polarity === 'invert' ? !fact.value : fact.value;
  return finishValue(label.key, resolved, kind, options, 'learned', fact.type, fact);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {string} kind
 * @param {string[]} options
 * @param {'contact'|'learned'} source
 * @param {string|null} factType
 * @param {import('../answers.js').FactEntry|null} fact the bank fact (ranked fallbacks), null for contact values
 * @returns {FieldAnswer}
 */
function finishValue(key, value, kind, options, source, factType, fact) {
  const isBool = factType === 'boolean' || typeof value === 'boolean';
  if (kind === 'checkbox') {
    if (!isBool) return { action: 'park', reason: 'checkbox_needs_boolean_fact', bankKey: key };
    return { action: 'fill', value: Boolean(value), bankKey: key, source };
  }
  const token = isBool ? (value ? 'yes' : 'no') : String(value);
  if (kind === 'select' || kind === 'radio') {
    if (options.length === 0) return { action: 'park', reason: 'no_options', bankKey: key };
    const candidates = isBool || !fact ? [{ value: token, rank: 1 }] : answerCandidates(fact, value);
    const m = matchCandidates(candidates, options, key);
    if (!m.ok) return { action: 'park', reason: 'no_exact_option', bankKey: key };
    return m.rank > 1 ? { action: 'fill', value: m.selectedOption, bankKey: key, source, fallbackRank: m.rank } : { action: 'fill', value: m.selectedOption, bankKey: key, source };
  }
  const text = isBool ? (value ? 'Yes' : 'No') : sanitizeValue(value);
  if (!text.trim()) return { action: 'park', reason: 'no_bank_fact', bankKey: key };
  return { action: 'fill', value: text, bankKey: key, source };
}
