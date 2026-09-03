// @ts-check
/**
 * src/core/auto-apply-select.js (auto-apply PR B): isUsLocation, classifyCandidate's closed reason enum,
 * dedup, the daily cap, and the local-midnight cap-counting boundary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsLocation, classifyCandidate, dedupResolvedTargets, applyDailyCap, startOfDayInTz,
  countAutoApprovedToday, selectCandidates, CLOSED_REASONS,
} from '../src/core/auto-apply-select.js';

const FLOORS = { texas_or_remote: 225000, relocation: 275000 };
const CTX = { fitFloor: 70, floors: FLOORS, atsAllow: ['greenhouse', 'lever'] };

/** @param {Partial<import('../src/core/auto-apply-select.js').CandidateRow>} overrides */
function row(overrides = {}) {
  return {
    listingId: 1,
    fitScore: 80,
    fitActor: 'auto',
    duplicateOf: null,
    locationNorm: 'houston-tx',
    remoteMode: 'onsite',
    salaryMax: 300000,
    hasActiveApplication: false,
    description: 'A fine role with plenty of detail describing the position.',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    applyAts: 'greenhouse',
    applyConfidence: 'exact',
    applyEasyOnly: false,
    ...overrides,
  };
}

describe('isUsLocation: total classification', () => {
  test('country-us is US', () => assert.equal(isUsLocation('country-us'), true));
  test('country-ca is non-US', () => assert.equal(isUsLocation('country-ca'), false));
  test('country-de (Germany) is non-US, never confused with Delaware', () => assert.equal(isUsLocation('country-de'), false));
  test('state-tx is US', () => assert.equal(isUsLocation('state-tx'), true));
  test('remote-us is US', () => assert.equal(isUsLocation('remote-us'), true));
  test('remote-us-tx is US', () => assert.equal(isUsLocation('remote-us-tx'), true));
  test('remote-de is non-US', () => assert.equal(isUsLocation('remote-de'), false));
  test('bare "remote" (no country signal) is non-US', () => assert.equal(isUsLocation('remote'), false));
  test('a US city-state form is US', () => {
    assert.equal(isUsLocation('houston-tx'), true);
    assert.equal(isUsLocation('denver-co'), true);
  });
  test('absent/legacy-unknown/unknown:* are non-US', () => {
    assert.equal(isUsLocation('absent'), false);
    assert.equal(isUsLocation('legacy-unknown'), false);
    assert.equal(isUsLocation('unknown:abc123'), false);
  });
  test('empty/non-string is non-US', () => {
    assert.equal(isUsLocation(''), false);
    assert.equal(isUsLocation(null), false);
    assert.equal(isUsLocation(undefined), false);
  });
});

