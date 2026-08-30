// @ts-check
/**
 * buildQuery() (src/tools/query_jobs.js) is a pure SQL-string builder: no DB connection needed to test
 * its WHERE/ORDER shape. Covers dashboard UX slice 2's additions: the `dir` total classification, the
 * order-lookup guard (a garbage `sort` must never resolve to `undefined` in the SQL text), and the
 * status+untriaged three-way combination fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, SORTS } from '../src/tools/query_jobs.js';

const BASE = { includeDuplicates: false, includeExpired: false, sort: 'posted', limit: 25, offset: 0 };

describe('buildQuery(): dir total classification', () => {
  test('every SORTS key, dir asc and desc, produces the matching ORDER BY column and direction', () => {
    const columnFor = { posted: 'l.posted_at', seen: 'l.last_seen', prescore: 'l.prescore', fit: 'l.fit_score', id: 'l.id' };
    for (const sort of SORTS) {
      for (const dir of ['asc', 'desc']) {
        const { sql } = buildQuery({ ...BASE, sort, dir });
        const col = columnFor[sort];
        const sqlDir = dir === 'asc' ? 'ASC' : 'DESC';
        if (sort === 'id') {
          assert.match(sql, new RegExp(`ORDER BY l\\.id ${sqlDir}\\s*$`, 'm'), `sort=${sort} dir=${dir}`);
        } else {
          assert.match(sql, new RegExp(`ORDER BY ${col.replace('.', '\\.')} ${sqlDir} NULLS LAST, l\\.id ${sqlDir}`), `sort=${sort} dir=${dir}`);
        }
      }
    }
  });

  test('dir garbage, empty, and mixed-case all fall back to desc; only exactly "asc" (any case/whitespace) is asc', () => {
    for (const dir of [undefined, '', 'garbage', 'DESCENDING', null, 42]) {
      const { sql } = buildQuery({ ...BASE, dir });
      assert.match(sql, /ORDER BY l\.posted_at DESC NULLS LAST, l\.id DESC/, `dir=${JSON.stringify(dir)}`);
    }
    for (const dir of ['asc', 'ASC', ' Asc ', 'AsC']) {
      const { sql } = buildQuery({ ...BASE, dir });
      assert.match(sql, /ORDER BY l\.posted_at ASC NULLS LAST, l\.id ASC/, `dir=${JSON.stringify(dir)}`);
    }
  });

  test('the l.id tiebreak flips with dir, independent of the primary sort column', () => {
    const asc = buildQuery({ ...BASE, sort: 'prescore', dir: 'asc' }).sql;
    const desc = buildQuery({ ...BASE, sort: 'prescore', dir: 'desc' }).sql;
    assert.match(asc, /l\.prescore ASC NULLS LAST, l\.id ASC/);
    assert.match(desc, /l\.prescore DESC NULLS LAST, l\.id DESC/);
  });

  test('NULLS LAST is present regardless of dir for every non-id sort', () => {
    for (const sort of SORTS.filter((s) => s !== 'id')) {
      for (const dir of ['asc', 'desc']) {
        const { sql } = buildQuery({ ...BASE, sort, dir });
        assert.match(sql, /NULLS LAST/, `sort=${sort} dir=${dir}`);
      }
    }
  });
});

describe('buildQuery(): sort garbage never reaches the SQL as "undefined" (latent-crash fix)', () => {
  test('a sort value outside SORTS falls back to posted, never interpolates "undefined"', () => {
    for (const sort of ['garbage', '', null, undefined, 'DROP TABLE', 123]) {
      const { sql } = buildQuery({ ...BASE, sort });
      assert.doesNotMatch(sql, /undefined/i, `sort=${JSON.stringify(sort)}`);
      assert.match(sql, /ORDER BY l\.posted_at DESC NULLS LAST, l\.id DESC/, `sort=${JSON.stringify(sort)}`);
    }
  });
});

describe('buildQuery(): status + untriaged combination (spec: three tested combinations)', () => {
  test('status only: a plain ANY(array) clause, no status IS NULL arm', () => {
    const { sql, params } = buildQuery({ ...BASE, status: ['shortlisted', 'maybe'] });
    assert.match(sql, /l\.status = ANY\(\$\d+::text\[\]\)/);
    assert.doesNotMatch(sql, /l\.status IS NULL/);
    assert.deepEqual(params.find((p) => Array.isArray(p)), ['shortlisted', 'maybe']);
  });

  test('untriaged only: a plain IS NULL clause, no ANY(array) arm', () => {
    const { sql } = buildQuery({ ...BASE, untriaged: true });
    assert.match(sql, /l\.status IS NULL/);
    assert.doesNotMatch(sql, /l\.status = ANY\(\$\d+::text\[\]\)/);
  });

  test('status AND untriaged together: one OR-combined clause, not two independently-AND\'d conditions that can never both be true', () => {
    const { sql } = buildQuery({ ...BASE, status: ['shortlisted'], untriaged: true });
    // The old bug: `l.status = ANY($n) AND l.status IS NULL` as two separate WHERE entries, which is
    // never true for any row. Assert the fixed clause is wrapped as a single parenthesized OR group,
    // not the two old fragments each landing directly in the outer `AND`-joined WHERE list.
    assert.match(sql, /\(l\.status = ANY\(\$\d+::text\[\]\) OR l\.status IS NULL\)/);
    assert.doesNotMatch(sql, /IS NULL\) AND l\.status = ANY/);
    assert.doesNotMatch(sql, /ANY\(\$\d+::text\[\]\) AND l\.status IS NULL/);
  });

  test('neither status nor untriaged, but group is set: group clause still applies unchanged', () => {
    const { sql } = buildQuery({ ...BASE, group: 'triage' });
    assert.match(sql, /l\.status = ANY\(\$\d+::text\[\]\)/);
    assert.doesNotMatch(sql, /l\.status IS NULL/);
  });
});

describe('buildQuery(): minPrescore/minFit are already-validated numbers by the time they reach here', () => {
  test('a numeric minPrescore/minFit adds the expected clause', () => {
    const { sql } = buildQuery({ ...BASE, minPrescore: 60, minFit: 80 });
    assert.match(sql, /l\.prescore >= \$\d+/);
    assert.match(sql, /l\.fit_score >= \$\d+/);
  });

  test('undefined minPrescore/minFit adds no clause', () => {
    const { sql } = buildQuery({ ...BASE, minPrescore: undefined, minFit: undefined });
    assert.doesNotMatch(sql, /l\.prescore >=/);
    assert.doesNotMatch(sql, /l\.fit_score >=/);
  });
});

describe('buildQuery(): triagedBy=auto (slice 3 auto-triage spec section 7)', () => {
  test('triagedBy: "auto" adds the latest-status-event-actor correlated subquery clause', () => {
    const { sql } = buildQuery({ ...BASE, triagedBy: 'auto' });
    assert.match(
      sql,
      /\(SELECT actor FROM ic_job_events WHERE listing_id = l\.id AND kind = 'status' ORDER BY at DESC, id DESC LIMIT 1\) = 'auto'/,
    );
  });

  test('triagedBy absent, or any value other than the literal "auto", adds no clause (total classification: only "auto" is recognized)', () => {
    for (const triagedBy of [undefined, 'dashboard', 'mcp', '', 'AUTO', 1]) {
      const { sql } = buildQuery({ ...BASE, triagedBy });
      assert.doesNotMatch(sql, /ic_job_events/, `triagedBy=${JSON.stringify(triagedBy)}`);
    }
  });
});
