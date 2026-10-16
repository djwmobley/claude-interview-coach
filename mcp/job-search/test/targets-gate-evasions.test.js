// @ts-check
/**
 * Gate evasions the PR5 reviewer found (PR5b fix 2), written as classes with near-miss negatives:
 *   F7 URL     a domain split by spaces around a dot token ("acme . com")
 *   F5 quote   any Pi/Pf quote, and any Ps/Pe bracket that is not a plain ASCII bracket (CJK corner brackets)
 *   F9 problem "not about X but about Y" (the same preposition on both sides of "but")
 * Pure: no database, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/targets/draft-gates.js';
import { goldenInput, GOLDEN_FIELDS } from './helpers/targets-pr5.js';

const U = (/** @type {number} */ cp) => String.fromCodePoint(cp);
/** @param {ReturnType<typeof runGates>} r @param {string} gate */
const gateOf = (r, gate) => /** @type {any} */ (r.results.find((x) => x.gate === gate));

/** The bridge field and its sentence replaced together, so only the gate under test changes. */
function bridge(/** @type {string} */ text) {
  return goldenInput({ bridge: text }, (s) => { s[1].text = text; return s; });
}

describe('F7 url: a domain split around a dot token', () => {
  for (const t of ['See acme . com for details.', 'See acme .com for details.', 'See acme . com for details.', 'See acme   .   io today.', 'See acme . co . uk today.', `See acme ${U(0x3002)} com today.`]) {
    test(`fails: ${JSON.stringify(t)}`, () => {
      const r = runGates(bridge(`I have run product and engineering teams through two ownership changes. ${t}`));
      assert.equal(gateOf(r, 'urls').ok, false);
      assert.equal(gateOf(r, 'urls').code, 'url');
    });
  }
  for (const t of ['The deal closed at the end. Com units followed.', 'It was the end. Com is next.', 'Revenue grew 12 percent. Acme Robotics shipped more.', 'We shipped v2.1 last week.', 'Wait... then it worked.', 'Teams grew, and so did the plan. Co owners agreed.']) {
    test(`near-miss passes: ${JSON.stringify(t)}`, () => {
      const r = runGates(bridge(`I have run product and engineering teams through two ownership changes. ${t}`));
      assert.equal(gateOf(r, 'urls').ok, true, t);
    });
  }
});

describe('F5 quote: paired quote characters of any script', () => {
  const pairs = {
    cornerBrackets: [0x300c, 0x300d], whiteCorner: [0x300e, 0x300f], angleCjk: [0x3008, 0x3009], doubleAngleCjk: [0x300a, 0x300b],
    lenticular: [0x3010, 0x3011], tortoise: [0x3014, 0x3015], halfwidthCorner: [0xff62, 0xff63], singleAngle: [0x2039, 0x203a],
    guillemet: [0xab, 0xbb], curlyDouble: [0x201c, 0x201d], curlySingle: [0x2018, 0x2019], lowNine: [0x201e, 0x201c], ornamentalAngle: [0x276e, 0x276f],
    mathAngle: [0x27e8, 0x27e9], flattenedParen: [0x27ee, 0x27ef], ornateParen: [0xfd3e, 0xfd3f],
  };
  for (const [name, [open, close]] of Object.entries(pairs)) {
    test(`fails: ${name}`, () => {
      const r = runGates(bridge(`I have run teams through two ownership changes, a ${U(open)}steady${U(close)} path.`));
      assert.equal(gateOf(r, 'quotes').ok, false);
      assert.equal(gateOf(r, 'quotes').code, 'quote');
    });
  }
  test('every Pi and Pf character in the BMP fails as a lone mark, except the apostrophe forms used inside a word', () => {
    for (let cp = 0x20; cp <= 0xffff; cp++) {
      const c = U(cp);
      if (!/[\p{Pi}\p{Pf}]/u.test(c)) continue;
      const r = runGates(bridge(`I have run teams through two ownership changes, a ${c}steady${c} path.`));
      assert.equal(gateOf(r, 'quotes').ok, false, `U+${cp.toString(16)}`);
    }
  });
  test('near-miss passes: plain parentheses, brackets, braces, an inner-word apostrophe, a possessive', () => {
    for (const t of ['I led a steady (and slow) path.', 'I led a steady [and slow] path.', 'I led the firm’s platform consolidation.', "I led the firm's platform consolidation.", 'We shipped it in 2026 (twice).']) {
      const r = runGates(bridge(`I have run product teams through two ownership changes. ${t}`));
      assert.equal(gateOf(r, 'quotes').ok, true, t);
    }
  });
});

describe('F9 problem comparison: "not about X but about Y"', () => {
  for (const t of [
    'The work is not about tools but about people at Acme Robotics.',
    'It is not about the tools, but about the people.',
    'This was not just about cost but about trust.',
    'It was not for headcount but for speed at Acme Robotics.',
    'Not about speed but about care.',
    'The change is not on tools but on people.',
  ]) {
    test(`fails: ${JSON.stringify(t)}`, () => {
      assert.equal(gateOf(runGates(bridge(t)), 'problem_comparison').ok, false, t);
    });
  }
  for (const t of [
    'I care about tools and about people at Acme Robotics.',
    'The work is about people, but tools matter too.',
    'It is not only about tools but also about people.',
    'We did not hire for speed. Later, we thought about care.',
    'I would not do that but for the board.',
    'Tools help and people matter at Acme Robotics.',
  ]) {
    test(`near-miss passes: ${JSON.stringify(t)}`, () => {
      assert.equal(gateOf(runGates(bridge(t)), 'problem_comparison').ok, true, t);
    });
  }
  test('the pattern lives in the shared config so render_doc gets it too', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'style-checks.json'), 'utf8'));
    assert.ok(cfg.problemComparisonPatterns.some((/** @type {string} */ p) => /\\1/.test(p) && /about/.test(p)));
    assert.ok(new RegExp(cfg.problemComparisonPatterns.find((/** @type {string} */ p) => /\\1/.test(p)), 'i').test('this is not about cost but about trust'));
  });
});

void GOLDEN_FIELDS;
