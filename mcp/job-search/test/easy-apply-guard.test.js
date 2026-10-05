// @ts-check
/**
 * src/apply/easy-apply-guard.js (assisted LinkedIn Easy Apply, spec G1/G2/G3/G5/G11): the pure decision
 * tables the driver evaluates INSIDE the page (the same function source is injected into the single
 * Runtime.callFunctionOn that resolves, re-verifies, and clicks). Every adversarial label shape the spec
 * lists (G13) has a row here: hidden spans, aria-label vs text mismatch, data-* submit, empty name, and
 * "Submit application" disguised as Next via a data attribute.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName, ADVANCE_ALLOWED_NAMES, DENY_RE, classifyAdvanceButton, checkNotLastStep, classifyStep,
  verifyResumeCards, PAGE_GUARD_FUNCTIONS,
} from '../src/apply/easy-apply-guard.js';

/** @param {Partial<import('../src/apply/easy-apply-guard.js').ButtonDescriptor>} o */
function btn(o = {}) {
  return {
    tag: 'button', inDialog: true, disabled: false, ariaLabel: '', labelledByText: '', visibleText: 'Next',
    textContent: 'Next', title: '', value: '', dataAttrs: [], ...o,
  };
}

describe('normalizeName', () => {
  test('lowercases, collapses whitespace, strips zero-width characters and trailing punctuation', () => {
    assert.equal(normalizeName('  Review​   your Application. '), 'review your application');
    assert.equal(normalizeName('Next >'), 'next');
    assert.equal(normalizeName(null), '');
  });
});

describe('classifyAdvanceButton (G1)', () => {
  test('the allow set is exactly the four spec names', () => {
    assert.deepEqual([...ADVANCE_ALLOWED_NAMES].sort(), ['continue', 'next', 'review', 'review your application']);
  });

  const allowRows = [
    ['plain Next', btn()],
    ['plain Continue', btn({ visibleText: 'Continue', textContent: 'Continue' })],
    ['Review with aria-label Review your application', btn({ ariaLabel: 'Review your application', visibleText: 'Review', textContent: 'Review' })],
  ];
  for (const [name, d] of allowRows) {
    test(`allows: ${name}`, () => {
      const r = classifyAdvanceButton(d);
      assert.equal(r.ok, true, JSON.stringify(r));
    });
  }

  const refuseRows = [
    ['not a <button>', btn({ tag: 'a' }), 'not_button'],
    ['input type=submit', btn({ tag: 'input', value: 'Next' }), 'not_button'],
    ['outside the Easy Apply dialog', btn({ inDialog: false }), 'outside_dialog'],
    ['disabled', btn({ disabled: true }), 'disabled'],
    ['Submit application', btn({ visibleText: 'Submit application', textContent: 'Submit application' }), 'denied_term'],
    ['hidden span carrying Submit', btn({ visibleText: 'Next', textContent: 'Next Submit application' }), 'denied_term'],
    ['aria-label Submit, text Next', btn({ ariaLabel: 'Submit application', visibleText: 'Next', textContent: 'Next' }), 'denied_term'],
    ['aria-label Next, text Send', btn({ ariaLabel: 'Next', visibleText: 'Send', textContent: 'Send' }), 'denied_term'],
    ['Submit disguised as Next via data attribute value', btn({ dataAttrs: [['data-control-name', 'submit_unify']] }), 'denied_term'],
    ['Submit disguised as Next via data attribute name', btn({ dataAttrs: [['data-live-test-easy-apply-submit-button', '']] }), 'denied_term'],
    ['data attribute containing apply (literal G1 deny rule)', btn({ dataAttrs: [['data-easy-apply-next-button', '']] }), 'denied_term'],
    ['Done', btn({ visibleText: 'Done', textContent: 'Done' }), 'denied_term'],
    ['title attribute carrying Send', btn({ title: 'Send now' }), 'denied_term'],
    ['labelledby text carrying Submit', btn({ labelledByText: 'Submit' }), 'denied_term'],
    ['empty name', btn({ visibleText: '', textContent: '' }), 'unknown_button'],
    ['whitespace-only name', btn({ visibleText: ' ​ ', textContent: ' ​ ' }), 'unknown_button'],
    ['unknown name Dismiss', btn({ visibleText: 'Dismiss', textContent: 'Dismiss' }), 'unknown_button'],
    ['aria-label vs text mismatch (Next vs Finish)', btn({ ariaLabel: 'Next', visibleText: 'Finish', textContent: 'Finish' }), 'unknown_button'],
    ['aria-label Continue to next step (not an exact allowed name)', btn({ ariaLabel: 'Continue to next step', visibleText: 'Next', textContent: 'Next' }), 'unknown_button'],
    ['Next with extra words', btn({ visibleText: 'Next step', textContent: 'Next step' }), 'unknown_button'],
  ];
  for (const [name, d, reason] of refuseRows) {
    test(`refuses: ${name} -> ${reason}`, () => {
      const r = classifyAdvanceButton(/** @type {any} */ (d));
      assert.equal(r.ok, false);
      assert.equal(r.reason, reason);
    });
  }

  test('deny overrides allow: a data attribute deny hit beats an allowed name', () => {
    assert.match('data-x-send', DENY_RE);
    const r = classifyAdvanceButton(btn({ dataAttrs: [['data-x', 'send']] }));
    assert.equal(r.reason, 'denied_term');
  });

  test('a non-object descriptor is refused, never thrown', () => {
    assert.equal(classifyAdvanceButton(/** @type {any} */ (null)).ok, false);
  });
});

