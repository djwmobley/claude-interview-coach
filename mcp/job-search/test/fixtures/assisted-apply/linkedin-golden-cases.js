// @ts-check
/**
 * Representative inputs for the LinkedIn rules golden test (test/assisted-apply-golden.test.js). The
 * expected outputs live in linkedin-golden.json next to this file and were captured from the
 * pre-refactor src/apply/easy-apply-guard.js and src/apply/easy-apply-answers.js (before the assisted
 * driver and profile object existed). Never regenerate the JSON from the code under test to make a
 * failure go away: a diff here is a LinkedIn behavior change.
 */

/** @param {Record<string, unknown>} o */
const btn = (o = {}) => ({
  tag: 'button', inDialog: true, disabled: false, ariaLabel: '', labelledByText: '', visibleText: 'Next',
  textContent: 'Next', title: '', value: '', dataAttrs: [], ...o,
});

/** Button descriptors for classifyAdvanceButton and isSubmitMarked. */
export const BUTTONS = Object.freeze([
  ['plain next', btn()],
  ['continue', btn({ visibleText: 'Continue', textContent: 'Continue' })],
  ['continue to next step aria', btn({ ariaLabel: 'Continue to next step', dataAttrs: [['data-easy-apply-next-button', ''], ['data-live-test-easy-apply-next-button', '']] })],
  ['review', btn({ ariaLabel: 'Review your application', visibleText: 'Review', textContent: 'Review' })],
  ['review plain', btn({ visibleText: 'Review', textContent: 'Review' })],
  ['next with arrow', btn({ visibleText: 'Next  >', textContent: 'Next  >' })],
  ['next nbsp and zero width', btn({ visibleText: 'Ne​xt ', textContent: 'Ne​xt ' })],
  ['anchor', btn({ tag: 'a' })],
  ['input', btn({ tag: 'input', value: 'Next' })],
  ['outside dialog', btn({ inDialog: false })],
  ['disabled', btn({ disabled: true })],
  ['submit application', btn({ visibleText: 'Submit application', textContent: 'Submit application' })],
  ['hidden span submit', btn({ textContent: 'Next Submit application' })],
  ['aria submit text next', btn({ ariaLabel: 'Submit application' })],
  ['aria next text send', btn({ ariaLabel: 'Next', visibleText: 'Send', textContent: 'Send' })],
  ['data value submit', btn({ dataAttrs: [['data-control-name', 'submit_unify']] })],
  ['data name submit', btn({ dataAttrs: [['data-live-test-easy-apply-submit-button', '']] })],
  ['data send', btn({ dataAttrs: [['data-x', 'send']] })],
  ['data done', btn({ dataAttrs: [['data-state', 'done']] })],
  ['data easy-apply only', btn({ dataAttrs: [['data-easy-apply-next-button', '']] })],
  ['apply word', btn({ visibleText: 'Apply', textContent: 'Apply' })],
  ['apply now', btn({ visibleText: 'Apply now', textContent: 'Apply now' })],
  ['easy apply', btn({ visibleText: 'Easy Apply', textContent: 'Easy Apply' })],
  ['applying word (no word boundary)', btn({ visibleText: 'Applying', textContent: 'Applying' })],
  ['done', btn({ visibleText: 'Done', textContent: 'Done' })],
  ['title send', btn({ title: 'Send now' })],
  ['labelledby submit', btn({ labelledByText: 'Submit' })],
  ['value submit', btn({ value: 'submit' })],
  ['fullwidth submit (NFKC)', btn({ visibleText: 'Ｓubmit', textContent: 'Ｓubmit' })],
  ['zero width inside submit', btn({ visibleText: 'Sub​mit', textContent: 'Sub​mit' })],
  ['empty', btn({ visibleText: '', textContent: '' })],
  ['whitespace only', btn({ visibleText: ' ​ ', textContent: ' ​ ' })],
  ['dismiss', btn({ visibleText: 'Dismiss', textContent: 'Dismiss' })],
  ['next vs finish', btn({ ariaLabel: 'Next', visibleText: 'Finish', textContent: 'Finish' })],
  ['review aria next text', btn({ ariaLabel: 'Review your application', visibleText: 'Next', textContent: 'Next' })],
  ['next step', btn({ visibleText: 'Next step', textContent: 'Next step' })],
  ['localized postular with marker', { ariaLabel: 'Postular', visibleText: '', textContent: '', dataAttrs: [['data-live-test-easy-apply-submit-button', '']] }],
  ['non-array data attrs', btn({ dataAttrs: 'submit' })],
  ['malformed data pair', btn({ dataAttrs: ['submit', ['data-ok', 'x']] })],
  ['null', null],
  ['string', 'Next'],
]);

