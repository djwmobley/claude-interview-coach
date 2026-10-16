// @ts-check
/**
 * The blocked-affiliate leak guard (PR4, plan 18.3, A6): exact redaction plus a squashed second pass that
 * catches the shapes an exact match misses (URL slugs, percent-encoding, odd spacing, full-width letters,
 * zero-width characters). Pure unit tests, no database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeLeakGuard, squash, WITHHELD } from '../src/targets/leak-guard.js';

const ENTRIES = ['Immunotec', 'Advisicon', 'Zorbco Holdings'];

describe('makeLeakGuard', () => {
  const g = makeLeakGuard(ENTRIES);

  test('exact names are replaced in place; surrounding text is kept', () => {
    assert.equal(g.text('Sold to Zorbco Holdings LLC in 2026'), 'Sold to [blocked] LLC in 2026');
    assert.equal(g.text('IMMUNOTEC and advisicon'), '[blocked] and [blocked]');
  });

  test('forms an exact match misses are withheld whole: slug, encoding, spacing, punctuation, full-width, zero-width', () => {
    for (const leaky of [
      'zorbco-holdings-acquires-acme', 'Zorbco%20Holdings', 'Zorbco+Holdings', 'ZORBCO_HOLDINGS', 'Zorbco,  Holdings',
      'Z​orbco Holdings', 'Ｚｏｒｂｃｏ Holdings', 'Zor­bco Holdings', 'Imm-unotec',
    ]) {
      assert.equal(g.text(leaky), WITHHELD, leaky);
    }
  });

  test('urls: the raw value and the percent-decoded value are both checked', () => {
    assert.equal(g.url('https://news.example/2026/zorbco-holdings-deal'), WITHHELD);
    assert.equal(g.url(`https://news.example/${encodeURIComponent('Zorbco Holdings')}`), WITHHELD);
    assert.equal(g.url('https://news.example/a?q=Zorbco+Holdings'), WITHHELD);
    assert.equal(g.url('https://www.sec.gov/Archives/edgar/data/1/000000000026000001/x-index.htm'), 'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/x-index.htm');
    assert.equal(g.url('https://x.example/%E0%A4%A'), 'https://x.example/%E0%A4%A', 'a malformed escape does not throw');
  });

  test('ordinary text passes unchanged; short entries match exactly only, never squashed', () => {
    assert.equal(g.text('A normal sentence about a Chief Technology Officer.'), 'A normal sentence about a Chief Technology Officer.');
    const short = makeLeakGuard(['Abc']);
    assert.equal(short.text('a-b-c and ABC'), 'a-b-c and [blocked]', 'a 3-character entry is matched exactly only; the squashed pass would withhold ordinary prose');
  });

  test('null and undefined stay null; non-strings are stringified', () => {
    assert.equal(g.text(null), null);
    assert.equal(g.url(undefined), null);
    assert.equal(g.text(12345), '12345');
  });

  test('an empty blocklist withholds nothing', () => {
    const none = makeLeakGuard([]);
    assert.equal(none.text('Zorbco Holdings'), 'Zorbco Holdings');
    assert.equal(none.hits('anything'), false);
  });

  test('squash is stable', () => {
    assert.equal(squash(' Zorbco, Holdings! '), 'zorbcoholdings');
    assert.equal(squash(null), '');
  });
});
