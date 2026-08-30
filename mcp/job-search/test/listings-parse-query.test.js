// @ts-check
/**
 * parseListingsQuery() (src/dashboard/routes/listings.js) is a pure function over a plain string-keyed
 * object -- no DB or HTTP needed to test it. Covers the fixes made in dashboard UX slice 2: sort/dir
 * validated by exact membership rather than passed through raw, and minPrescore/minFit mirroring the
 * MCP tool's own zod rule (drop out-of-range/non-integer input, never clamp it).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseListingsQuery } from '../src/dashboard/routes/listings.js';
import { SORTS } from '../src/tools/query_jobs.js';

describe('parseListingsQuery(): sort', () => {
  test('every real SORTS value passes through unchanged', () => {
    for (const sort of SORTS) {
      assert.equal(parseListingsQuery({ sort }).sort, sort);
    }
  });

  test('a garbage sort value falls back to "posted", never reaching buildQuery unvalidated', () => {
    for (const sort of ['garbage', 'DROP TABLE', '', 'Posted']) {
      assert.equal(parseListingsQuery({ sort }).sort, 'posted', `sort=${JSON.stringify(sort)}`);
    }
  });

  test('a missing sort defaults to "posted"', () => {
    assert.equal(parseListingsQuery({}).sort, 'posted');
  });
});

describe('parseListingsQuery(): dir', () => {
  test('exactly "asc" (any case, trimmed) maps to asc', () => {
    for (const dir of ['asc', 'ASC', ' Asc ', 'aSc']) {
      assert.equal(parseListingsQuery({ dir }).dir, 'asc', `dir=${JSON.stringify(dir)}`);
    }
  });

  test('garbage, empty, missing, and "desc" itself all map to desc', () => {
    for (const dir of [undefined, '', 'garbage', 'desc', 'DESC', 'ascending']) {
      assert.equal(parseListingsQuery({ dir }).dir, 'desc', `dir=${JSON.stringify(dir)}`);
    }
  });
});

describe('parseListingsQuery(): minPrescore/minFit mirror the MCP zod rule (drop, never clamp)', () => {
  test('an in-range integer string passes through as a number', () => {
    assert.equal(parseListingsQuery({ minPrescore: '60' }).minPrescore, 60);
    assert.equal(parseListingsQuery({ minFit: '0' }).minFit, 0);
    assert.equal(parseListingsQuery({ minFit: '100' }).minFit, 100);
  });

  test('out-of-range values are dropped (undefined), never clamped into [0,100]', () => {
    assert.equal(parseListingsQuery({ minPrescore: '150' }).minPrescore, undefined);
    assert.equal(parseListingsQuery({ minPrescore: '-5' }).minPrescore, undefined);
    assert.equal(parseListingsQuery({ minFit: '1000' }).minFit, undefined);
  });

  test('a non-integer (fractional or NaN) value is dropped', () => {
    assert.equal(parseListingsQuery({ minPrescore: '50.5' }).minPrescore, undefined);
    assert.equal(parseListingsQuery({ minPrescore: 'not-a-number' }).minPrescore, undefined);
  });

  test('an absent param stays undefined, applying no filter', () => {
    assert.equal(parseListingsQuery({}).minPrescore, undefined);
    assert.equal(parseListingsQuery({}).minFit, undefined);
  });
});

describe('repeated query params: Object.fromEntries keeps the LAST value (documented, not this function\'s own decision)', () => {
  test('a repeated key in a real querystring resolves to its last occurrence before parseListingsQuery ever sees it', () => {
    // server.js builds ctx.query via `Object.fromEntries(url.searchParams)` before calling
    // parseListingsQuery -- by the time this function runs, a repeated `?sort=fit&sort=prescore` has
    // already collapsed to a single string. This test documents that upstream behavior directly (not a
    // property of parseListingsQuery itself), so a future change to how query objects are built cannot
    // silently flip "last wins" to "first wins" without this test catching it.
    const params = new URLSearchParams('sort=fit&sort=prescore&dir=asc&dir=desc');
    const q = Object.fromEntries(params);
    assert.deepEqual(q, { sort: 'prescore', dir: 'desc' });
    assert.equal(parseListingsQuery(q).sort, 'prescore');
    assert.equal(parseListingsQuery(q).dir, 'desc');
  });
});

describe('parseListingsQuery(): triagedBy (slice 3 auto-triage spec section 7)', () => {
  test('"auto" passes through unchanged', () => {
    assert.equal(parseListingsQuery({ triagedBy: 'auto' }).triagedBy, 'auto');
  });
  test('any other value, or a missing param, reduces to undefined -- total classification, never passed through raw', () => {
    for (const triagedBy of [undefined, '', 'dashboard', 'AUTO', 'auto ']) {
      assert.equal(parseListingsQuery({ triagedBy }).triagedBy, undefined, `triagedBy=${JSON.stringify(triagedBy)}`);
    }
  });
});