/** Inputs for checkNotLastStep. */
export const LAST_STEP = Object.freeze([
  ['next 50', { buttonKind: 'next', progressValues: [50], submitVisible: false }],
  ['next 0', { buttonKind: 'next', progressValues: [0], submitVisible: false }],
  ['next 99', { buttonKind: 'next', progressValues: [99], submitVisible: false }],
  ['next 100', { buttonKind: 'next', progressValues: [100], submitVisible: false }],
  ['next agree within 1', { buttonKind: 'next', progressValues: [33, 34], submitVisible: false }],
  ['next disagree', { buttonKind: 'next', progressValues: [25, 75], submitVisible: false }],
  ['next negative', { buttonKind: 'next', progressValues: [-5], submitVisible: false }],
  ['next nan', { buttonKind: 'next', progressValues: [Number.NaN], submitVisible: false }],
  ['next string value', { buttonKind: 'next', progressValues: ['50'], submitVisible: false }],
  ['next empty', { buttonKind: 'next', progressValues: [], submitVisible: false }],
  ['next submit visible', { buttonKind: 'next', progressValues: [50], submitVisible: true }],
  ['review', { buttonKind: 'review', progressValues: [], submitVisible: false }],
  ['review submit visible', { buttonKind: 'review', progressValues: [], submitVisible: true }],
  ['raw name', { buttonKind: 'continue to next step', progressValues: [50], submitVisible: false }],
  ['null kind', { buttonKind: null, progressValues: [10], submitVisible: false }],
  ['null input', null],
]);

const LI = 'https://www.linkedin.com/jobs/view/1/';
/** Inputs for classifyStep. */
export const STEPS = Object.freeze([
  ['form', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: '', url: LI }],
  ['review', { dialogPresent: true, headerTexts: ['Review your application'], submitVisible: true, dialogText: '', pageText: '', url: LI }],
  ['review header only', { dialogPresent: true, headerTexts: ['Review your application'], submitVisible: false, dialogText: '', pageText: '', url: LI }],
  ['submit visible', { dialogPresent: true, headerTexts: [], submitVisible: true, dialogText: '', pageText: '', url: LI }],
  ['submit visible truthy non-boolean', { dialogPresent: true, headerTexts: ['Review your application'], submitVisible: 1, dialogText: '', pageText: '', url: LI }],
  ['sent dialog', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: 'Your application was sent to Acme', pageText: '', url: LI }],
  ['submitted page', { dialogPresent: false, headerTexts: [], submitVisible: false, dialogText: '', pageText: 'Application submitted', url: LI }],
  ['checkpoint url', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: '', url: 'https://www.linkedin.com/checkpoint/challenge/x' }],
  ['authwall url', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: '', url: 'https://www.linkedin.com/authwall?trk=x' }],
  ['login url', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: '', url: 'https://www.linkedin.com/uas/login?session_redirect=x' }],
  ['captcha query', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: '', url: 'https://www.linkedin.com/x?captcha=1' }],
  ['unusual activity', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: 'We have detected unusual activity', url: LI }],
  ['429', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: 'HTTP 429 Too Many Requests', url: LI }],
  ['sign in to continue in dialog', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: 'Please sign in to continue', pageText: '', url: LI }],
  ['verify human', { dialogPresent: true, headerTexts: [], submitVisible: false, dialogText: '', pageText: "Verify you're a human", url: LI }],
  ['no dialog', { dialogPresent: false, headerTexts: [], submitVisible: false, dialogText: '', pageText: '', url: LI }],
  ['precedence', { dialogPresent: true, headerTexts: ['Review your application'], submitVisible: true, dialogText: 'Application sent', pageText: '', url: 'https://www.linkedin.com/checkpoint/x' }],
  ['non-string fields', { dialogPresent: true, headerTexts: 'Review your application', submitVisible: true, dialogText: 5, pageText: null, url: undefined }],
  ['null', null],
]);