describe('checkNotLastStep (G2)', () => {
  test('Next with a single progress value under 100 is a positive not-last-step signal', () => {
    assert.deepEqual(checkNotLastStep({ buttonName: 'next', progressValues: [50], submitVisible: false }), { ok: true, reason: 'progress_below_100' });
  });
  test('Review is allowed because it leads to the distinct Review screen', () => {
    assert.equal(checkNotLastStep({ buttonName: 'review your application', progressValues: [], submitVisible: false }).ok, true);
  });
  const terminalRows = [
    ['no progress signal at all', { buttonName: 'next', progressValues: [], submitVisible: false }],
    ['progress at 100', { buttonName: 'continue', progressValues: [100], submitVisible: false }],
    ['two progress values that disagree', { buttonName: 'next', progressValues: [25, 75], submitVisible: false }],
    ['a NaN progress value', { buttonName: 'next', progressValues: [Number.NaN], submitVisible: false }],
    ['a Submit button visible in the dialog', { buttonName: 'next', progressValues: [50], submitVisible: true }],
    ['Review while a Submit button is visible', { buttonName: 'review', progressValues: [], submitVisible: true }],
    ['an unknown button name', { buttonName: 'finish', progressValues: [10], submitVisible: false }],
  ];
  for (const [name, input] of terminalRows) {
    test(`treated as terminal: ${name}`, () => {
      const r = checkNotLastStep(/** @type {any} */ (input));
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'uncertain_last_step');
    });
  }
});

describe('classifyStep (G3/G5/G11)', () => {
  /** @param {any} o */
  const step = (o) => ({ dialogPresent: true, headerTexts: [], buttonNames: ['next'], dialogText: '', pageText: '', url: 'https://www.linkedin.com/jobs/view/1/', ...o });
  test('form step', () => assert.equal(classifyStep(step({})).kind, 'form'));
  test('review: Review header plus a Submit button', () => {
    assert.equal(classifyStep(step({ headerTexts: ['Review your application'], buttonNames: ['submit application', 'back'] })).kind, 'review');
  });
  test('a Submit button without the header is submit_visible (no clicks either way)', () => {
    assert.equal(classifyStep(step({ buttonNames: ['submit application'] })).kind, 'submit_visible');
  });
  test('application sent confirmation wins over everything (G5)', () => {
    assert.equal(classifyStep(step({ dialogText: 'Your application was sent to Acme' })).kind, 'sent');
    assert.equal(classifyStep(step({ pageText: 'Application submitted' })).kind, 'sent');
  });
  test('challenge pages trip G11', () => {
    assert.equal(classifyStep(step({ url: 'https://www.linkedin.com/checkpoint/challenge/x' })).kind, 'challenge');
    assert.equal(classifyStep(step({ pageText: 'We have detected unusual activity from your account' })).kind, 'challenge');
    assert.equal(classifyStep(step({ pageText: 'Please complete this security verification (captcha)' })).kind, 'challenge');
    assert.equal(classifyStep(step({ url: 'https://www.linkedin.com/uas/login?session_redirect=x' })).kind, 'challenge');
    assert.equal(classifyStep(step({ pageText: 'HTTP 429 Too Many Requests' })).kind, 'challenge');
  });
  test('no dialog', () => assert.equal(classifyStep(step({ dialogPresent: false })).kind, 'no_dialog'));
  test('sent beats challenge beats review (precedence)', () => {
    const s = step({ dialogText: 'Application sent', url: 'https://www.linkedin.com/checkpoint/x', headerTexts: ['Review your application'], buttonNames: ['submit application'] });
    assert.equal(classifyStep(s).kind, 'sent');
  });
});

describe('verifyResumeCards (G7)', () => {
  test('exactly one selected card whose name matches is ok', () => {
    assert.deepEqual(verifyResumeCards([{ name: 'Damian Mobley - CTO.docx', selected: true }, { name: 'old.pdf', selected: false }], 'Damian Mobley - CTO.docx'), { ok: true, reason: null });
  });
  test('the uploaded card not selected', () => {
    assert.equal(verifyResumeCards([{ name: 'a.docx', selected: false }, { name: 'old.pdf', selected: true }], 'a.docx').reason, 'uploaded_not_selected');
  });
  test('two selected cards', () => {
    assert.equal(verifyResumeCards([{ name: 'a.docx', selected: true }, { name: 'old.pdf', selected: true }], 'a.docx').reason, 'multiple_selected');
  });
  test('no card at all', () => {
    assert.equal(verifyResumeCards([], 'a.docx').reason, 'uploaded_not_found');
  });
  test('name comparison is exact after whitespace normalization only (no fuzzy match)', () => {
    assert.equal(verifyResumeCards([{ name: 'a (1).docx', selected: true }], 'a.docx').reason, 'uploaded_not_found');
  });
});

describe('PAGE_GUARD_FUNCTIONS', () => {
  test('every injected guard function is self-contained (no import, no require, no module-scope reference)', () => {
    for (const fn of PAGE_GUARD_FUNCTIONS) {
      const src = fn.toString();
      assert.doesNotMatch(src, /\bimport\b|\brequire\(/, fn.name);
    }
    const names = PAGE_GUARD_FUNCTIONS.map((f) => f.name);
    for (const required of ['normalizeName', 'classifyAdvanceButton', 'checkNotLastStep', 'classifyStep']) {
      assert.ok(names.includes(required), required);
    }
  });
});
