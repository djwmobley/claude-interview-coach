// @ts-check
/**
 * unionSourceOptions() (src/dashboard/public/pages/jobs.js) -- a plain module-level function, no
 * document/window access (same pattern test/query-jobs-sort.test.js already relies on for this same
 * file's SORTS/COLUMNS). Dashboard UX slice 3: the Filters modal's Source checkbox options are now the
 * union of GET /api/sources's live distinct-source list and the session's own accumulated union of
 * row.source values seen in loaded /api/listings pages (see filter-modal.js's own header comment for why
 * neither list alone is sufficient).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unionSourceOptions } from '../src/dashboard/public/pages/jobs.js';

describe('unionSourceOptions()', () => {
  test('merges both lists, deduplicated and sorted ascending', () => {
    assert.deepEqual(
      unionSourceOptions(['linkedin', 'indeed'], ['indeed', 'gmail']),
      ['gmail', 'indeed', 'linkedin'],
    );
  });

  test('a source only in apiSources (never yet seen in a loaded row) still appears', () => {
    assert.deepEqual(unionSourceOptions(['oracle'], []), ['oracle']);
  });

  test('a source only in seenSources (not yet reflected by a fresh /api/sources fetch) still appears', () => {
    assert.deepEqual(unionSourceOptions([], ['dice']), ['dice']);
  });

  test('both empty (initial state, before either has loaded) returns an empty array', () => {
    assert.deepEqual(unionSourceOptions([], []), []);
  });

  test('a Set works as seenSources directly (the page keeps it as a Set, not an array)', () => {
    assert.deepEqual(unionSourceOptions(['manual'], new Set(['manual', 'linkedin'])), ['linkedin', 'manual']);
  });
});
