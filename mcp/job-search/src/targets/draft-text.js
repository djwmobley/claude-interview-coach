// @ts-check
/**
 * Text helpers shared by the draft gates, the prompt builders and the facts loader (plan 19.5). Pure.
 *
 * foldText   NFKC, invisible characters stripped, lowercase, look-alike letters (Cyrillic, Greek, full-width
 *            forms) folded to Latin, whitespace collapsed. This is the normal form every lexical gate reads.
 * squash     foldText reduced to letters and digits only (spaces and punctuation gone), plus squashLeet, which
 *            also folds digit and symbol look-alikes (0 to o, 1 to i, 3 to e, 4 to a, 5 to s, 7 to t).
 * tokens     foldText split on whitespace, hyphens and slashes into word tokens that hold a letter or digit.
 */
import { stripZeroWidth } from '../core/normalize.js';

/** Look-alike letters that survive NFKC, mapped to the Latin letter they imitate (applied after lowercase). */
const CONFUSABLES = Object.freeze(/** @type {Record<string, string>} */ ({
  // Cyrillic
  '\u{430}': 'a', '\u{432}': 'b', '\u{441}': 'c', '\u{435}': 'e', '\u{4bb}': 'h', '\u{43d}': 'h', '\u{456}': 'i', '\u{458}': 'j',
  '\u{43a}': 'k', '\u{4cf}': 'l', '\u{43c}': 'm', '\u{43e}': 'o', '\u{440}': 'p', '\u{455}': 's', '\u{442}': 't', '\u{443}': 'y',
  '\u{445}': 'x', '\u{501}': 'd', '\u{51b}': 'q', '\u{51d}': 'w', '\u{491}': 'r', '\u{433}': 'r', '\u{438}': 'u',
  // Greek
  '\u{3b1}': 'a', '\u{3b2}': 'b', '\u{3b5}': 'e', '\u{3b9}': 'i', '\u{3ba}': 'k', '\u{3bd}': 'v', '\u{3bf}': 'o', '\u{3c1}': 'p',
  '\u{3c4}': 't', '\u{3c5}': 'u', '\u{3c7}': 'x', '\u{3b7}': 'n', '\u{3c9}': 'w', '\u{3b3}': 'y',
  // Latin extras
  '\u{131}': 'i', '\u{142}': 'l', '\u{f8}': 'o', '\u{111}': 'd', '\u{df}': 's', '\u{153}': 'o', '\u{e6}': 'a',
}));

const LEET = Object.freeze(/** @type {Record<string, string>} */ ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' }));

/** Sentence punctuation look-alikes that NFKC leaves alone. */
const DOT_LIKE = /[\u{3002}\u{ff61}\u{2024}\u{2027}\u{fe52}\u{2e2e}\u{701}\u{702}]/gu;

/**
 * @param {unknown} s
 * @returns {string}
 */
export function foldText(s) {
  let t = String(s ?? '').normalize('NFKC');
  t = stripZeroWidth(t).replace(DOT_LIKE, '.');
  t = t.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of t) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/[\u{2018}\u{2019}\u{2bc}\u{2032}]/gu, "'").replace(/\s+/g, ' ').trim();
}

/** @param {unknown} s @returns {string} */
export function squash(s) {
  return foldText(s).replace(/[^a-z0-9]/g, '');
}

/** @param {unknown} s @returns {string} */
export function squashLeet(s) {
  let out = '';
  for (const ch of foldText(s)) out += LEET[ch] ?? ch;
  return out.replace(/[^a-z]/g, '');
}

/**
 * Word tokens, lowercase, split on whitespace, hyphens, slashes and other punctuation. An apostrophe inside a
 * word stays (the token "firm's" is kept whole).
 * @param {unknown} s
 * @returns {string[]}
 */
export function tokens(s) {
  return foldText(s)
    .replace(/[\\/\u{2010}-\u{2015}\u{2212}-]+/gu, ' ')
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/**
 * The text as a space-padded token string so a phrase can be found with includes() and never as a substring of
 * a longer word. No regular expression is built from the phrase.
 * @param {unknown} s
 * @returns {string}
 */
export function padded(s) {
  return ` ${tokens(s).join(' ')} `;
}

/**
 * @param {unknown} haystack
 * @param {string} phrase a phrase in plain words
 * @returns {boolean}
 */
export function hasPhrase(haystack, phrase) {
  const p = tokens(phrase).join(' ');
  return p !== '' && padded(haystack).includes(` ${p} `);
}

/** @param {unknown} s @returns {string[]} the numbers written with digits, commas removed, trailing zeros kept */
export function numbersOf(s) {
  const out = [];
  for (const m of foldText(s).matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.push(m[0].replace(/,/g, '').replace(/\.$/, ''));
  return out;
}

/**
 * Split into sentences at . ! ? followed by whitespace. Deterministic and used for both sides of the citation
 * coverage check.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return String(text).trim().split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x !== '');
}

/** @param {unknown} s @returns {string} whitespace collapsed (no case or Unicode folding) */
export function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