/** Inputs for verifyResumeCards. */
export const CARDS = Object.freeze([
  ['one selected match', [[{ name: 'a.docx', selected: true }, { name: 'old.pdf', selected: false }], 'a.docx']],
  ['not selected', [[{ name: 'a.docx', selected: false }, { name: 'old.pdf', selected: true }], 'a.docx']],
  ['two selected', [[{ name: 'a.docx', selected: true }, { name: 'b.pdf', selected: true }], 'a.docx']],
  ['none', [[], 'a.docx']],
  ['renamed', [[{ name: 'a (1).docx', selected: true }], 'a.docx']],
  ['whitespace collapse', [[{ name: ' a   b.docx ', selected: true }], 'a b.docx']],
  ['empty expected', [[{ name: '', selected: true }], '']],
  ['non-array', [null, 'a.docx']],
]);

/** Answer bank text for resolveFieldAnswer (parsed by src/apply/answers.js parseAnswerBank). */
export const BANK_TEXT = [
  '## first_name', 'type: text', 'value: Damian',
  '## last_name', 'type: text', 'value: Mobley',
  '## phone', 'type: text', 'value: 7135550100',
  '## phone_country_code', 'type: text', 'value: United States (+1)',
  '## city', 'type: text', 'value: Houston, Texas, United States',
  '## sponsorship_needed', 'type: boolean', 'value: false',
  'learned: Will you now or in the future require sponsorship for employment visa status?',
  'aliases: Do you require visa sponsorship',
  '## work_authorization', 'type: boolean', 'value: true',
  'learned: Are you legally authorized to work in the United States?',
  '## years_leadership', 'type: text', 'value: 20',
  'learned: How many years of technology leadership experience do you have?',
  '## relocate', 'type: boolean', 'value: true',
  'learned: Are you unwilling to relocate?',
].join('\n');

/** @param {string} question @param {string} kind @param {boolean} required @param {string[]} [options] */
const f = (question, kind, required, options = []) => ({ question, kind, required, options });

