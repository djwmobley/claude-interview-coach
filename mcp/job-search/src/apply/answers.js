// @ts-check
/**
 * Screening-question answer bank and matcher (apply pipeline slice 4, plan
 * `let-s-brainstorm-a-bit-humble-umbrella.md` section "4. Screening questions", amended by the slice-4
 * spec-adversary pass, 2026-08-31). The amended spec OVERRIDES the plan's literal wording where they
 * differ; this file implements the amendment, not the original plan text:
 *
 *   - The bank stores structured FACTS (booleans/enums/multiselect-sets/free text), never answer
 *     strings addressed to a specific site's wording.
 *   - NO similarity scoring, ever. Matching a question label to a canonical key is exactly three
 *     exact-match tiers, checked in this order: (1) the bank's own "learned" label store (a label
 *     previously confirmed correct), (2) the bank's hand-authored "aliases" for that key, (3) a small,
 *     hard-coded synonym table. Only a tier-1 (learned) hit ever auto-answers; tiers 2 and 3 always
 *     produce a parked SUGGESTION for a human to confirm.
 *   - Confirming a suggestion promotes that exact label into the learned store (appendLearnedLabel),
 *     so the same label auto-answers next time. This module exposes that as a pure text transform;
 *     wiring it to a dashboard action is a later slice's concern (see the PR body's scope note).
 *   - Polarity (does "yes" mean the fact is true or false for THIS alias) is hand-authored per alias,
 *     never inferred from the wording -- see the "::" alias modifier below.
 *   - Option matching is exact equality after a single pinned normalization (normalizeText): lowercase,
 *     trim, collapse whitespace, strip trailing punctuation, KEEP parentheticals. Zero or two-or-more
 *     candidates both park; only exactly one candidate is ever selected.
 *   - Control-type totality: 'text' | 'radio' | 'checkbox-group' | 'boolean' | 'multiselect' each have
 *     their own park rules; anything else (including undefined/null/a typo) parks as
 *     'unsupported_control_type'. This is CONTROL_TYPES below -- the single closed list every switch in
 *     this file is checked against.
 *   - EEO race/ethnicity (and any other key that needs it) gets a semantic-enum-to-site-option taxonomy
 *     (EEO_TAXONOMY), because the same canonical answer ("White, not Hispanic or Latino") is spelled
 *     differently on every ATS.
 *   - Salary: unit-basis (hourly vs annual) is detected from the question label; ambiguous parks. Only a
 *     plain 'text' control with an unambiguous unit and a configured salary_floor ever produces an
 *     answer; any other control shape (range, currency picker) parks, because this slice does not
 *     configure one.
 *
 * The bank file (data/apply-answers.md under this package, gitignored -- see data/apply-answers.example.md
 * for the tracked, de-identified format reference) is a human-edited markdown-like file. Every line inside
 * a "## key" section is matched by its own regex prefix (type:/value:/aliases:/learned:), independent of
 * position -- a human reordering, inserting, or deleting lines never breaks parsing, per the house rule
 * against positional/contiguity assumptions on a human-edited file (see also src/core/config.js's own
 * CRLF-normalization precedent, mirrored here: `\r\n` is normalized to `\n` before anything else runs).
 */
import { JobSearchError } from '../core/errors.js';

/** Section-header key shape: sql/CHECK-constraint-style closed grammar, not free text. */
export const SECTION_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Fact types a "## key" section may declare. Closed, total. */
export const FACT_TYPES = Object.freeze(['enum', 'boolean', 'text', 'multiselect']);

/** Control-type totality (spec: "each with per-type park rules ... unknown control type parks"). */
export const CONTROL_TYPES = Object.freeze(['text', 'radio', 'checkbox-group', 'boolean', 'multiselect']);

// ---------------------------------------------------------------------------------------------------
// normalizeText: the ONE pinned normalization every exact-match comparison in this file goes through.
// ---------------------------------------------------------------------------------------------------

