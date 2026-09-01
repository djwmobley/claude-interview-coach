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
 *
 * Jobs-table layout-stability fix additions: every COLUMNS entry (including the leading checkbox column)
 * now carries a className matching its body-cell class in components/job-row.js, since app.css's
 * .jobs-table fixed-layout width rules and the 1180px breakpoint's column-hiding rules both key off that
 * pairing -- see the "paired header/cell className" describe block below.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SORTS as REAL_SORTS } from '../src/tools/query_jobs.js';
import { SORTS as JOBS_PAGE_SORTS, COLUMNS, FIRST_CLICK_DIR, nextSortState, DEFAULT_FILTER_STATE } from '../src/dashboard/public/pages/jobs.js';

describe('DEFAULT_FILTER_STATE (single source of truth for the default Jobs view, adversary must-fix A2)', () => {
  // pages/jobs.js's render() (initial filterState) and onResetView() (the Reset view button's restore
  // path) both spread this SAME object (`{ ...DEFAULT_FILTER_STATE }`) rather than each keeping its own
  // independent `{ hideDuplicates: true, ... }` literal -- two literals had already drifted out of sync
  // once (hideSkip needed adding to both) before this constant existed. Neither render() nor
  // onResetView() is itself unit-testable without a DOM/page harness (no such harness exists yet for this
  // page, per the other test files here), so this test pins the one thing that IS directly testable: the
  // shared constant's exact shape. A future literal reintroduced at either call site instead of this
  // constant would not be caught by this test, but a change to the constant's shape not reflected here
  // would be.
  test('is exactly { hideDuplicates: true, hideSkip: true, hideReview: true }', () => {
    assert.deepEqual(DEFAULT_FILTER_STATE, { hideDuplicates: true, hideSkip: true, hideReview: true });
  });

  test('is frozen (Object.freeze), so a caller cannot mutate the shared default in place', () => {
    assert.ok(Object.isFrozen(DEFAULT_FILTER_STATE));
  });
});

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

describe('every COLUMNS entry carries the paired header/cell className used by app.css (layout-stability fix)', () => {
  // app.css's .jobs-table fixed-layout width rules and the 1180px breakpoint's column-hiding rules both
  // key off these classes matching the real body-cell classes in components/job-row.js -- a header
  // without (or with the wrong) className either gets no explicit width (auto layout falls back to
  // content-driven sizing for that column again) or gets hidden/sized under the wrong column entirely.
  // Table-driven so adding a column without wiring its className shows up here, not as a layout bug only
  // visible in a live browser.
  const EXPECTED_CLASS_NAMES = {
    '': 'job-row__checkbox',
    Title: 'job-row__title',
    Company: 'job-row__company',
    Source: 'job-row__source',
    Stage: 'job-row__stage',
    Prescore: 'job-row__prescore',
    Fit: 'job-row__fit',
    'First seen': 'job-row__first-seen',
    Location: 'job-row__location',
  };

  test('every column is an object with a className, no bare string columns remain', () => {
    for (const col of COLUMNS) {
      assert.equal(typeof col, 'object', `column ${JSON.stringify(col)} should be an object, not a bare string`);
    }
  });

  test('every column className exactly matches its expected body-cell class, in COLUMNS order', () => {
    const actual = COLUMNS.map((c) => [/** @type {any} */ (c).text, /** @type {any} */ (c).className]);
    const expected = Object.entries(EXPECTED_CLASS_NAMES);
    assert.deepEqual(actual, expected);
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
