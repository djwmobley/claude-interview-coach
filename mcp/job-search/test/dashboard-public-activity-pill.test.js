// @ts-check
/**
 * components/activity-pill.js: `pillText()` is the pure, DOM-free half of this component (this codebase
 * has no jsdom -- see test/dashboard-public-linksafety.test.js's note on hApplicationScreenshot for the
 * house convention: the `h()`-calling render function itself is exercised through the running app, not a
 * unit test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pillText } from '../src/dashboard/public/components/activity-pill.js';

describe('pillText(): idle', () => {
  test('null activity -> Idle, not running', () => {
    assert.deepEqual(pillText(null), { text: 'Idle', running: false });
  });

  test('undefined activity -> Idle, not running', () => {
    assert.deepEqual(pillText(undefined), { text: 'Idle', running: false });
  });

  test('activity with a null operator -> Idle, not running', () => {
    assert.deepEqual(pillText({ operator: null, operator_extra: 0 }), { text: 'Idle', running: false });
  });
});

describe('pillText(): single operator action', () => {
  test('a single running operator shows its label with no "+N" suffix', () => {
    const activity = { operator: { label: 'Drafting resume for #7064' }, operator_extra: 0 };
    assert.deepEqual(pillText(activity), { text: 'Drafting resume for #7064', running: true });
  });
});

describe('pillText(): operator_extra > 0 appends "+N"', () => {
  test('operator_extra of 1 appends " +1"', () => {
    const activity = { operator: { label: 'Reviewing #7064' }, operator_extra: 1 };
    assert.deepEqual(pillText(activity), { text: 'Reviewing #7064 +1', running: true });
  });

  test('operator_extra of 3 appends " +3"', () => {
    const activity = { operator: { label: 'Scanning (manual)' }, operator_extra: 3 };
    assert.deepEqual(pillText(activity), { text: 'Scanning (manual) +3', running: true });
  });
});
