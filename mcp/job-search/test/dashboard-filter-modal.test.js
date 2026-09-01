// @ts-check
/**
 * Filter modal (components/filter-modal.js) and filter-bar's activeFilterCount()/filterStateToQuery()
 * pure-logic tests (dashboard UX slice 2). Same pattern as test/dashboard-chips.test.js: cross-check a
 * public/-side hand-maintained mirror against the REAL source list, since public/ cannot import
 * src/core/statuses.js or src/core/config.js directly (both pull in Node-only code the browser cannot
 * resolve).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_STATUSES } from '../src/core/statuses.js';
import { NOISE_CLASSES } from '../src/core/config.js';
import { FILTER_MODAL_STATUSES, FILTER_MODAL_NOISE_CLASSES } from '../src/dashboard/public/components/filter-modal.js';
import { activeFilterCount, filterStateToQuery } from '../src/dashboard/public/components/filter-bar.js';

describe('filter-modal.js status/noise-class mirrors match the real source lists', () => {
  test('FILTER_MODAL_STATUSES is exactly PIPELINE_STATUSES (same members, order-independent)', () => {
    assert.deepEqual([...FILTER_MODAL_STATUSES].sort(), [...PIPELINE_STATUSES].sort());
  });

  test('FILTER_MODAL_NOISE_CLASSES is exactly NOISE_CLASSES (same members, order-independent)', () => {
    assert.deepEqual([...FILTER_MODAL_NOISE_CLASSES].sort(), [...NOISE_CLASSES].sort());
  });
});

describe('filterStateToQuery(): booleans serialize as exactly "1" when true, absent when false', () => {
  for (const key of ['unscored', 'includeExpired', 'untriaged']) {
    test(`${key}: true -> "1"`, () => {
      assert.equal(filterStateToQuery({ [key]: true })[key], '1');
    });
    test(`${key}: false -> absent`, () => {
      assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({ [key]: false }), key), false);
    });
    test(`${key}: absent from state -> absent from query`, () => {
      assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({}), key), false);
    });
  }
});

describe('filterStateToQuery(): hideSkip (bar-owned, deliberately opposite polarity from hideDuplicates)', () => {
  test('true -> hideSkip=1 (checked/default state DOES send a param, unlike the includeDuplicates polarity)', () => {
    assert.equal(filterStateToQuery({ hideSkip: true }).hideSkip, '1');
  });
  test('false -> absent', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({ hideSkip: false }), 'hideSkip'), false);
  });
  test('absent from state -> absent from query (server default stays unfiltered for MCP callers)', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({}), 'hideSkip'), false);
  });
});

describe('filterStateToQuery(): hideReview (jobs-unscored-visibility PR, Change 4 -- same bar ownership and polarity as hideSkip)', () => {
  test('true -> hideReview=1 (checked/default state DOES send a param, unlike the includeDuplicates polarity)', () => {
    assert.equal(filterStateToQuery({ hideReview: true }).hideReview, '1');
  });
  test('false -> absent', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({ hideReview: false }), 'hideReview'), false);
  });
  test('absent from state -> absent from query (server default stays unfiltered for MCP callers)', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({}), 'hideReview'), false);
  });
});

describe('filterStateToQuery(): postedAfter precedence (modal exact date wins over the bar\'s rolling window)', () => {
  test('postedAfterExact set, firstSeenDays also set: the exact date wins outright, not merged', () => {
    const q = filterStateToQuery({ postedAfterExact: '2026-01-15', firstSeenDays: '7' });
    assert.equal(q.postedAfter, '2026-01-15');
  });

  test('only firstSeenDays set: the rolling window still works exactly as before', () => {
    const q = filterStateToQuery({ firstSeenDays: '1' });
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(q.postedAfter));
  });

  test('neither set: no postedAfter key at all', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({}), 'postedAfter'), false);
  });
});

describe('filterStateToQuery(): multi-select arrays join as a single comma-separated param', () => {
  test('status/source/noiseClass serialize as buildQuery/listParam already expects (comma-joined, section 9 item 1 convention)', () => {
    const q = filterStateToQuery({ status: ['maybe', 'shortlisted'], source: ['linkedin'], noiseClass: ['ok', 'suspect'] });
    assert.equal(q.status, 'maybe,shortlisted');
    assert.equal(q.source, 'linkedin');
    assert.equal(q.noiseClass, 'ok,suspect');
  });

  test('an empty array omits the param entirely (0-of-N checked)', () => {
    const q = filterStateToQuery({ status: [] });
    assert.equal(Object.prototype.hasOwnProperty.call(q, 'status'), false);
  });
});

describe('filterStateToQuery(): triagedByAuto -> triagedBy=auto (slice 3 auto-triage spec section 7, a value-based query extension, not a boolean flag like the checkboxes above)', () => {
  test('true -> triagedBy=auto', () => {
    assert.equal(filterStateToQuery({ triagedByAuto: true }).triagedBy, 'auto');
  });
  test('false -> absent', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({ triagedByAuto: false }), 'triagedBy'), false);
  });
  test('absent from state -> absent from query', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(filterStateToQuery({}), 'triagedBy'), false);
  });
});

describe('activeFilterCount(): counts each modal-owned dimension once, using filterStateToQuery\'s own truthiness rules', () => {
  test('an empty state counts zero', () => {
    assert.equal(activeFilterCount({}), 0);
  });

  test('one dimension set counts one, regardless of how many values a multi-select carries', () => {
    assert.equal(activeFilterCount({ status: ['maybe', 'shortlisted', 'applied'] }), 1);
  });

  test('every modal-owned dimension set at once counts exactly eleven (slice 3 auto-triage spec section 7 adds triagedByAuto)', () => {
    const state = {
      status: ['maybe'], source: ['linkedin'], noiseClass: ['ok'], remote: 'remote',
      postedAfterExact: '2026-01-01', minPrescore: 40, minFit: 60,
      unscored: true, includeExpired: true, untriaged: true, triagedByAuto: true,
    };
    assert.equal(activeFilterCount(state), 11);
  });

  test('bar-owned fields (search, location, firstSeenDays, hideDuplicates, hideSkip, hideReview) never count toward n', () => {
    assert.equal(activeFilterCount({ search: 'cto', location: 'Houston, TX', firstSeenDays: '7', hideDuplicates: false, hideSkip: false, hideReview: false }), 0);
  });

  test('an empty multi-select array does not count', () => {
    assert.equal(activeFilterCount({ status: [] }), 0);
  });

  test('minPrescore/minFit of 0 does not count (0 is not a meaningful floor filter)', () => {
    assert.equal(activeFilterCount({ minPrescore: 0, minFit: 0 }), 0);
  });
});
