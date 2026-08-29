// @ts-check
/**
 * prescoreParts() (src/core/prescore.js): named, additive breakdown backing the GET /api/listings/:id
 * prescore_breakdown response. Pure, no I/O.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prescore, prescoreParts } from '../src/core/prescore.js';
import { weightedPrescore, getDefaultNoiseRules } from '../src/core/noise.js';

const PROFILE = { keywords: ['cto'], phrases: [], exclude_terms: ['recruiter'], locations: ['Houston, TX'], remote: 'any' };

describe('prescoreParts(): structural invariant', () => {
  test('the parts sum, clamped and rounded, always equals prescore() for the same inputs', () => {
    const cases = [
      { title: 'CTO', location: 'Houston, TX', salary_max: 260000, description: '' },
      { title: 'Junior CTO Coordinator', location: 'Remote', remote_mode: 'remote', description: '' },
      { title: 'VP Engineering', location: 'Unknown', location_norm: 'absent', description: 'recruiter recruiter recruiter' },
      { title: 'Director of Sales', location: 'Paris, France', location_norm: 'country-fr', salary_max: 90000, description: '' },
    ];
    for (const rec of cases) {
      const { sum, raw } = prescoreParts(rec, PROFILE);
      const expectedRaw = Math.max(0, Math.min(100, Math.round(sum)));
      assert.equal(raw, expectedRaw, JSON.stringify(rec));
      assert.equal(prescore(rec, PROFILE), raw, JSON.stringify(rec));
    }
  });

  test('parts add up to sum exactly (no hidden term)', () => {
    const rec = { title: 'Chief Technology Officer', location: 'Houston, TX', salary_max: 300000, description: 'cto leadership' };
    const { parts, sum } = prescoreParts(rec, PROFILE);
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    assert.equal(total, sum);
  });
});

describe('prescoreParts(): noise multiplier is applied later by weightedPrescore, never as a part', () => {
  test('weightedPrescore(raw, noiseClass) matches the stored formula (round(raw * multiplier), clamped)', () => {
    const rec = { title: 'CTO', location: 'Houston, TX', salary_max: 260000, description: '' };
    const { raw } = prescoreParts(rec, PROFILE);
    const rules = getDefaultNoiseRules();
    for (const noiseClass of Object.keys(rules.multipliers)) {
      const expected = Math.max(0, Math.min(100, Math.round(raw * rules.multipliers[noiseClass])));
      assert.equal(weightedPrescore(raw, noiseClass), expected, `noiseClass=${noiseClass}`);
    }
  });

  test('prescoreParts()\'s own "parts" object has no noise-multiplier key', () => {
    const { parts } = prescoreParts({ title: 'CTO' }, PROFILE);
    assert.equal('multiplier' in parts, false);
    assert.equal('noise' in parts, false);
  });
});

describe('prescoreParts(): exclusions can drive the sum negative and the raw floor applies', () => {
  test('a title with no seniority/keyword credit and a title exclusion hit produces a negative sum, floored to 0', () => {
    // No seniority match, no profile keyword hit, no salary/location credit -- the exclusion hit
    // (-30) is the only nonzero contributor, so sum is deterministically negative.
    const rec = { title: 'Recruiter opportunity', location: 'Unknown', description: '' };
    const { parts, sum, raw } = prescoreParts(rec, PROFILE);
    assert.equal(parts.seniority, 0);
    assert.equal(parts.titleKeywords, 0);
    assert.ok(parts.exclusions < 0, 'title exclusion hit is negative');
    assert.equal(sum, parts.exclusions, 'exclusions is the only nonzero part in this case');
    assert.ok(sum < 0, 'sanity: the pre-clamp sum is actually negative for this test to mean anything');
    assert.equal(raw, 0, 'raw floors at 0 when the pre-clamp sum is negative');
  });
});

describe('prescoreParts(): JUNIOR-title penalty is its own explicit, named part', () => {
  test('a junior-matching title carries a non-zero junior part and no seniority credit from that match', () => {
    const rec = { title: 'Junior Coordinator', location: 'Unknown', description: '' };
    const { parts } = prescoreParts(rec, {});
    assert.equal(parts.junior, -25);
  });

  test('a senior title never triggers the junior penalty', () => {
    const rec = { title: 'Chief Technology Officer', location: 'Unknown', description: '' };
    const { parts } = prescoreParts(rec, {});
    assert.equal(parts.junior, 0);
    assert.equal(parts.seniority, 30);
  });
});