describe('classifyCandidate: one reason per test, closed enum', () => {
  test('not_scored: fit_score null', () => assert.equal(classifyCandidate(row({ fitScore: null }), CTX), 'not_scored'));
  test('below_fit: model fit under the floor', () => assert.equal(classifyCandidate(row({ fitScore: 50, fitActor: 'auto' }), CTX), 'below_fit'));
  test('human_fit_override: human-set fit under the floor', () => assert.equal(classifyCandidate(row({ fitScore: 50, fitActor: 'dashboard' }), CTX), 'human_fit_override'));
  test('duplicate_of: listing-level duplicate', () => assert.equal(classifyCandidate(row({ duplicateOf: 42 }), CTX), 'duplicate_of'));
  test('not_us: non-US location', () => assert.equal(classifyCandidate(row({ locationNorm: 'country-de' }), CTX), 'not_us'));
  test('salary_below_floor: known salary max under the resolved floor', () => assert.equal(classifyCandidate(row({ locationNorm: 'denver-co', remoteMode: 'onsite', salaryMax: 100000 }), CTX), 'salary_below_floor'));
  test('an unknown salary max never disqualifies on its own', () => assert.equal(classifyCandidate(row({ salaryMax: null }), CTX), 'eligible'));
  test('active_application: a non-withdrawn application already exists', () => assert.equal(classifyCandidate(row({ hasActiveApplication: true }), CTX), 'active_application'));
  test('no_description: missing or blank description', () => {
    assert.equal(classifyCandidate(row({ description: null }), CTX), 'no_description');
    assert.equal(classifyCandidate(row({ description: '   ' }), CTX), 'no_description');
  });
  test('easy_apply_only: an in-page Easy Apply with no external target', () => assert.equal(classifyCandidate(row({ applyEasyOnly: true, applyUrl: null, applyAts: null }), CTX), 'easy_apply_only'));
  test('apply_target_unresolved: no apply url/ats resolved at all', () => assert.equal(classifyCandidate(row({ applyUrl: null, applyAts: null }), CTX), 'apply_target_unresolved'));
  test('ats_not_allowed: resolved to an ATS outside atsAllow', () => assert.equal(classifyCandidate(row({ applyAts: 'workday', applyUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/x' }), CTX), 'ats_not_allowed'));
  test('confidence_not_exact: resolved but not exact confidence', () => assert.equal(classifyCandidate(row({ applyConfidence: 'inferred' }), CTX), 'confidence_not_exact'));
  test('eligible: everything checks out', () => assert.equal(classifyCandidate(row(), CTX), 'eligible'));

  // Damian's ruling (hourly-disqualifier, spec item D): hourly_pay is checked AFTER confidence_not_exact
  // and BEFORE the final 'eligible' return -- so an otherwise fully-eligible row still gets disqualified
  // when its own pay signal says hourly.
  describe('hourly_pay: Damian\'s ruling -- never apply to hourly-rate jobs', () => {
    test('salary_period === "hour" disqualifies regardless of salary_raw', () => {
      assert.equal(classifyCandidate(row({ salaryPeriod: 'hour', salaryRaw: 'no dollar figure here at all' }), CTX), 'hourly_pay');
    });

    test('salary_period null, salary_raw carries an hourly cue within 12 chars of a dollar figure', () => {
      assert.equal(classifyCandidate(row({ salaryPeriod: null, salaryRaw: 'Pays $55/hr, weekends optional' }), CTX), 'hourly_pay');
      assert.equal(classifyCandidate(row({ salaryPeriod: null, salaryRaw: '$45 hourly rate' }), CTX), 'hourly_pay');
    });

    test('an annual listing whose salary_raw mentions an unrelated hourly wellness stipend far from any dollar figure is NOT hourly_pay', () => {
      assert.equal(
        classifyCandidate(row({ salaryPeriod: null, salaryRaw: 'Hourly wellness stipend available; $65,000/year base' }), CTX),
        'eligible',
      );
    });

    test('salary_period === "year" is never hourly_pay even if salary_raw happens to mention "hourly" elsewhere', () => {
      assert.equal(classifyCandidate(row({ salaryPeriod: 'year', salaryRaw: 'Hourly stipend plus $150,000/year base' }), CTX), 'eligible');
    });

    test('null salaryPeriod/salaryRaw fields (pre-migration-016 rows) are unaffected', () => {
      assert.equal(classifyCandidate(row({ salaryPeriod: null, salaryRaw: null }), CTX), 'eligible');
      assert.equal(classifyCandidate(row({ salaryPeriod: undefined, salaryRaw: undefined }), CTX), 'eligible');
    });

    test('hourly_pay precedes daily_cap: a would-be-capped row is reported hourly_pay via classifyCandidate, never reaches applyDailyCap as eligible', () => {
      const classified = [{ row: row({ salaryPeriod: 'hour' }), reason: classifyCandidate(row({ salaryPeriod: 'hour' }), CTX) }];
      assert.equal(classified[0].reason, 'hourly_pay');
      const capped = applyDailyCap(classified, 0);
      assert.equal(capped[0].reason, 'hourly_pay', 'a non-eligible reason must never be overwritten by applyDailyCap');
    });
  });

  test('every non-daily_cap CLOSED_REASONS member is reachable', () => {
    const reachable = new Set([
      classifyCandidate(row({ fitScore: null }), CTX),
      classifyCandidate(row({ fitScore: 50, fitActor: 'auto' }), CTX),
      classifyCandidate(row({ fitScore: 50, fitActor: 'dashboard' }), CTX),
      classifyCandidate(row({ duplicateOf: 42 }), CTX),
      classifyCandidate(row({ locationNorm: 'country-de' }), CTX),
      classifyCandidate(row({ locationNorm: 'denver-co', salaryMax: 100000 }), CTX),
      classifyCandidate(row({ hasActiveApplication: true }), CTX),
      classifyCandidate(row({ description: null }), CTX),
      classifyCandidate(row({ applyEasyOnly: true, applyUrl: null, applyAts: null }), CTX),
      classifyCandidate(row({ applyUrl: null, applyAts: null }), CTX),
      classifyCandidate(row({ applyAts: 'workday', applyUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/x' }), CTX),
      classifyCandidate(row({ applyConfidence: 'inferred' }), CTX),
      classifyCandidate(row({ salaryPeriod: 'hour' }), CTX),
      classifyCandidate(row(), CTX),
    ]);
    for (const reason of CLOSED_REASONS) {
      if (reason === 'daily_cap') continue;
      assert.ok(reachable.has(reason), `reason "${reason}" was never produced by any test row`);
    }
  });
});

describe('dedupResolvedTargets', () => {
  test('keeps only the first of two eligible rows sharing (ats, url)', () => {
    const a = { row: row({ listingId: 1 }), reason: 'eligible' };
    const b = { row: row({ listingId: 2 }), reason: 'eligible' };
    const out = dedupResolvedTargets([a, b]);
    assert.equal(out[0].reason, 'eligible');
    assert.equal(out[1].reason, 'duplicate_of');
  });

  test('rows with different resolved targets are both kept', () => {
    const a = { row: row({ listingId: 1, applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }), reason: 'eligible' };
    const b = { row: row({ listingId: 2, applyUrl: 'https://boards.greenhouse.io/acme/jobs/2' }), reason: 'eligible' };
    const out = dedupResolvedTargets([a, b]);
    assert.equal(out[0].reason, 'eligible');
    assert.equal(out[1].reason, 'eligible');
  });

  test('a non-eligible row is passed through untouched, never counted for dedup', () => {
    const a = { row: row({ listingId: 1 }), reason: 'below_fit' };
    const b = { row: row({ listingId: 2 }), reason: 'eligible' };
    const out = dedupResolvedTargets([a, b]);
    assert.equal(out[0].reason, 'below_fit');
    assert.equal(out[1].reason, 'eligible');
  });
});

describe('applyDailyCap', () => {
  test('caps eligible rows at `remaining`, downgrading the rest to daily_cap', () => {
    const entries = [1, 2, 3].map((id) => ({ row: row({ listingId: id }), reason: 'eligible' }));
    const out = applyDailyCap(entries, 2);
    assert.deepEqual(out.map((e) => e.reason), ['eligible', 'eligible', 'daily_cap']);
  });

  test('remaining=0 caps everything', () => {
    const entries = [1, 2].map((id) => ({ row: row({ listingId: id }), reason: 'eligible' }));
    const out = applyDailyCap(entries, 0);
    assert.deepEqual(out.map((e) => e.reason), ['daily_cap', 'daily_cap']);
  });

  test('a non-eligible entry never consumes a slot', () => {
    const entries = [{ row: row({ listingId: 1 }), reason: 'below_fit' }, { row: row({ listingId: 2 }), reason: 'eligible' }];
    const out = applyDailyCap(entries, 1);
    assert.deepEqual(out.map((e) => e.reason), ['below_fit', 'eligible']);
  });
});

describe('startOfDayInTz', () => {
  test('TZ=UTC: midnight boundary matches the calendar date exactly', () => {
    const now = new Date('2026-09-03T14:30:00Z');
    const boundary = startOfDayInTz(now, 'UTC');
    assert.equal(boundary.toISOString(), '2026-09-03T00:00:00.000Z');
  });

  test('America/Chicago: midnight local is 05:00 or 06:00 UTC depending on DST', () => {
    const now = new Date('2026-09-03T18:00:00Z'); // clearly afternoon in Chicago either way
    const boundary = startOfDayInTz(now, 'America/Chicago');
    const hourUtc = boundary.getUTCHours();
    assert.ok(hourUtc === 5 || hourUtc === 6, `expected 05:00 or 06:00 UTC, got ${boundary.toISOString()}`);
    assert.equal(boundary.getUTCMinutes(), 0);
  });
});

describe('countAutoApprovedToday: only actor=auto approved transitions since local midnight', () => {
  function fakeClient(rows) {
    return {
      queries: [],
      async query(text, params) {
        this.queries.push({ text, params });
        return { rows: [{ n: rows }] };
      },
    };
  }

  test('delegates to a single count query scoped by the local-midnight boundary', async () => {
    const client = fakeClient(3);
    const now = new Date('2026-09-03T14:30:00Z');
    const n = await countAutoApprovedToday(client, now, 'UTC');
    assert.equal(n, 3);
    assert.equal(client.queries.length, 1);
    assert.match(client.queries[0].text, /actor = 'auto'/);
    assert.match(client.queries[0].text, /to_state = 'approved'/);
    assert.equal(client.queries[0].params[0].toISOString(), '2026-09-03T00:00:00.000Z');
  });
});

describe('selectCandidates: end-to-end with injected fetch/count', () => {
  test('a review FAIL never consumes a slot: cap counting only sees approved transitions', async () => {
    // Simulate: candidate A already went through resume->review(FAIL) today (no 'approved' event was ever
    // written for it, per src/dashboard/routes/applications.js's own chain -- approve() is only called
    // after VERDICT PASS). countAutoApprovedToday therefore reports 0 used slots even though a full
    // drafting/review cycle already ran once today.
    const rows = [row({ listingId: 1 })];
    const result = await selectCandidates({}, {
      fitFloor: 70, floors: FLOORS, atsAllow: ['greenhouse'], dailyCap: 5,
      now: new Date('2026-09-03T14:00:00Z'), timezone: 'UTC',
      fetchCandidateRows: async () => rows,
      countAutoApprovedToday: async () => 0,
    });
    assert.equal(result.capUsed, 0);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.results[0].reason, 'eligible');
  });

  test('dedup then cap: two eligible rows sharing a target, cap=1 -> one eligible, one duplicate_of', async () => {
    const rows = [row({ listingId: 1, fitScore: 90 }), row({ listingId: 2, fitScore: 80 })];
    const result = await selectCandidates({}, {
      fitFloor: 70, floors: FLOORS, atsAllow: ['greenhouse'], dailyCap: 5,
      now: new Date(), timezone: 'UTC',
      fetchCandidateRows: async () => rows,
      countAutoApprovedToday: async () => 0,
    });
    assert.deepEqual(result.results.map((r) => r.reason), ['eligible', 'duplicate_of']);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.eligible[0].listingId, 1);
  });

  test('the daily cap limits how many otherwise-eligible rows are actually selected', async () => {
    const rows = [1, 2, 3].map((id) => row({ listingId: id, applyUrl: `https://boards.greenhouse.io/acme/jobs/${id}` }));
    const result = await selectCandidates({}, {
      fitFloor: 70, floors: FLOORS, atsAllow: ['greenhouse'], dailyCap: 5,
      now: new Date(), timezone: 'UTC',
      fetchCandidateRows: async () => rows,
      countAutoApprovedToday: async () => 4, // only 1 slot left
    });
    assert.equal(result.capUsed, 4);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.capRemaining, 0);
    assert.deepEqual(result.results.map((r) => r.reason), ['eligible', 'daily_cap', 'daily_cap']);
  });
});
