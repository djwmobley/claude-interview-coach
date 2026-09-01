// @ts-check
/**
 * src/apply/answers.js (apply pipeline slice 4): parser fatal cases, all three match tiers with
 * precedence, alias-hit-parks-with-suggestion behavior, option normalization edge cases, control-type
 * totality, polarity, salary unit/range/currency parking, and EEO taxonomy mapping both directions. Pure
 * functions throughout -- no database, no filesystem.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAnswerBank, appendLearnedLabel, normalizeText, matchQuestion, resolveControl, CONTROL_TYPES,
  taxonomyOptionsFor, taxonomyCanonicalFor, resolveSalaryAnswer, validateAnswerAgainstOptions, isDurableFactType,
} from '../src/apply/answers.js';

const SAMPLE = `
salary_floor: 150000

## eeo_gender
type: enum
value: male
aliases: what is your gender

## sponsorship_needed
type: boolean
value: false
aliases: will you now or in the future require visa sponsorship
aliases: are you legally authorized to work without sponsorship :: invert
learned: do you need visa sponsorship to work here

## eeo_race_ethnicity
type: enum
value: white_not_hispanic_or_latino
aliases: race/ethnicity

## how_heard
type: text
aliases: how did you hear about us
`;

describe('parseAnswerBank: happy path', () => {
  test('parses facts, aliases, learned labels, and meta.salary_floor', () => {
    const bank = parseAnswerBank(SAMPLE);
    assert.equal(bank.meta.salary_floor, 150000);
    assert.equal(bank.facts.get('eeo_gender').value, 'male');
    assert.equal(bank.facts.get('sponsorship_needed').value, false);
    assert.equal(bank.facts.get('eeo_race_ethnicity').type, 'enum');
    assert.equal(bank.facts.get('how_heard').type, 'text');
    assert.equal(bank.labels.get('what is your gender').key, 'eeo_gender');
    assert.equal(bank.labels.get('do you need visa sponsorship to work here').tier, 'learned');
    assert.equal(bank.labels.get('are you legally authorized to work without sponsorship').polarity, 'invert');
    assert.equal(bank.labels.get('will you now or in the future require visa sponsorship').polarity, 'same');
  });

  test('reordering lines within a section and across sections parses identically', () => {
    // salary_floor (a top-level meta line) must still precede the first "##" section -- that is the one
    // legitimate ordering constraint this grammar has. Everything else here is deliberately scrambled:
    // sections in a different order, and every field within each section in a different order, including
    // moving "aliases:" lines above "type:"/"value:" and splitting a key's aliases across non-adjacent
    // lines.
    const reordered = `
salary_floor: 150000

## how_heard
aliases: how did you hear about us
type: text

## eeo_gender
aliases: what is your gender
value: male
type: enum

## sponsorship_needed
learned: do you need visa sponsorship to work here
aliases: are you legally authorized to work without sponsorship :: invert
value: false
type: boolean
aliases: will you now or in the future require visa sponsorship

## eeo_race_ethnicity
value: white_not_hispanic_or_latino
type: enum
aliases: race/ethnicity
`;
    const bank = parseAnswerBank(reordered);
    const original = parseAnswerBank(SAMPLE);
    assert.deepEqual([...bank.facts.keys()].sort(), [...original.facts.keys()].sort());
    for (const key of original.facts.keys()) {
      assert.deepEqual(bank.facts.get(key), original.facts.get(key), `fact ${key} differs after reordering`);
    }
    assert.deepEqual([...bank.labels.entries()].sort(), [...original.labels.entries()].sort());
  });

  test('CRLF line endings parse identically to LF', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const bank = parseAnswerBank(crlf);
    const original = parseAnswerBank(SAMPLE);
    assert.deepEqual([...bank.facts.keys()].sort(), [...original.facts.keys()].sort());
    assert.equal(bank.facts.get('eeo_gender').value, 'male');
    assert.equal(bank.meta.salary_floor, 150000);
  });
});

describe('parseAnswerBank: fatal cases', () => {
  test('duplicate section key is fatal', () => {
    const text = `## eeo_gender\ntype: enum\nvalue: male\n\n## eeo_gender\ntype: enum\nvalue: male\n`;
    assert.throws(() => parseAnswerBank(text), /duplicate key "eeo_gender"/);
  });

  test('duplicate alias under the same key is fatal', () => {
    const text = `## eeo_gender\ntype: enum\nvalue: male\naliases: what is your gender\naliases: what is your gender\n`;
    assert.throws(() => parseAnswerBank(text), /duplicate label/);
  });

  test('the same alias label across two different keys is fatal', () => {
    const text = `## key_a\ntype: enum\nvalue: x\naliases: same question\n\n## key_b\ntype: enum\nvalue: y\naliases: same question\n`;
    assert.throws(() => parseAnswerBank(text), /duplicate label/);
  });

  test('an alias colliding with a learned label (different tiers, same normalized text) is fatal', () => {
    const text = `## key_a\ntype: enum\nvalue: x\nlearned: same question\n\n## key_b\ntype: enum\nvalue: y\naliases: same question\n`;
    assert.throws(() => parseAnswerBank(text), /duplicate label/);
  });

  test('malformed section key is fatal', () => {
    assert.throws(() => parseAnswerBank(`## Eeo-Gender\ntype: enum\nvalue: x\n`), /must match/);
  });

  test('unrecognized top-level line before any section is fatal', () => {
    assert.throws(() => parseAnswerBank(`not a real directive\n\n## k\ntype: text\n`), /unrecognized top-level line/);
  });

  test('unrecognized line inside a section is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\ntype: text\nbogus: line\n`), /unrecognized line under key "k"/);
  });

  test('missing type: is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\nvalue: x\n`), /missing "type:"/);
  });

  test('missing value: for a non-text type is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\ntype: enum\n`), /missing "value:"/);
  });

  test('a text-type key without value: is fine (narrative fields have no fixed value)', () => {
    const bank = parseAnswerBank(`## how_heard\ntype: text\n`);
    assert.equal(bank.facts.get('how_heard').value, undefined);
  });

  test('duplicate type: within one key is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\ntype: enum\ntype: text\nvalue: x\n`), /duplicate "type:"/);
  });

  test('duplicate value: within one key is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\ntype: enum\nvalue: x\nvalue: y\n`), /duplicate "value:"/);
  });

  test('boolean value: that is not "true"/"false" is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\ntype: boolean\nvalue: yes\n`), /must be "true" or "false"/);
  });

  test('an "::invert" alias on a non-boolean key is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\ntype: enum\nvalue: x\naliases: some question :: invert\n`), /is not type boolean/);
  });

  test('an unrecognized alias modifier is fatal', () => {
    assert.throws(() => parseAnswerBank(`## k\ntype: boolean\nvalue: true\naliases: some question :: reverse\n`), /unrecognized alias modifier/);
  });

  test('duplicate salary_floor is fatal', () => {
    assert.throws(() => parseAnswerBank(`salary_floor: 100\nsalary_floor: 200\n\n## k\ntype: text\n`), /duplicate salary_floor/);
  });
});

describe('normalizeText: pinned normalization', () => {
  test('lowercases, trims, collapses whitespace, strips trailing punctuation, keeps parentheticals', () => {
    assert.equal(normalizeText('  What   IS your Gender?  '), 'what is your gender');
    assert.equal(normalizeText('White (Not Hispanic or Latino).'), 'white (not hispanic or latino)');
    assert.equal(normalizeText('Race/Ethnicity:'), 'race/ethnicity');
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
    assert.equal(normalizeText(42), '');
  });
});

describe('matchQuestion: three tiers, precedence, and park-with-suggestion', () => {
  const bank = parseAnswerBank(SAMPLE);

  test('tier 1 (learned): auto-answers with a resolved control result', () => {
    const result = matchQuestion(bank, { label: 'Do you need visa sponsorship to work here?', controlType: 'text' });
    assert.equal(result.tier, 'learned');
    assert.equal(result.outcome, 'auto_answer');
    assert.equal(result.value, false);
  });

  test('tier 2 (alias): parks with a suggestion, never auto-answers', () => {
    const result = matchQuestion(bank, { label: 'What is your gender?', controlType: 'text' });
    assert.equal(result.tier, 'alias');
    assert.equal(result.outcome, 'needs_human_suggestion');
    assert.deepEqual(result.suggestion, { key: 'eeo_gender', value: 'male' });
  });

  test('tier 3 (synonym table): a label not in the bank at all still resolves via the built-in table, parked', () => {
    const result = matchQuestion(bank, { label: 'What is your race or ethnicity?', controlType: 'text' });
    assert.equal(result.tier, 'synonym');
    assert.equal(result.key, 'eeo_race_ethnicity');
    assert.equal(result.outcome, 'needs_human_suggestion');
  });

  test('no tier matches: parks with no suggestion at all, never guesses', () => {
    const result = matchQuestion(bank, { label: 'What is your favorite color?', controlType: 'text' });
    assert.equal(result.tier, 'none');
    assert.equal(result.outcome, 'needs_human_no_match');
    assert.equal(result.suggestion, undefined);
  });

  test('precedence: a bank alias beats a colliding synonym-table entry for the same normalized label', () => {
    // 'are you eligible to work in this country' is in SYNONYM_TABLE pointing at work_authorization; here
    // it is also hand-aliased in the bank to a different key, and the bank entry must win.
    const localBank = parseAnswerBank(`## eeo_gender\ntype: enum\nvalue: male\naliases: are you eligible to work in this country\n`);
    const result = matchQuestion(localBank, { label: 'Are you eligible to work in this country?', controlType: 'text' });
    assert.equal(result.tier, 'alias');
    assert.equal(result.key, 'eeo_gender');
  });

  test('precedence: a bank learned label beats a colliding synonym-table entry and still auto-answers', () => {
    const localBank = parseAnswerBank(`## eeo_gender\ntype: enum\nvalue: male\nlearned: are you eligible to work in this country\n`);
    const result = matchQuestion(localBank, { label: 'Are you eligible to work in this country?', controlType: 'text' });
    assert.equal(result.tier, 'learned');
    assert.equal(result.outcome, 'auto_answer');
    assert.equal(result.key, 'eeo_gender');
  });

  test('polarity: an "::invert" alias flips the boolean value in the suggestion', () => {
    const result = matchQuestion(bank, { label: 'Are you legally authorized to work without sponsorship?', controlType: 'text' });
    assert.equal(result.tier, 'alias');
    // sponsorship_needed's stored value is false; the invert alias means "yes on THIS phrasing" would
    // correspond to sponsorship_needed staying false, i.e. the resolved fact value here is the negation
    // of the raw stored value: !false = true is what "authorized WITHOUT sponsorship" resolves to as the
    // fact being suggested. This asserts the polarity flip actually happened, not just that a value exists.
    assert.equal(result.suggestion.value, true);
  });
});

describe('resolveControl: total classification over CONTROL_TYPES', () => {
  const boolFact = { key: 'sponsorship_needed', type: 'boolean', value: false };
  const enumFact = { key: 'eeo_race_ethnicity', type: 'enum', value: 'white_not_hispanic_or_latino' };

  test('unknown/undefined/null control type always parks as unsupported_control_type', () => {
    for (const ct of ['dropdown', undefined, null, 42, '']) {
      const r = resolveControl({ controlType: ct, fact: boolFact, value: false, options: undefined });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'unsupported_control_type');
    }
  });

  test('CONTROL_TYPES is exactly the five documented values', () => {
    assert.deepEqual([...CONTROL_TYPES].sort(), ['boolean', 'checkbox-group', 'multiselect', 'radio', 'text'].sort());
  });

  test('"text" control: boolean fact renders Yes/No, non-boolean renders String(value)', () => {
    assert.equal(resolveControl({ controlType: 'text', fact: boolFact, value: true }).text, 'Yes');
    assert.equal(resolveControl({ controlType: 'text', fact: boolFact, value: false }).text, 'No');
    assert.equal(resolveControl({ controlType: 'text', fact: enumFact, value: 'white_not_hispanic_or_latino' }).text, 'white_not_hispanic_or_latino');
  });

  test('"boolean" control with no options: returns checked directly, no option matching', () => {
    const r = resolveControl({ controlType: 'boolean', fact: boolFact, value: true, options: undefined });
    assert.equal(r.ok, true);
    assert.equal(r.checked, true);
  });

  test('"boolean" control WITH options: resolves via option matching (0/2+ park)', () => {
    const ok = resolveControl({ controlType: 'boolean', fact: boolFact, value: true, options: ['Yes', 'No'] });
    assert.equal(ok.ok, true);
    assert.equal(ok.selectedOption, 'Yes');
    const zero = resolveControl({ controlType: 'boolean', fact: boolFact, value: true, options: ['Maybe', 'Never'] });
    assert.equal(zero.ok, false);
    assert.equal(zero.reason, 'zero_candidates');
  });

  test('"radio"/"checkbox-group" require an options list, park with no_options_provided when absent', () => {
    for (const ct of ['radio', 'checkbox-group']) {
      const r = resolveControl({ controlType: ct, fact: enumFact, value: 'white_not_hispanic_or_latino', options: [] });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'no_options_provided');
    }
  });

  test('option normalization: 0 candidates parks', () => {
    const r = resolveControl({ controlType: 'radio', fact: enumFact, value: 'white_not_hispanic_or_latino', options: ['Asian', 'Black or African American'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'zero_candidates');
  });

  test('option normalization: 2+ candidates parks (never guesses which one)', () => {
    const dupFact = { key: 'no_taxonomy_key', type: 'enum', value: 'foo' };
    const r = resolveControl({ controlType: 'radio', fact: dupFact, value: 'foo', options: ['Foo', 'foo.', 'Bar'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'multiple_candidates');
  });

  test('option normalization: exactly 1 candidate after normalization matches (case/punctuation/whitespace insensitive)', () => {
    const dupFact = { key: 'no_taxonomy_key', type: 'enum', value: 'foo' };
    const r = resolveControl({ controlType: 'radio', fact: dupFact, value: 'foo', options: ['  FOO.  ', 'Bar'] });
    assert.equal(r.ok, true);
    assert.equal(r.selectedOption, '  FOO.  ');
  });

  test('"multiselect" uses full-set semantics: every token must resolve to exactly one option, or the whole match parks', () => {
    const msFact = { key: 'no_taxonomy_key', type: 'multiselect', value: ['a', 'b'] };
    const ok = resolveControl({ controlType: 'multiselect', fact: msFact, value: ['a', 'b'], options: ['A', 'B', 'C'] });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.selectedOption, ['A', 'B']);
    const partial = resolveControl({ controlType: 'multiselect', fact: msFact, value: ['a', 'zzz'], options: ['A', 'B', 'C'] });
    assert.equal(partial.ok, false);
    assert.equal(partial.reason, 'multiselect_zero_candidates');
  });

  test('"multiselect" with a non-array value parks', () => {
    const msFact = { key: 'no_taxonomy_key', type: 'multiselect', value: 'a' };
    const r = resolveControl({ controlType: 'multiselect', fact: msFact, value: 'a', options: ['A'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'multiselect_value_not_array');
  });
});

describe('EEO taxonomy: both directions', () => {
  test('forward: canonical value -> the site-option strings accepted for it (normalized)', () => {
    const options = taxonomyOptionsFor('eeo_race_ethnicity', 'white_not_hispanic_or_latino');
    assert.ok(options.includes(normalizeText('White (Not Hispanic or Latino)')));
    assert.ok(options.includes(normalizeText('White/Caucasian')));
  });

  test('reverse: a site option string -> the canonical value it represents', () => {
    assert.equal(taxonomyCanonicalFor('eeo_race_ethnicity', 'White/Caucasian'), 'white_not_hispanic_or_latino');
    assert.equal(taxonomyCanonicalFor('eeo_race_ethnicity', 'Black or African American'), 'black_or_african_american');
    assert.equal(taxonomyCanonicalFor('eeo_race_ethnicity', 'Not a real option'), null);
  });

  test('a key with no registered taxonomy returns null in both directions', () => {
    assert.equal(taxonomyOptionsFor('eeo_gender', 'male'), null);
    assert.equal(taxonomyCanonicalFor('eeo_gender', 'Male'), null);
  });

  test('option matching actually uses the taxonomy: a differently-worded site option still resolves to exactly one candidate', () => {
    const fact = { key: 'eeo_race_ethnicity', type: 'enum', value: 'white_not_hispanic_or_latino' };
    const r = resolveControl({
      controlType: 'radio', fact, value: 'white_not_hispanic_or_latino',
      options: ['White (Not Hispanic or Latino)', 'Black or African American (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.selectedOption, 'White (Not Hispanic or Latino)');
  });
});

describe('resolveSalaryAnswer: unit-basis detection and single-configured-floor', () => {
  const bank = { meta: { salary_floor: 150000 } };
  const noFloorBank = { meta: { salary_floor: null } };

  test('annual label + text control + configured floor: answers with the floor', () => {
    const r = resolveSalaryAnswer({ label: 'What is your desired annual salary?', controlType: 'text', bank });
    assert.equal(r.outcome, 'answer');
    assert.equal(r.unit, 'annual');
    assert.equal(r.value, 150000);
  });

  test('hourly label + text control + configured floor: answers with floor/2080', () => {
    const r = resolveSalaryAnswer({ label: 'What is your desired hourly rate?', controlType: 'text', bank });
    assert.equal(r.outcome, 'answer');
    assert.equal(r.unit, 'hourly');
    assert.equal(r.value, Math.round((150000 / 2080) * 100) / 100);
  });

  test('a label matching neither hourly nor annual wording is ambiguous and parks', () => {
    const r = resolveSalaryAnswer({ label: 'What are your compensation expectations?', controlType: 'text', bank });
    assert.equal(r.outcome, 'park');
    assert.equal(r.reason, 'ambiguous_unit_unknown');
  });

  test('a label matching BOTH hourly and annual wording is ambiguous and parks', () => {
    const r = resolveSalaryAnswer({ label: 'Annual salary or hourly rate, whichever applies', controlType: 'text', bank });
    assert.equal(r.outcome, 'park');
    assert.equal(r.reason, 'ambiguous_unit_both_matched');
  });

  test('a non-text control (range/currency picker) always parks, unconfigured', () => {
    const r = resolveSalaryAnswer({ label: 'Desired annual salary', controlType: 'radio', bank });
    assert.equal(r.outcome, 'park');
    assert.equal(r.reason, 'range_or_currency_shape_not_configured');
  });

  test('no salary_floor configured: parks even with an unambiguous unit and a text control', () => {
    const r = resolveSalaryAnswer({ label: 'Desired annual salary', controlType: 'text', bank: noFloorBank });
    assert.equal(r.outcome, 'park');
    assert.equal(r.reason, 'salary_floor_not_configured');
  });
});

describe('appendLearnedLabel: promote-on-confirm text transform', () => {
  test('appends a learned: line to the correct section, leaving everything else byte-identical', () => {
    const updated = appendLearnedLabel(SAMPLE, 'eeo_gender', 'What gender do you identify as?');
    const bank = parseAnswerBank(updated);
    const normLabel = normalizeText('What gender do you identify as?');
    assert.equal(bank.labels.get(normLabel).tier, 'learned');
    assert.equal(bank.labels.get(normLabel).key, 'eeo_gender');
    // Every previously-existing label still parses the same.
    assert.equal(bank.labels.get('what is your gender').key, 'eeo_gender');
  });

  test('idempotent: appending the same (normalized) label twice does not create a duplicate', () => {
    const once = appendLearnedLabel(SAMPLE, 'eeo_gender', 'What gender do you identify as?');
    const twice = appendLearnedLabel(once, 'eeo_gender', 'WHAT GENDER DO YOU IDENTIFY AS?');
    assert.equal(once, twice);
    // And the result still parses without a duplicate-label error.
    assert.doesNotThrow(() => parseAnswerBank(twice));
  });

  test('throws when the key does not exist in the bank', () => {
    assert.throws(() => appendLearnedLabel(SAMPLE, 'not_a_real_key', 'x'), /not found in bank/);
  });
});

describe('validateAnswerAgainstOptions / isDurableFactType', () => {
  test('isDurableFactType: boolean/enum/multiselect are durable, text is not', () => {
    assert.equal(isDurableFactType('boolean'), true);
    assert.equal(isDurableFactType('enum'), true);
    assert.equal(isDurableFactType('multiselect'), true);
    assert.equal(isDurableFactType('text'), false);
    assert.equal(isDurableFactType(null), false);
  });

  test('validateAnswerAgainstOptions: no options list trivially validates', () => {
    const fact = { key: 'how_heard', type: 'text', value: undefined };
    assert.deepEqual(validateAnswerAgainstOptions(fact, 'LinkedIn', undefined), { ok: true });
  });

  test('validateAnswerAgainstOptions: a value with no matching option is rejected before it could be saved', () => {
    const fact = { key: 'eeo_race_ethnicity', type: 'enum', value: 'white_not_hispanic_or_latino' };
    const r = validateAnswerAgainstOptions(fact, 'white_not_hispanic_or_latino', ['Asian', 'Black or African American']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'zero_candidates');
  });

  test('validateAnswerAgainstOptions: a value matching exactly one option validates', () => {
    const fact = { key: 'eeo_race_ethnicity', type: 'enum', value: 'white_not_hispanic_or_latino' };
    const r = validateAnswerAgainstOptions(fact, 'white_not_hispanic_or_latino', ['White (Not Hispanic or Latino)', 'Asian']);
    assert.deepEqual(r, { ok: true });
  });
});