/**
 * Lowercase, trim, collapse internal whitespace runs to one space, strip trailing punctuation (a run of
 * `. , ; : ! ?` at the very end) -- but a trailing `)` is never stripped: a parenthetical is meaningful
 * content ("White (Not Hispanic or Latino)"), not punctuation to discard. Applied identically to question
 * labels, bank aliases/learned labels, and every site option string, so every comparison in this module
 * is a plain `===` after this one transform, never a fuzzy/similarity comparison.
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeText(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/g, '');
}

// ---------------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} FactEntry
 * @property {string} key
 * @property {'enum'|'boolean'|'text'|'multiselect'|null} type
 * @property {string|boolean|string[]|undefined} value
 */

/**
 * @typedef {Object} LabelEntry
 * @property {string} key canonical fact key this label resolves to
 * @property {'alias'|'learned'} tier
 * @property {'same'|'invert'} polarity only meaningful for boolean-type keys
 */

/**
 * @typedef {Object} AnswerBank
 * @property {Map<string, FactEntry>} facts key -> fact
 * @property {Map<string, LabelEntry>} labels normalizeText(label) -> LabelEntry (global namespace: an
 *   alias/learned label may resolve to exactly one key, full stop -- registering the same normalized
 *   label twice, whether under the same key or a different one, whether alias or learned, is fatal)
 * @property {{ salary_floor: number|null }} meta
 */

const SECTION_RE = /^##\s+(\S+)\s*$/;
const TYPE_RE = /^type:\s*(\S+)\s*$/;
const VALUE_RE = /^value:\s*(.+)$/;
const ALIASES_RE = /^aliases:\s*(.+?)(?:\s*::\s*(\S+))?\s*$/;
const LEARNED_RE = /^learned:\s*(.+)$/;
const SALARY_FLOOR_RE = /^salary_floor:\s*(\d+(?:\.\d+)?)\s*$/;

/**
 * @param {Map<string, LabelEntry>} labels
 * @param {string} label already-normalized
 * @param {string} key
 * @param {'alias'|'learned'} tier
 * @param {'same'|'invert'} polarity
 * @param {number} lineNo 1-based, for the error message only
 */
function registerLabel(labels, label, key, tier, polarity, lineNo) {
  if (!label) throw new JobSearchError('VALIDATION', `apply-answers.md: empty ${tier} label under key "${key}" (line ${lineNo})`, { details: { key, line: lineNo } });
  const existing = labels.get(label);
  if (existing) {
    throw new JobSearchError(
      'VALIDATION',
      `apply-answers.md: duplicate label "${label}" -- already resolves to key "${existing.key}" (${existing.tier}), cannot also resolve to key "${key}" (${tier}) at line ${lineNo}`,
      { details: { label, first_key: existing.key, key, line: lineNo } },
    );
  }
  labels.set(label, { key, tier, polarity });
}

/**
 * Parse data/apply-answers.md's format into an AnswerBank. Fatal (throws JobSearchError VALIDATION,
 * never a silent partial parse) on: a malformed section key, a duplicate section key, a duplicate
 * type:/value: line within one section, a duplicate alias/learned label anywhere in the file (including
 * an alias colliding with a learned label, or with itself), an unrecognized non-blank line, a missing
 * type: or value: for a fact that requires one, an invert polarity on a non-boolean key, or a boolean
 * value: that is not literally "true"/"false".
 *
 * CRLF is normalized to LF before line-splitting (src/core/config.js's own precedent). Every field within
 * a section is matched by its own regex against the trimmed line, independent of the OTHER lines' order
 * or position -- a human inserting a new alias between two existing ones, or moving `type:` below
 * `aliases:`, parses identically to the original order.
 * @param {unknown} rawText
 * @returns {AnswerBank}
 */
