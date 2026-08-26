// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ROWS, LINE_CHARS, MAX_RESPONSE_CHARS, DRY_RUN_WARNING, formatRow, formatSalary, compactRows, capResponse, truncate } from '../src/core/compact.js';

describe('compact caps', () => {
  test('constants match the spec', () => {
    assert.equal(MAX_ROWS, 25);
    assert.equal(LINE_CHARS, 120);
    assert.equal(MAX_RESPONSE_CHARS, 6000);
  });

  test('row renders in the documented shape', () => {
    const line = formatRow({
      id: 412, title: 'CTO', company: 'Mercy Ships', location: 'Houston, TX', remote_mode: 'hybrid',
      posted_at: '2026-08-21', salary_min: 250000, salary_max: 300000, prescore: 72, status: 'new', source: 'linkedin',
    });
    assert.equal(line, '#412 | CTO | Mercy Ships | Houston, TX (hybrid) | 2026-08-21 | $250-300k | ps 72 | new | linkedin');
  });

  test('unscored rows say unscored; fit shown when present', () => {
    const line = formatRow({ id: 1, title: 'CIO', company: 'X', status: null, fit_score: 55, source: 'indeed' });
    assert.ok(line.includes('fit 55'));
    assert.ok(line.includes('| unscored |'));
  });

  test('every row is at most LINE_CHARS', () => {
    const line = formatRow({ id: 1, title: 'T'.repeat(300), company: 'C'.repeat(300), location: 'L'.repeat(300), status: 'new', source: 'linkedin' });
    assert.ok(line.length <= LINE_CHARS);
  });

  test('formatSalary variants', () => {
    assert.equal(formatSalary(250000, 300000), '$250-300k');
    assert.equal(formatSalary(250000, null), '$250k+');
    assert.equal(formatSalary(null, 300000), 'to $300k');
    assert.equal(formatSalary(null, null), '');
    assert.equal(formatSalary(300000, 300000), '$300k');
  });

  test('compactRows never exceeds MAX_ROWS and flags truncation', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: 'CTO', company: 'Acme', status: 'new', source: 'lever' }));
    const r = compactRows(rows, { limit: 500 });
    assert.equal(r.rows.length, MAX_ROWS);
    assert.equal(r.truncated, true);
    assert.equal(r.total, 100);
    const r2 = compactRows(rows.slice(0, 5), { limit: 10 });
    assert.equal(r2.rows.length, 5);
    assert.equal(r2.truncated, false);
  });

  test('offset pages through rows', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: 'CTO', company: 'Acme', status: 'new', source: 'lever' }));
    const r = compactRows(rows, { limit: 25, offset: 25 });
    assert.equal(r.rows.length, 5);
    assert.ok(r.rows[0].startsWith('#26 '));
    assert.equal(r.truncated, false);
  });

  test('dry-run rows use #dry:N and carry the warning', () => {
    const r = compactRows([{ id: null, title: 'CTO', company: 'Acme', status: null, source: 'lever' }], { dry: true });
    assert.ok(r.rows[0].startsWith('#dry:1 '));
    assert.deepEqual(r.warnings, [DRY_RUN_WARNING]);
  });

  test('capResponse trims rows until the JSON fits and sets a hint', () => {
    const rows = Array.from({ length: 25 }, (_, i) => formatRow({ id: i + 1, title: 'X'.repeat(60), company: 'Y'.repeat(30), location: 'Z'.repeat(20), status: 'new', source: 'linkedin' }));
    const big = { ok: true, stats: { padding: 'p'.repeat(4000) }, rows, truncated: false, warnings: [] };
    assert.ok(JSON.stringify(big).length > MAX_RESPONSE_CHARS);
    const capped = capResponse(big, { hint: 'query_jobs({runId, offset:25}) for the rest' });
    assert.ok(JSON.stringify(capped).length <= MAX_RESPONSE_CHARS);
    assert.equal(capped.truncated, true);
    assert.ok(capped.rows.length < 25);
    assert.equal(capped.hint, 'query_jobs({runId, offset:25}) for the rest');
    // the original object is untouched
    assert.equal(big.rows.length, 25);
  });

  test('capResponse leaves a fitting response alone', () => {
    const small = { ok: true, rows: ['#1 | CTO | Acme'], truncated: false, warnings: [] };
    assert.equal(capResponse(small), small);
  });

  test('truncate marks with a tilde', () => {
    assert.equal(truncate('abcdef', 4), 'abc~');
    assert.equal(truncate('abc', 4), 'abc');
  });
});
