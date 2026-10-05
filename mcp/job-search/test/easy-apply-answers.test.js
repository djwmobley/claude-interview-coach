// @ts-check
/**
 * src/apply/easy-apply-answers.js (assisted Easy Apply, spec G6): the SERVER resolves every value; the
 * model never supplies one. Exact normalized-key match against the answer bank's learned tier and the
 * contact facts only; any non-exact question parks; optional questions without an exact match stay blank;
 * select/radio values must exactly match one option; "Follow company" is never touched. Includes the
 * near-miss sponsorship phrasings the spec calls out.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswerBank } from '../src/apply/answers.js';
import { resolveFieldAnswer, CONTACT_LABELS, sanitizeValue } from '../src/apply/easy-apply-answers.js';

const BANK = parseAnswerBank([
  '## first_name', 'type: text', 'value: Damian',
  '## last_name', 'type: text', 'value: Mobley',
  '## phone', 'type: text', 'value: 7135550100',
  '## phone_country_code', 'type: text', 'value: United States (+1)',
  '## sponsorship_needed', 'type: boolean', 'value: false',
  'learned: Will you now or in the future require sponsorship for employment visa status?',
  'aliases: Do you require visa sponsorship',
  '## work_authorization', 'type: boolean', 'value: true',
  'learned: Are you legally authorized to work in the United States?',
  '## years_leadership', 'type: text', 'value: 20',
  'learned: How many years of technology leadership experience do you have?',
].join('\n'));

const ctx = { bank: BANK, accountEmail: 'owner@example.com' };

describe('resolveFieldAnswer: contact facts', () => {
  test('contact labels map exactly to contact fact keys', () => {
    assert.equal(CONTACT_LABELS['first name'], 'first_name');
    assert.equal(CONTACT_LABELS['mobile phone number'], 'phone');
  });
  test('first name fills from the bank', () => {
    const r = resolveFieldAnswer({ question: 'First name', kind: 'text', required: true, options: [] }, ctx);
    assert.deepEqual(r, { action: 'fill', value: 'Damian', bankKey: 'first_name', source: 'contact' });
  });
  test('email falls back to the application account email (a DB value, never the model)', () => {
    const r = resolveFieldAnswer({ question: 'Email address', kind: 'select', required: true, options: ['owner@example.com', 'other@example.com'] }, ctx);
    assert.deepEqual(r, { action: 'fill', value: 'owner@example.com', bankKey: 'email', source: 'contact' });
  });
  test('phone country code select must match an option exactly', () => {
    const ok = resolveFieldAnswer({ question: 'Phone country code', kind: 'select', required: true, options: ['United States (+1)', 'Canada (+1)'] }, ctx);
    assert.equal(ok.action, 'fill');
    const miss = resolveFieldAnswer({ question: 'Phone country code', kind: 'select', required: true, options: ['United States +1'] }, ctx);
    assert.deepEqual(miss, { action: 'park', reason: 'no_exact_option', bankKey: 'phone_country_code' });
  });
  test('a required contact field with no bank fact parks', () => {
    const empty = { bank: parseAnswerBank(''), accountEmail: null };
    assert.deepEqual(resolveFieldAnswer({ question: 'First name', kind: 'text', required: true, options: [] }, empty), { action: 'park', reason: 'no_bank_fact', bankKey: 'first_name' });
  });
  test('an optional contact field with no bank fact stays blank', () => {
    const empty = { bank: parseAnswerBank(''), accountEmail: null };
    assert.deepEqual(resolveFieldAnswer({ question: 'City', kind: 'text', required: false, options: [] }, empty), { action: 'skip_optional', reason: 'no_bank_fact' });
  });
});

describe('resolveFieldAnswer: learned tier only', () => {
  test('exact learned sponsorship label on a radio picks the one matching option', () => {
    const r = resolveFieldAnswer({ question: 'Will you now or in the future require sponsorship for employment visa status?', kind: 'radio', required: true, options: ['Yes', 'No'] }, ctx);
    assert.deepEqual(r, { action: 'fill', value: 'No', bankKey: 'sponsorship_needed', source: 'learned' });
  });
  const nearMisses = [
    'Will you now, or in the future, require sponsorship for employment visa status?',
    'Will you now or in the future require sponsorship for employment visa status (e.g. H-1B)?',
    'Will you in the future require sponsorship for employment visa status?',
    'Do you require visa sponsorship',
    'Do you now or will you in the future require sponsorship?',
  ];
  for (const q of nearMisses) {
    test(`near-miss sponsorship question parks: "${q}"`, () => {
      const r = resolveFieldAnswer({ question: q, kind: 'radio', required: true, options: ['Yes', 'No'] }, ctx);
      assert.equal(r.action, 'park');
    });
  }
  test('an alias-tier hit never auto-answers (parks with the reason)', () => {
    const r = resolveFieldAnswer({ question: 'Do you require visa sponsorship', kind: 'radio', required: true, options: ['Yes', 'No'] }, ctx);
    assert.deepEqual(r, { action: 'park', reason: 'not_exact_learned', bankKey: 'sponsorship_needed' });
  });
  test('an optional question without an exact match stays blank', () => {
    assert.deepEqual(resolveFieldAnswer({ question: 'Website', kind: 'text', required: false, options: [] }, ctx), { action: 'skip_optional', reason: 'no_exact_match' });
  });
  test('a required question without an exact match parks', () => {
    assert.deepEqual(resolveFieldAnswer({ question: 'Website', kind: 'text', required: true, options: [] }, ctx), { action: 'park', reason: 'no_exact_match', bankKey: null });
  });
  test('select whose options do not contain the bank value exactly parks', () => {
    const r = resolveFieldAnswer({ question: 'Are you legally authorized to work in the United States?', kind: 'select', required: true, options: ['Yes, I am', 'No'] }, ctx);
    assert.equal(r.action, 'park');
    assert.equal(r.reason, 'no_exact_option');
  });
  test('select with two equally-normalized options parks (never picks one)', () => {
    const r = resolveFieldAnswer({ question: 'Are you legally authorized to work in the United States?', kind: 'select', required: true, options: ['Yes', 'yes.'] }, ctx);
    assert.equal(r.action, 'park');
  });
  test('learned text answer fills', () => {
    assert.deepEqual(resolveFieldAnswer({ question: 'How many years of technology leadership experience do you have?', kind: 'text', required: true, options: [] }, ctx), { action: 'fill', value: '20', bankKey: 'years_leadership', source: 'learned' });
  });
  test('compensation questions always park, even when required', () => {
    const r = resolveFieldAnswer({ question: 'What are your salary expectations?', kind: 'text', required: true, options: [] }, ctx);
    assert.deepEqual(r, { action: 'park', reason: 'compensation_question', bankKey: null });
  });
});

describe('resolveFieldAnswer: totality', () => {
  test('Follow company is left untouched', () => {
    assert.deepEqual(resolveFieldAnswer({ question: 'Follow Acme Corp to stay up to date with their page.', kind: 'checkbox', required: false, options: [] }, ctx), { action: 'leave', reason: 'follow_company' });
  });
  test('file inputs and unknown kinds park (resume goes through upload_resume, never answer)', () => {
    assert.equal(resolveFieldAnswer({ question: 'Resume', kind: 'file', required: true, options: [] }, ctx).action, 'park');
    assert.equal(resolveFieldAnswer({ question: 'x', kind: /** @type {any} */ ('weird'), required: true, options: [] }, ctx).action, 'park');
  });
  test('an empty question parks', () => {
    assert.equal(resolveFieldAnswer({ question: '', kind: 'text', required: true, options: [] }, ctx).action, 'park');
  });
  test('sanitizeValue strips CR and LF', () => {
    assert.equal(sanitizeValue('a\r\nb\nc\rd'), 'a b c d');
  });
});
