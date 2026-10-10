// @ts-check
/**
 * src/core/title-gate.js: the deterministic Director-level / non-technology title gate. Pure, no DB.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTitle, EXEC_TOKENS, NONTECH_TOKENS, TECH_TOKENS } from '../src/core/title-gate.js';

/** @type {Array<[string, 'pass'|'drop', string|null]>} */
const CASES = [
  ['Director of IT', 'drop', 'director_level'],
  ['Associate Director, Data', 'drop', 'director_level'],
  ['Dir, Engineering', 'drop', 'director_level'],
  ['Director, Office of the CIO', 'drop', 'director_level'],
  ['Director of IT, Reports to CTO', 'drop', 'director_level'],
  ['Senior Director, Technology', 'pass', null],
  ['Sr. Dir. of Data', 'pass', null],
  ['VP / Director of IT', 'pass', null],
  ['Managing Director, Technology', 'pass', null],
  ['Non-Executive Director', 'drop', 'director_level'],
  ['AVP, Data Engineering', 'drop', 'director_level'],
  ['Assistant Vice President, Technology', 'drop', 'director_level'],
  ['S.V.P., Sales', 'drop', 'non_tech_function'],
  ['Chief Financial Officer', 'drop', 'non_tech_function'],
  ['VP, Finance Transformation', 'drop', 'non_tech_function'],
  ['SVP Product Marketing', 'drop', 'non_tech_function'],
  ['Chief Marketing & Digital Officer', 'pass', null],
  ['VP Finance Systems', 'pass', null],
  ['Chief Clinical Informatics Officer', 'pass', null],
  ['Chief Marketing Technologist', 'pass', null],
  ['Chief Medical Officer, Retail Clinic', 'drop', 'non_tech_function'],
  // HEAD strip leaves "to the president" (an exec token), so no level drop; triage decides.
  ['Executive Assistant to the President', 'pass', null],
  ['Chief Technology Officer', 'pass', null],
  ['Chief Operating Officer', 'pass', null],
  ['Head of Technology', 'pass', null],
  ['VP E-Commerce', 'pass', null],
];

describe('title-gate: required cases', () => {
  for (const [title, verdict, reason] of CASES) {
    test(`${title} -> ${verdict}${reason ? ` ${reason}` : ''}`, () => {
      const r = classifyTitle(title);
      assert.equal(r.verdict, verdict);
      assert.equal(r.reason, reason);
      assert.equal(typeof r.rule, 'string');
      assert.ok(r.rule.length > 0);
    });
  }
});

describe('title-gate: normalization and matching', () => {
  test('dotted initials collapse: v.p., s.v.p., sr., dir.', () => {
    assert.equal(classifyTitle('V.P. of Engineering').verdict, 'pass');
    assert.equal(classifyTitle('Sr. Director, Cloud').verdict, 'pass');
    assert.equal(classifyTitle('Dir. of Cloud').reason, 'director_level');
  });

  test('matching is whole-word: "directory" is not director, "pit" is not it', () => {
    assert.equal(classifyTitle('Directory Services Lead').verdict, 'pass');
    assert.equal(classifyTitle('Sales Pit Boss').reason, 'non_tech_function');
  });

  test('HEAD is cut at " - ", "|", "(" and reports-to', () => {
    assert.equal(classifyTitle('Director of IT - Reports to the CTO').reason, 'director_level');
    assert.equal(classifyTitle('Director of IT | CTO staff').reason, 'director_level');
    assert.equal(classifyTitle('Director of IT (CIO org)').reason, 'director_level');
    assert.equal(classifyTitle('Director of IT reporting to the CTO').reason, 'director_level');
    assert.equal(classifyTitle('Director of IT \u2013 CTO org').reason, 'director_level');
    assert.equal(classifyTitle('Director of IT \u2014 CTO org').reason, 'director_level');
  });

  test('an exec token only after the HEAD cut does not rescue a Director', () => {
    assert.equal(classifyTitle('Director, Platform (VP track)').reason, 'director_level');
  });

  test('board and AVP phrasing drops even with an exec token elsewhere in HEAD', () => {
    assert.equal(classifyTitle('Associate Vice President of Technology').reason, 'director_level');
    assert.equal(classifyTitle('Board Member, Technology Committee').reason, 'director_level');
  });

  test('stem technolog* matches technologist and technologies', () => {
    assert.equal(classifyTitle('VP Marketing Technologies').verdict, 'pass');
  });

  test('neutralized phrases do not count as TECH but their NONTECH word still counts', () => {
    assert.equal(classifyTitle('VP Sales Engineering').reason, 'non_tech_function');
    assert.equal(classifyTitle('VP HR Transformation').reason, 'non_tech_function');
    assert.equal(classifyTitle('VP Product Supply').verdict, 'pass'); // no NONTECH token at all
  });

  test('known accepted gap: one TECH token cancels NONTECH', () => {
    assert.equal(classifyTitle('Head of Sales, Payments Platform').verdict, 'pass');
  });

  test('total: blank, null and odd input never throw and pass', () => {
    for (const t of ['', '   ', null, undefined, '---', '()']) {
      const r = classifyTitle(/** @type {any} */ (t));
      assert.equal(r.verdict, 'pass');
    }
  });

  test('exported lists are frozen', () => {
    for (const l of [EXEC_TOKENS, NONTECH_TOKENS, TECH_TOKENS]) assert.ok(Object.isFrozen(l));
  });
});
