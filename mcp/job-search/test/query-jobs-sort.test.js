// @ts-check
/**
 * Cross-checks pages/jobs.js's local SORTS mirror (public/ cannot import src/tools/query_jobs.js -- see
 * that file's own comment) and every column sortKey in COLUMNS against the REAL SORTS array, so drift
 * between the two never ships silently (pages/jobs.js is a plain module import, no top-level
 * document/window access -- same pattern test/dashboard-public-kbaction-wiring.test.js already relies on).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SORTS as REAL_SORTS } from '../src/tools/query_jobs.js';
import { SORTS as JOBS_PAGE_SORTS, COLUMNS } from '../src/dashboard/public/pages/jobs.js';

describe('pages/jobs.js SORTS mirror matches the real SORTS array', () => {
  test('same values, same order', () => {
    assert.deepEqual([...JOBS_PAGE_SORTS], [...REAL_SORTS]);
  });
});

describe('every COLUMNS sortKey is a real SORTS value', () => {
  test('no column declares a sortKey outside SORTS', () => {
    const sortKeys = COLUMNS.filter((c) => typeof c === 'object' && c.sortKey).map((c) => c.sortKey);
    assert.ok(sortKeys.length > 0, 'sanity: at least one column actually declares a sortKey');
    for (const key of sortKeys) {
      assert.ok(REAL_SORTS.includes(key), `COLUMNS sortKey "${key}" is not in the real SORTS array`);
    }
  });

  test('Prescore and Fit are the two sortable columns', () => {
    const sortable = COLUMNS.filter((c) => typeof c === 'object' && c.sortKey).map((c) => c.text);
    assert.deepEqual(sortable, ['Prescore', 'Fit']);
  });
});