/** resolveFieldAnswer cases: [name, field, useEmptyBank, accountEmail]. */
export const FIELDS = Object.freeze([
  ['first name', f('First name', 'text', true), false, 'owner@example.com'],
  ['first name star', f('First name*', 'text', true), false, 'owner@example.com'],
  ['last name', f('Last name', 'text', true), false, 'owner@example.com'],
  ['email select account', f('Email address', 'select', true, ['owner@example.com', 'other@example.com']), false, 'owner@example.com'],
  ['email text account', f('Email', 'text', true), false, 'owner@example.com'],
  ['email no account', f('Email address', 'text', true), false, null],
  ['email optional no account', f('Email address', 'text', false), false, null],
  ['mobile phone', f('Mobile phone number', 'text', true), false, null],
  ['phone number', f('Phone number', 'text', true), false, null],
  ['phone', f('Phone', 'text', false), false, null],
  ['phone country code ok', f('Phone country code', 'select', true, ['United States (+1)', 'Canada (+1)']), false, null],
  ['phone country code miss', f('Phone country code', 'select', true, ['United States +1']), false, null],
  ['location city', f('Location (city)', 'text', true), false, null],
  ['city', f('City', 'text', false), false, null],
  ['city empty bank', f('City', 'text', false), true, null],
  ['first name empty bank', f('First name', 'text', true), true, null],
  ['legal name (not a linkedin contact label)', f('Legal Name', 'text', true), false, null],
  ['postal code (not a linkedin contact label)', f('Postal Code', 'text', false), false, null],
  ['sponsorship radio', f('Will you now or in the future require sponsorship for employment visa status?', 'radio', true, ['Yes', 'No']), false, null],
  ['sponsorship alias', f('Do you require visa sponsorship', 'radio', true, ['Yes', 'No']), false, null],
  ['sponsorship alias optional', f('Do you require visa sponsorship', 'radio', false, ['Yes', 'No']), false, null],
  ['sponsorship near miss', f('Will you now, or in the future, require sponsorship for employment visa status?', 'radio', true, ['Yes', 'No']), false, null],
  ['sponsorship checkbox', f('Will you now or in the future require sponsorship for employment visa status?', 'checkbox', true), false, null],
  ['sponsorship text', f('Will you now or in the future require sponsorship for employment visa status?', 'text', true), false, null],
  ['work auth select', f('Are you legally authorized to work in the United States?', 'select', true, ['Yes', 'No']), false, null],
  ['work auth select miss', f('Are you legally authorized to work in the United States?', 'select', true, ['Yes, I am', 'No']), false, null],
  ['work auth select dup', f('Are you legally authorized to work in the United States?', 'select', true, ['Yes', 'yes.']), false, null],
  ['work auth no options', f('Are you legally authorized to work in the United States?', 'radio', true, []), false, null],
  ['years text', f('How many years of technology leadership experience do you have?', 'text', true), false, null],
  ['years textarea', f('How many years of technology leadership experience do you have?', 'textarea', true), false, null],
  ['years checkbox', f('How many years of technology leadership experience do you have?', 'checkbox', true), false, null],
  ['website optional', f('Website', 'text', false), false, null],
  ['website required', f('Website', 'text', true), false, null],
  ['salary', f('What are your salary expectations?', 'text', true), false, null],
  ['hourly', f('What is your desired hourly rate?', 'text', true), false, null],
  ['follow company', f('Follow Acme Corp to stay up to date with their page.', 'checkbox', false), false, null],
  ['file', f('Resume', 'file', true), false, null],
  ['weird kind', f('x', 'weird', true), false, null],
  ['empty question', f('', 'text', true), false, null],
  ['non-string options filtered', { question: 'Phone country code', kind: 'select', required: true, options: [1, 'United States (+1)', null] }, false, null],
  ['null field', null, false, null],
]);

/** normalizeName inputs. */
export const NAMES = Object.freeze(['  Review​   your Application. ', 'Next >', 'Next →', 'CONTINUE!!', 'Ｎext', null, 42, '']);

/**
 * Evaluate every case through one API object (the legacy module exports or the profile-driven ones).
 * JSON round trip so the comparison sees exactly what a JSON golden file can hold.
 * @param {{ normalizeName: Function, classifyAdvanceButton: Function, isSubmitMarked: Function, checkNotLastStep: Function, classifyStep: Function, verifyResumeCards: Function, resolveFieldAnswer: Function, contactLabels: Record<string, string> }} api
 * @param {(text: string) => any} parseAnswerBank
 */
export function computeGolden(api, parseAnswerBank) {
  const bank = parseAnswerBank(BANK_TEXT);
  const empty = parseAnswerBank('');
  const out = {
    normalizeName: NAMES.map((n) => api.normalizeName(n)),
    classifyAdvanceButton: Object.fromEntries(BUTTONS.map(([k, d]) => [k, api.classifyAdvanceButton(d)])),
    isSubmitMarked: Object.fromEntries(BUTTONS.map(([k, d]) => [k, api.isSubmitMarked(d)])),
    checkNotLastStep: Object.fromEntries(LAST_STEP.map(([k, i]) => [k, api.checkNotLastStep(i)])),
    classifyStep: Object.fromEntries(STEPS.map(([k, s]) => [k, api.classifyStep(s)])),
    verifyResumeCards: Object.fromEntries(CARDS.map(([k, [c, e]]) => [k, api.verifyResumeCards(c, e)])),
    resolveFieldAnswer: Object.fromEntries(FIELDS.map(([k, fld, useEmpty, email]) => [k, api.resolveFieldAnswer(fld, { bank: useEmpty ? empty : bank, accountEmail: email })])),
    contactLabels: { ...api.contactLabels },
  };
  return JSON.parse(JSON.stringify(out));
}
