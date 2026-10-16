// @ts-check
/**
 * Blocked-affiliate leak guard for dashboard output (plan 18.3, A6). The names in the blocklist (built-ins and
 * the gitignored blocked_affiliates file) must appear in no response. makeRedactor() (src/tools/targets.js)
 * replaces exact, case-insensitive occurrences; this guard adds a total second layer for the forms an exact
 * match misses: a URL slug ("zorbco-holdings"), percent-encoding ("Zorbco%20Holdings"), odd spacing or
 * punctuation ("Zorbco, Holdings"), full-width letters, zero-width characters.
 *
 *   text(s)  exact names are replaced with "[blocked]"; if the remainder, squashed to lowercase letters and
 *            digits, still contains a blocked name of 6 or more squashed characters, the WHOLE string is
 *            replaced with "[blocked]" (friction, never a silent pass).
 *   url(s)   the same test on the raw value and on its percent-decoded form; any hit withholds the whole URL.
 *
 * Entries under 6 squashed characters are matched exactly only (a short squashed needle would withhold
 * ordinary prose by accident). Pure, synchronous, no I/O.
 */
import { makeRedactor } from '../tools/targets.js';

export const WITHHELD = '[blocked]';
const MIN_SQUASHED = 6;

/** @param {unknown} s @returns {string} */
export function squash(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[­​-‏⁠﻿]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** @param {string} s @returns {string} */
function decodeLoose(s) {
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/**
 * @param {string[]} entries blocked names
 * @returns {{ text: (t: unknown) => string|null, url: (t: unknown) => string|null, hits: (t: unknown) => boolean }}
 */
export function makeLeakGuard(entries) {
  const redact = makeRedactor(entries);
  const needles = [...new Set(entries.map((e) => squash(e)).filter((e) => e.length >= MIN_SQUASHED))];
  /** @param {unknown} t */
  const hits = (t) => {
    const sq = squash(t);
    return sq.length >= MIN_SQUASHED && needles.some((n) => sq.includes(n));
  };
  return {
    hits,
    text(t) {
      if (t === null || t === undefined) return null;
      const r = redact(t) ?? '';
      return hits(r) || hits(decodeLoose(r)) ? WITHHELD : r;
    },
    url(t) {
      if (t === null || t === undefined) return null;
      const s = String(t);
      if (hits(s) || hits(decodeLoose(s))) return WITHHELD;
      return redact(s);
    },
  };
}