export function parseAnswerBank(rawText) {
  if (typeof rawText !== 'string') throw new JobSearchError('VALIDATION', 'apply-answers.md: content must be a string');
  const text = rawText.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  /** @type {Map<string, FactEntry>} */
  const facts = new Map();
  /** @type {Map<string, LabelEntry>} */
  const labels = new Map();
  /** @type {{ salary_floor: number|null }} */
  const meta = { salary_floor: null };

  /** @type {string|null} */
  let currentKey = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    const lineNo = i + 1;
    if (!line) continue;
    if (line.startsWith('#') && !line.startsWith('##')) continue; // comment line, anywhere in the file

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      const key = sectionMatch[1];
      if (!SECTION_KEY_RE.test(key)) {
        throw new JobSearchError('VALIDATION', `apply-answers.md: section key "${key}" must match ${SECTION_KEY_RE} (line ${lineNo})`, { details: { key, line: lineNo } });
      }
      if (facts.has(key)) {
        throw new JobSearchError('VALIDATION', `apply-answers.md: duplicate key "${key}" (line ${lineNo})`, { details: { key, line: lineNo } });
      }
      facts.set(key, { key, type: null, value: undefined });
      currentKey = key;
      continue;
    }

    if (currentKey === null) {
      const salaryMatch = SALARY_FLOOR_RE.exec(line);
      if (salaryMatch) {
        if (meta.salary_floor !== null) throw new JobSearchError('VALIDATION', `apply-answers.md: duplicate salary_floor (line ${lineNo})`, { details: { line: lineNo } });
        meta.salary_floor = Number(salaryMatch[1]);
        continue;
      }
      throw new JobSearchError('VALIDATION', `apply-answers.md: unrecognized top-level line (line ${lineNo}): "${rawLine.slice(0, 120)}"`, { details: { line: lineNo } });
    }

    const fact = /** @type {FactEntry} */ (facts.get(currentKey));

    const typeMatch = TYPE_RE.exec(line);
    if (typeMatch) {
      if (fact.type !== null) throw new JobSearchError('VALIDATION', `apply-answers.md: duplicate "type:" under key "${currentKey}" (line ${lineNo})`, { details: { key: currentKey, line: lineNo } });
      if (!FACT_TYPES.includes(/** @type {any} */ (typeMatch[1]))) {
        throw new JobSearchError('VALIDATION', `apply-answers.md: key "${currentKey}" has unknown type "${typeMatch[1]}" (line ${lineNo}); must be one of ${FACT_TYPES.join(', ')}`, { details: { key: currentKey, line: lineNo } });
      }
      fact.type = /** @type {any} */ (typeMatch[1]);
      continue;
    }

    const valueMatch = VALUE_RE.exec(line);
    if (valueMatch) {
      if (fact.value !== undefined) throw new JobSearchError('VALIDATION', `apply-answers.md: duplicate "value:" under key "${currentKey}" (line ${lineNo})`, { details: { key: currentKey, line: lineNo } });
      fact.value = valueMatch[1].trim();
      continue;
    }

    const aliasMatch = ALIASES_RE.exec(line);
    if (aliasMatch) {
      const modifier = aliasMatch[2] ?? null;
      if (modifier !== null && modifier !== 'invert') {
        throw new JobSearchError('VALIDATION', `apply-answers.md: unrecognized alias modifier "${modifier}" under key "${currentKey}" (line ${lineNo}); only "invert" is recognized`, { details: { key: currentKey, line: lineNo } });
      }
      const label = normalizeText(aliasMatch[1]);
      registerLabel(labels, label, currentKey, 'alias', modifier === 'invert' ? 'invert' : 'same', lineNo);
      continue;
    }

    const learnedMatch = LEARNED_RE.exec(line);
    if (learnedMatch) {
      const label = normalizeText(learnedMatch[1]);
      registerLabel(labels, label, currentKey, 'learned', 'same', lineNo);
      continue;
    }

    throw new JobSearchError('VALIDATION', `apply-answers.md: unrecognized line under key "${currentKey}" (line ${lineNo}): "${rawLine.slice(0, 120)}"`, { details: { key: currentKey, line: lineNo } });
  }

  for (const [key, fact] of facts) {
    if (!fact.type) throw new JobSearchError('VALIDATION', `apply-answers.md: key "${key}" is missing "type:"`, { details: { key } });
    if (fact.type !== 'text' && fact.value === undefined) {
      throw new JobSearchError('VALIDATION', `apply-answers.md: key "${key}" (type ${fact.type}) is missing "value:"`, { details: { key } });
    }
    if (fact.type === 'boolean' && fact.value !== undefined) {
      const v = String(fact.value).toLowerCase();
      if (v !== 'true' && v !== 'false') {
        throw new JobSearchError('VALIDATION', `apply-answers.md: key "${key}" (type boolean) value must be "true" or "false", got "${fact.value}"`, { details: { key } });
      }
      fact.value = v === 'true';
    }
    if (fact.type === 'multiselect' && typeof fact.value === 'string') {
      fact.value = fact.value.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  // Polarity is only ever meaningful for a boolean key: an "invert" modifier on an enum/text/multiselect
  // alias has no defined meaning (there is no true/false to flip), so it is a bank authoring error caught
  // here, fatally, rather than silently ignored at match time.
  for (const [label, entry] of labels) {
    if (entry.polarity === 'invert') {
      const fact = facts.get(entry.key);
      if (!fact || fact.type !== 'boolean') {
        throw new JobSearchError('VALIDATION', `apply-answers.md: label "${label}" uses "::invert" but key "${entry.key}" is not type boolean`, { details: { label, key: entry.key } });
      }
    }
  }

  return { facts, labels, meta };
}

/**
 * Append a new `learned:` line to an existing "## key" section's block, preserving every other byte of
 * the file untouched (no reformatting, no reordering). Idempotent: if the exact normalized label is
 * already a learned entry under that key, returns the input unchanged. This is the pure text-transform
 * half of "confirming a suggestion promotes it to the learned store" (spec section 4) -- wiring it to a
 * dashboard action is left to the slice that builds the question-answer card (out of this slice's scope;
 * see the PR body).
 * @param {string} bankText
 * @param {string} key
 * @param {string} label raw (un-normalized) label text, exactly as seen on the page
 * @returns {string}
 */
export function appendLearnedLabel(bankText, key, label) {
  if (typeof bankText !== 'string') throw new JobSearchError('VALIDATION', 'appendLearnedLabel: bankText must be a string');
  const text = bankText.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i].trim());
    if (m && m[1] === key) {
      start = i;
      continue;
    }
    if (start !== -1 && m && m[1] !== key) {
      end = i;
      break;
    }
  }
  if (start === -1) throw new JobSearchError('VALIDATION', `appendLearnedLabel: key "${key}" not found in bank`, { details: { key } });

  const normLabel = normalizeText(label);
  const alreadyLearned = lines.slice(start, end).some((l) => {
    const m2 = LEARNED_RE.exec(l.trim());
    return m2 && normalizeText(m2[1]) === normLabel;
  });
  if (alreadyLearned) return bankText;

  const newLine = `learned: ${String(label).trim()}`;
  const updated = [...lines.slice(0, end), newLine, ...lines.slice(end)];
  return updated.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// EEO taxonomy: canonical enum value <-> the differently-worded option text each site actually shows.
