// @ts-check
/**
 * src/core/auto-apply-select.js routing of LinkedIn Easy Apply candidates to the assisted path (spec B4):
 * a LinkedIn easy-apply-only listing classifies as 'easy_apply_assisted' (never as normal 'eligible', never
 * consuming the normal daily cap); a non-LinkedIn easy-apply-only listing stays 'easy_apply_only'; hourly
 * pay still excludes; selectCandidates returns the assisted rows separately, deduplicated, in order.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidate, selectCandidates, CLOSED_REASONS, GATES } from '../src/core/auto-apply-select.js';

const CTX = { fitFloor: 70, floors: { texas_or_remote: 225000, relocation: 275000 }, atsAllow: ['greenhouse'] };
/** @param {any} o */
const row = (o = {}) => ({
  listingId: 1, fitScore: 80, fitActor: 'auto', duplicateOf: null, locationNorm: 'houston-tx', remoteMode: 'onsite', salaryMax: 300000,
  hasActiveApplication: false, description: 'A fine role.', applyUrl: null, applyAts: null, applyConfidence: null, applyEasyOnly: true,
  source: 'linkedin', sourceUrl: 'https://www.linkedin.com/jobs/view/1/', ...o,
});

describe('assisted Easy Apply routing', () => {
  test('LinkedIn easy-apply-only -> easy_apply_assisted; other sources stay easy_apply_only', () => {
    assert.ok(CLOSED_REASONS.includes('easy_apply_assisted'));
    assert.equal(classifyCandidate(row(), CTX), 'easy_apply_assisted');
    assert.equal(classifyCandidate(row({ source: 'indeed' }), CTX), 'easy_apply_only');
    assert.equal(classifyCandidate(row({ source: undefined }), CTX), 'easy_apply_only');
  });
  test('earlier gates still win and hourly pay still excludes an assisted candidate', () => {
    assert.equal(classifyCandidate(row({ fitScore: 10 }), CTX), 'below_fit');
    assert.equal(classifyCandidate(row({ salaryPeriod: 'hour' }), CTX), 'hourly_pay');
  });
  test('the assisted reason sits in the easy_apply_only funnel gate', () => {
    assert.ok(GATES.find((g) => g.name === 'easy_apply_only')?.reasons.includes('easy_apply_assisted'));
  });
  test('selectCandidates returns assisted rows separately, deduped by source URL, never in eligible or the normal cap', async () => {
    const rows = [
      row({ listingId: 1 }),
      row({ listingId: 2, sourceUrl: 'https://www.linkedin.com/jobs/view/1/' }),
      row({ listingId: 3, sourceUrl: 'https://www.linkedin.com/jobs/view/3/' }),
      row({ listingId: 4, applyEasyOnly: false, applyUrl: 'https://boards.greenhouse.io/a/jobs/1', applyAts: 'greenhouse', applyConfidence: 'exact', source: 'greenhouse' }),
    ];
    const sel = await selectCandidates(/** @type {any} */ ({}), {
      ...CTX, dailyCap: 1, now: new Date('2026-10-05T12:00:00Z'), timezone: 'America/Chicago',
      fetchCandidateRows: async () => rows, countAutoApprovedToday: async () => 0,
      classifyCandidateWithExclusions: async (_c, r, ctx) => classifyCandidate(r, ctx), exclusionConfig: /** @type {any} */ ({}),
    });
    assert.deepEqual(sel.eligible.map((r) => r.listingId), [4]);
    assert.deepEqual(sel.easyApplyEligible.map((r) => r.listingId), [1, 3]);
    assert.equal(sel.results.find((r) => r.listingId === 2)?.reason, 'duplicate_of');
    assert.equal(sel.capRemaining, 0);
  });
});
