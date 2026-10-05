// @ts-check
/**
 * Golden test for the assisted-apply refactor (spec v2 A14): the LinkedIn rules and guard decisions over
 * representative fixtures (test/fixtures/assisted-apply/linkedin-golden-cases.js) must equal the outputs
 * captured from the pre-refactor easy-apply modules (linkedin-golden.json). Two paths are checked:
 *   1. the legacy LinkedIn exports (src/apply/easy-apply-guard.js, src/apply/easy-apply-answers.js), which
 *      passed against the golden file before the refactor and must keep passing after it;
 *   2. the profile-driven assisted modules, with the LinkedIn profile's rules passed as data (the same
 *      JSON-serializable object the driver sends into the page function as req.rules).
 * A diff in either path is a LinkedIn behavior change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnswerBank } from '../src/apply/answers.js';
import * as legacyGuard from '../src/apply/easy-apply-guard.js';
import * as legacyAnswers from '../src/apply/easy-apply-answers.js';
import { computeGolden } from './fixtures/assisted-apply/linkedin-golden-cases.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'assisted-apply', 'linkedin-golden.json'), 'utf8'));

describe('LinkedIn golden: legacy easy-apply exports', () => {
  const got = computeGolden({ ...legacyGuard, resolveFieldAnswer: legacyAnswers.resolveFieldAnswer, contactLabels: legacyAnswers.CONTACT_LABELS }, parseAnswerBank);
  for (const section of Object.keys(GOLDEN)) {
    test(`${section} equals the pre-refactor capture`, () => {
      assert.deepEqual(got[section], GOLDEN[section]);
    });
  }
});

describe('LinkedIn golden: profile-driven assisted modules (rules as data)', async () => {
  const guard = await import('../src/apply/assisted/guard.js');
  const answers = await import('../src/apply/assisted/answers.js');
  const { LINKEDIN_PROFILE } = await import('../src/apply/assisted/profiles/linkedin.js');
  // The rules travel into the page through CDP as a JSON value; use the JSON round trip here too.
  const R = JSON.parse(JSON.stringify(LINKEDIN_PROFILE.rules));
  const got = computeGolden({
    normalizeName: guard.normalizeName,
    classifyAdvanceButton: (/** @type {any} */ d) => guard.classifyAdvanceButton(d, R),
    isSubmitMarked: (/** @type {any} */ d) => guard.isSubmitMarked(d, R),
    checkNotLastStep: guard.checkNotLastStep,
    classifyStep: (/** @type {any} */ s) => guard.classifyStep(s, R),
    verifyResumeCards: guard.verifyResumeCards,
    resolveFieldAnswer: (/** @type {any} */ f, /** @type {any} */ ctx) => answers.resolveFieldAnswer(f, { ...ctx, contactLabels: LINKEDIN_PROFILE.contactLabels }),
    contactLabels: LINKEDIN_PROFILE.contactLabels,
  }, parseAnswerBank);
  for (const section of Object.keys(GOLDEN)) {
    test(`${section} equals the pre-refactor capture`, () => {
      assert.deepEqual(got[section], GOLDEN[section]);
    });
  }
  test('the LinkedIn rules survive a JSON round trip unchanged (they are plain data)', () => {
    assert.deepEqual(R, LINKEDIN_PROFILE.rules);
  });
});