// ---------------------------------------------------------------------------------------------------

/**
 * Per-key taxonomy tables. Only eeo_race_ethnicity ships with real entries in this slice (the spec's own
 * worked example); any other key simply has no table, which taxonomyOptionsFor/taxonomyCanonicalFor
 * report as `null` -- callers fall back to a plain normalizeText(value) single-candidate match, never a
 * throw.
 */
export const EEO_TAXONOMY = Object.freeze({
  eeo_race_ethnicity: Object.freeze({
    white_not_hispanic_or_latino: Object.freeze([
      'White (Not Hispanic or Latino)',
      'White/Caucasian',
      'White',
      'Caucasian',
      'White (United States of America)',
    ]),
    black_or_african_american: Object.freeze([
      'Black or African American (Not Hispanic or Latino)',
      'Black or African American',
      'Black/African American',
    ]),
    hispanic_or_latino: Object.freeze([
      'Hispanic or Latino',
      'Hispanic/Latino',
    ]),
    asian: Object.freeze([
      'Asian (Not Hispanic or Latino)',
      'Asian',
    ]),
    american_indian_or_alaska_native: Object.freeze([
      'American Indian or Alaska Native (Not Hispanic or Latino)',
      'American Indian or Alaska Native',
    ]),
    native_hawaiian_or_pacific_islander: Object.freeze([
      'Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)',
      'Native Hawaiian or Other Pacific Islander',
    ]),
    two_or_more_races: Object.freeze([
      'Two or More Races (Not Hispanic or Latino)',
      'Two or More Races',
    ]),
    decline_to_answer: Object.freeze([
      'I do not wish to answer',
      'Decline to self-identify',
      'Prefer not to answer',
    ]),
  }),
});

