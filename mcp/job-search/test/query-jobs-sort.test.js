// @ts-check
/**
 * Cross-checks pages/jobs.js's local SORTS mirror (public/ cannot import src/tools/query_jobs.js -- see
 * that file's own comment) and every column sortKey in COLUMNS against the REAL SORTS array, so drift
 * between the two never ships silently (pages/jobs.js is a plain module import, no top-level
 * document/window access -- same pattern test/dashboard-public-kbaction-wiring.test.js already relies on).
 *
 * Full-column-sort spec additions: the sortable-columns list now covers every real column except the
 * leading checkbox column, "First seen" must key off 'first_seen' (not the pre-existing 'seen', which
 * maps server-side to last_seen -- adversary finding 3), and every sortable COLUMNS entry must have a
 * matching FIRST_CLICK_DIR entry (adversary finding 2) plus table-driven coverage of the pure
 * nextSortState() click-state transition (adversary finding 1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SORTS as REAL_SORTS } from '../src/tools/query_jobs.js';
import { SORTS as JOBS_PAGE_SORTS, COLUMNS, FIRST_CLICK_DIR, nextSortState } from '../src/dashboard/public/pages/jobs.js';

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

  test('every column except the leading checkbox column is sortable, in COLUMNS order', () => {
    const sortable = COLUMNS.filter((c) => typeof c === 'object' && c.sortKey).map((c) => c.text);
    assert.deepEqual(sortable, ['Title', 'Company', 'Source', 'Stage', 'Prescore', 'Fit', 'First seen', 'Location']);
  });

  test('adversary finding 3: "First seen" sortKey is exactly "first_seen", never "seen" (which maps to last_seen server-side)', () => {
    const firstSeenCol = COLUMNS.find((c) => typeof c === 'object' && c.text === 'First seen');
    assert.ok(firstSeenCol, 'sanity: a "First seen" column exists');
    assert.equal(/** @type {any} */ (firstSeenCol).sortKey, 'first_seen');
  });

  test('adversary finding 2: every sortable COLUMNS sortKey has an explicit FIRST_CLICK_DIR entry (drift test)', () => {
    const sortKeys = COLUMNS.filter((c) => typeof c === 'object' && c.sortKey).map((c) => c.sortKey);
    for (const key of sortKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(FIRST_CLICK_DIR, key), `sortKey "${key}" has no FIRST_CLICK_DIR entry`);
    }
  });
});

describe('nextSortState(): adversary finding 1, table-driven pure click-state transition', () => {
  test('first click on each alpha/status column starts ascending', () => {
    for (const key of ['title', 'company', 'source', 'status', 'location']) {
      const result = nextSortState({ sort: 'posted', dir: 'desc' }, key);
      assert.deepEqual(result, { sort: key, dir: 'asc' }, `first click on "${key}"`);
    }
  });

  test('first click on each numeric/date column starts descending', () => {
    for (const key of ['prescore', 'fit', 'first_seen']) {
      const result = nextSortState({ sort: 'posted', dir: 'desc' }, key);
      assert.deepEqual(result, { sort: key, dir: 'desc' }, `first click on "${key}"`);
    }
  });

  test('a second click on the same column toggles the direction, for every sortable key', () => {
    for (const key of Object.keys(FIRST_CLICK_DIR)) {
      const first = nextSortState({ sort: 'posted', dir: 'desc' }, key);
      const second = nextSortState(first, key);
      assert.equal(second.sort, key);
      assert.notEqual(second.dir, first.dir, `toggle on "${key}"`);
      const third = nextSortState(second, key);
      assert.equal(third.dir, first.dir, `toggle back on "${key}"`);
    }
  });

  test('switching directly from one column to another (not a repeat click) uses the new column\'s first-click direction, not a toggle of the old one', () => {
    const afterTitleDesc = nextSortState({ sort: 'title', dir: 'desc' }, 'prescore');
    assert.deepEqual(afterTitleDesc, { sort: 'prescore', dir: 'desc' });
    const afterPrescoreAsc = nextSortState({ sort: 'prescore', dir: 'asc' }, 'company');
    assert.deepEqual(afterPrescoreAsc, { sort: 'company', dir: 'asc' });
  });

  test('an unknown sortKey (outside FIRST_CLICK_DIR) falls back to desc on first click -- total classification', () => {
    const result = nextSortState({ sort: 'posted', dir: 'desc' }, 'not_a_real_column');
    assert.deepEqual(result, { sort: 'not_a_real_column', dir: 'desc' });
  });
});