/**
 * Forward direction: canonical enum value -> the normalized set of site-option strings accepted for it.
 * `null` when no taxonomy is registered for that key (caller falls back to normalizeText(canonicalValue)).
 * @param {string} key
 * @param {unknown} canonicalValue
 * @returns {string[]|null}
 */
export function taxonomyOptionsFor(key, canonicalValue) {
  const table = /** @type {any} */ (EEO_TAXONOMY)[key];
  if (!table) return null;
  const list = table[String(canonicalValue)];
  if (!list) return null;
  return list.map((/** @type {string} */ s) => normalizeText(s));
}

/**
 * Reverse direction: a site's own option text -> the canonical enum value it represents, or `null` when
 * no taxonomy is registered for the key or the text matches no entry.
 * @param {string} key
 * @param {unknown} optionText
 * @returns {string|null}
 */
export function taxonomyCanonicalFor(key, optionText) {
  const table = /** @type {any} */ (EEO_TAXONOMY)[key];
  if (!table) return null;
  const norm = normalizeText(optionText);
  for (const [canonical, variants] of Object.entries(table)) {
    if (/** @type {string[]} */ (variants).some((v) => normalizeText(v) === norm)) return canonical;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Option matching (0 or 2+ candidates park; exactly 1 is selected) and control-type totality.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {unknown} rawValue canonical value to place (a taxonomy key's canonical token, or a plain
 *   string/boolean-derived 'yes'/'no' token)
 * @param {string[]} siteOptions the control's own option texts, exactly as the page shows them
 * @param {FactEntry} fact the fact this value came from (used to look up a taxonomy by fact.key)
 * @returns {{ ok: true, selectedOption: string } | { ok: false, reason: 'zero_candidates'|'multiple_candidates' }}
 */
function matchSingleOption(rawValue, siteOptions, fact) {
  const acceptable = taxonomyOptionsFor(fact.key, rawValue) ?? [normalizeText(String(rawValue))];
  const acceptableSet = new Set(acceptable);
  const candidates = siteOptions.filter((o) => acceptableSet.has(normalizeText(o)));
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) return { ok: false, reason: 'zero_candidates' };
  if (uniqueCandidates.length >= 2) return { ok: false, reason: 'multiple_candidates' };
  return { ok: true, selectedOption: uniqueCandidates[0] };
}

/**
 * @typedef {Object} ControlResult
 * @property {boolean} ok
 * @property {string} [reason] present when ok is false
 * @property {string|string[]|null} [selectedOption]
 * @property {string} [text] present for a 'text' control
 * @property {boolean} [checked] present for a 'boolean' control with no options list
 */

/**
 * Total switch over CONTROL_TYPES; anything not in that list -- including undefined, null, or a typo --
 * returns `{ ok: false, reason: 'unsupported_control_type' }` rather than throwing, so a caller can park
 * the run uniformly regardless of why matching failed.
 * @param {{ controlType: unknown, fact: FactEntry, value: unknown, options?: unknown }} input
 * @returns {ControlResult}
 */
export function resolveControl({ controlType, fact, value, options }) {
  if (typeof controlType !== 'string' || !CONTROL_TYPES.includes(/** @type {any} */ (controlType))) {
    return { ok: false, reason: 'unsupported_control_type' };
  }
  switch (controlType) {
    case 'text': {
      const text = fact.type === 'boolean' ? (value ? 'Yes' : 'No') : String(value ?? '');
      return { ok: true, selectedOption: null, text };
    }
    case 'boolean': {
      if (!Array.isArray(options) || options.length === 0) {
        return { ok: true, selectedOption: null, checked: Boolean(value) };
      }
      return matchSingleOption(value ? 'yes' : 'no', /** @type {string[]} */ (options), fact);
    }
    case 'radio':
    case 'checkbox-group': {
      if (!Array.isArray(options) || options.length === 0) return { ok: false, reason: 'no_options_provided' };
      return matchSingleOption(value, /** @type {string[]} */ (options), fact);
    }
    case 'multiselect': {
      // Full-set semantics: every token in `value` must independently resolve to exactly one site
      // option, or the WHOLE match parks -- a partial multiselect answer (some boxes checked, others
      // silently skipped because they were ambiguous) is a worse failure mode than parking the run.
      if (!Array.isArray(options) || options.length === 0) return { ok: false, reason: 'no_options_provided' };
      if (!Array.isArray(value)) return { ok: false, reason: 'multiselect_value_not_array' };
      /** @type {string[]} */
      const selected = [];
      for (const token of value) {
        const m = matchSingleOption(token, /** @type {string[]} */ (options), fact);
        if (!m.ok) return { ok: false, reason: `multiselect_${m.reason}` };
        selected.push(m.selectedOption);
      }
      return { ok: true, selectedOption: selected };
    }
    default:
      return { ok: false, reason: 'unsupported_control_type' };
  }
}

// ---------------------------------------------------------------------------------------------------
// The three-tier question matcher.
// ---------------------------------------------------------------------------------------------------

/**
 * Tier 3: a deliberately tiny, hard-coded (code, not bank-file) synonym table -- a last-resort net below
 * the bank's own hand-authored aliases for a handful of extremely common EEO/screening phrasings. Every
 * key here is already normalizeText()-shaped (lowercase ascii, no trailing punctuation) since it is
 * compared directly against an already-normalized incoming label. A synonym hit is NEVER an auto-answer
 * (only tier 1, the learned store, auto-answers) -- it parks with a suggestion exactly like an alias hit,
 * and confirming it promotes the label into the learned store the same way.
 */
export const SYNONYM_TABLE = Object.freeze({
  'are you eligible to work in this country': 'work_authorization',
  'are you eligible to work in the united states': 'work_authorization',
  'do you require visa sponsorship now or in the future': 'sponsorship_needed',
  'will you require sponsorship for employment visa status now or in the future': 'sponsorship_needed',
  'what is your race or ethnicity': 'eeo_race_ethnicity',
  'please select your gender': 'eeo_gender',
  'do you have a disability': 'eeo_disability',
  'are you a protected veteran': 'eeo_veteran',
});

/**
 * @param {FactEntry} fact
 * @param {'same'|'invert'} polarity
 * @returns {unknown}
 */
function applyPolarity(fact, polarity) {
  if (fact.type !== 'boolean') return fact.value;
  return polarity === 'invert' ? !fact.value : fact.value;
}

/**
 * @typedef {Object} MatchResult
 * @property {'learned'|'alias'|'synonym'|'none'} tier
 * @property {string|null} key
 * @property {'auto_answer'|'needs_human_suggestion'|'needs_human_no_match'} outcome
 * @property {unknown} [value] present when outcome is 'auto_answer'
 * @property {{ key: string, value: unknown }} [suggestion] present when outcome is 'needs_human_suggestion'
 * @property {ControlResult} [controlResult]
 * @property {string} [reason]
 */

/**
 * Match one screening-question label against the bank, exactly three tiers, checked in order, first hit
 * wins: (1) learned label store, (2) hand-authored alias, (3) built-in synonym table. NO similarity
 * scoring anywhere in this function -- every comparison is `normalizeText(a) === normalizeText(b)`.
 *
 * Only a tier-1 (learned) hit whose control also resolves cleanly can produce `outcome: 'auto_answer'`.
 * A tier-2/3 hit always parks with a suggestion, regardless of whether the control would have resolved
 * cleanly, because the label itself has not yet been confirmed correct for this exact phrasing. A label
 * matching no tier at all parks with no suggestion at all (never guesses).
 * @param {AnswerBank} bank
 * @param {{ label: unknown, controlType: unknown, options?: unknown }} input
 * @returns {MatchResult}
 */
export function matchQuestion(bank, input) {
  const normLabel = normalizeText(input.label);
  /** @type {LabelEntry|undefined} */
  let hit = bank.labels.get(normLabel);
  /** @type {'learned'|'alias'|'synonym'|null} */
  let tier = hit ? hit.tier : null;

  if (!hit) {
    const synonymKey = /** @type {any} */ (SYNONYM_TABLE)[normLabel];
    if (synonymKey && bank.facts.has(synonymKey)) {
      hit = { key: synonymKey, tier: 'alias', polarity: 'same' };
      tier = 'synonym';
    }
  }

  if (!hit || !tier) {
    return { tier: 'none', key: null, outcome: 'needs_human_no_match', reason: 'no_label_match' };
  }

  const fact = bank.facts.get(hit.key);
  if (!fact) {
    return { tier: 'none', key: null, outcome: 'needs_human_no_match', reason: 'key_not_in_bank' };
  }

  const resolvedValue = applyPolarity(fact, hit.polarity);
  const controlResult = fact.type === 'text' && input.controlType === undefined
    ? { ok: true, selectedOption: null, text: String(resolvedValue ?? '') }
    : resolveControl({ controlType: input.controlType, fact, value: resolvedValue, options: input.options });

  if (tier !== 'learned') {
    return {
      tier, key: hit.key, outcome: 'needs_human_suggestion',
      suggestion: { key: hit.key, value: resolvedValue },
      controlResult,
    };
  }
  if (!controlResult.ok) {
    return { tier: 'learned', key: hit.key, outcome: 'needs_human_no_match', reason: controlResult.reason, controlResult };
  }
  return { tier: 'learned', key: hit.key, outcome: 'auto_answer', value: resolvedValue, controlResult };
}

// ---------------------------------------------------------------------------------------------------
// Save-by-default split and pre-save option validation.
// ---------------------------------------------------------------------------------------------------

/**
 * Durable facts (boolean/enum/multiselect) save to the bank by default; a 'text' fact is narrative or
 * listing-scoped prose (e.g. "why do you want to work here") and never saves by default (spec: "Save-by-
 * default split"). The caller (the confirm/answer UI action, out of this slice's scope) is expected to
 * consult this before defaulting its own save checkbox.
 * @param {'enum'|'boolean'|'text'|'multiselect'|null|undefined} factType
 * @returns {boolean}
 */
export function isDurableFactType(factType) {
  return factType === 'boolean' || factType === 'enum' || factType === 'multiselect';
}

/**
 * Validate a candidate value against a field's own option list before it is ever written to the bank
 * (spec: "Saving an answer validates against the field's option list before writing to the bank"). No
 * options provided (a free-text field) trivially validates -- there is nothing to check a free-text
 * answer against. Reuses the exact same matchSingleOption/taxonomy machinery match-time uses, so "would
 * this save?" and "would this match?" can never silently disagree.
 * @param {FactEntry} fact
 * @param {unknown} value
 * @param {unknown} options
 * @returns {{ ok: true } | { ok: false, reason: 'zero_candidates'|'multiple_candidates' }}
 */
export function validateAnswerAgainstOptions(fact, value, options) {
  if (!Array.isArray(options) || options.length === 0) return { ok: true };
  const result = matchSingleOption(value, /** @type {string[]} */ (options), fact);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

// ---------------------------------------------------------------------------------------------------
// Salary: unit-basis detection, single configured floor, everything else parks.
// ---------------------------------------------------------------------------------------------------

const HOURLY_RE = /\bhour(?:ly)?\b|\/\s*hr\b/i;
const ANNUAL_RE = /\bannual(?:ly)?\b|\byear(?:ly)?\b|\/\s*yr\b|\bsalary\b/i;

/**
 * Apply pipeline slice 8 (widened post-review, same slice): a label is salary-related whenever it matches
 * either unit regex above OR one of the unit-less compensation words/phrases below -- there was no single
 * pre-existing "is this a salary question" regex to reuse, only the two unit-detection regexes, so this
 * combines them per the amended spec's own fallback instruction. A real screening question routinely asks
 * for compensation with no "salary"/"hourly"/"annual" keyword at all ("Desired compensation", "What are
 * your pay expectations", "Base + bonus target", "OTE expectation"), and those must never fall through to
 * the generic bank matcher or a guessed plain-text fill just because they used different wording.
 *
 * Every alternative below is word-boundary-anchored so it never fires on "pay" as a mere substring of an
 * unrelated word ("PayPal", "payload") -- `\bpay\b` requires a non-word character (or string edge) on both
 * sides, which "PayPal"/"payload" never provide immediately after "pay".
 *   - `compensation`, `remuneration`, `wages?`, `OTE`, `pay`: bare, unambiguous compensation nouns.
 *   - `base ... bonus` / `bonus ... base` (up to 4 intervening words either order): "base salary plus
 *     bonus" phrasing, e.g. "Base + bonus target".
 *   - `rate ... expectation` / `expectation ... rate` (up to 4 intervening words either order): "rate
 *     expectation" phrasing, without requiring the word "pay" to appear too.
 *   - `(expected|desired|target)` followed within a few words by `(compensation|pay|salary|wage(s)|
 *     remuneration|OTE|rate|range)`: the proximity rule the amended spec calls for by name, so a bare
 *     "range" or "rate" only counts when explicitly framed as a compensation ask (an unqualified "range" or
 *     "rate" alone is too generic -- "date range", "conversion rate" -- to treat as salary-related on its
 *     own).
 *
 * Every adapter that answers a custom screening field checks this BEFORE the generic bank matcher/text
 * fill, so a salary-shaped question always routes through resolveSalaryAnswer() and never falls through to
 * an unrelated alias/synonym match or a guessed plain-text fill. Exported so every adapter (present and
 * future) shares the exact same detection regex rather than a private per-adapter copy that could silently
 * drift.
 */
export const SALARY_LABEL_RE = new RegExp(
  [
    HOURLY_RE.source,
    ANNUAL_RE.source,
    '\\bcompensation\\b',
    '\\bremuneration\\b',
    '\\bwages?\\b',
    '\\bOTE\\b',
    '\\bpay\\b',
    '\\bbase\\b(?:\\s+\\S+){0,4}\\s*\\bbonus\\b',
    '\\bbonus\\b(?:\\s+\\S+){0,4}\\s*\\bbase\\b',
    '\\brate\\b(?:\\s+\\S+){0,4}\\s*\\bexpectations?\\b',
    '\\bexpectations?\\b(?:\\s+\\S+){0,4}\\s*\\brate\\b',
    '\\b(?:expected|desired|target)\\b(?:\\s+\\S+){0,4}\\s*\\b(?:compensation|pay|salary|wages?|remuneration|OTE|rate|range)\\b',
  ].join('|'),
  'i',
);

/**
 * @typedef {Object} SalaryResult
 * @property {'answer'|'park'} outcome
 * @property {string} [reason] present when outcome is 'park'
 * @property {number} [value]
 * @property {'hourly'|'annual'} [unit]
 */

/**
 * Resolve a salary-expectation question. Unit basis is read from the question's own label text, never
 * guessed: both/neither of HOURLY_RE and ANNUAL_RE matching is ambiguous and parks. Only a plain 'text'
 * control ever produces an answer in this slice -- a range picker or a currency-amount widget always
 * parks, because "explicitly configured" support for those shapes does not exist yet (spec's own
 * qualifier: "unless explicitly configured"). The single number this function ever writes comes from
 * `bank.meta.salary_floor` (data/apply-answers.md, personal data, never config/); an hourly figure is
 * derived from it (floor / 2080, the standard full-time annual-hours divisor), never entered separately.
 * @param {{ label: unknown, controlType: unknown, bank: AnswerBank }} input
 * @returns {SalaryResult}
 */
export function resolveSalaryAnswer(input) {
  const label = typeof input.label === 'string' ? input.label : '';
  const isHourly = HOURLY_RE.test(label);
  const isAnnual = ANNUAL_RE.test(label);
  if (isHourly === isAnnual) {
    return { outcome: 'park', reason: isHourly ? 'ambiguous_unit_both_matched' : 'ambiguous_unit_unknown' };
  }
  if (input.controlType !== 'text') {
    return { outcome: 'park', reason: 'range_or_currency_shape_not_configured' };
  }
  const floor = input.bank?.meta?.salary_floor;
  if (typeof floor !== 'number' || !Number.isFinite(floor)) {
    return { outcome: 'park', reason: 'salary_floor_not_configured' };
  }
  if (isHourly) {
    return { outcome: 'answer', value: Math.round((floor / 2080) * 100) / 100, unit: 'hourly' };
  }
  return { outcome: 'answer', value: floor, unit: 'annual' };
}
