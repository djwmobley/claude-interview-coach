// @ts-check
/**
 * buildQuery() (src/tools/query_jobs.js) is a pure SQL-string builder: no DB connection needed to test
 * its WHERE/ORDER shape. Covers dashboard UX slice 2's additions: the `dir` total classification, the
 * order-lookup guard (a garbage `sort` must never resolve to `undefined` in the SQL text), and the
 * status+untriaged three-way combination fix. Also covers the full-column-sort spec's additions: the six
 * new literal-column sort keys, the status column's pipeline-order CASE expression (built only from the
 * closed PIPELINE_STATUSES array, never from caller input), and the NULL-untriaged-sorts-last guard.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, SORTS } from '../src/tools/query_jobs.js';
import { PIPELINE_STATUSES, STATUS_GROUPS } from '../src/core/statuses.js';

const BASE = { includeDuplicates: false, includeExpired: false, sort: 'posted', limit: 25, offset: 0 };

// Every SORTS key that maps to a fixed literal column expression (i.e. every key except 'status', which
// gets its own CASE-expression coverage below).
const LITERAL_COLUMN_FOR = {
  posted: 'l.posted_at',
  seen: 'l.last_seen',
  prescore: 'l.prescore',
  fit: 'l.fit_score',
  id: 'l.id',
  title: 'lower(l.title)',
  company: 'lower(l.company)',
  source: 'lower(l.source)',
  location: 'lower(l.location)',
  first_seen: 'l.first_seen',
};

describe('buildQuery(): SORTS is exactly the literal-column keys plus "status"', () => {
  test('no SORTS key is missing coverage in either this file\'s literal map or the status CASE test below', () => {
    for (const sort of SORTS) assert.ok(sort === 'status' || Object.prototype.hasOwnProperty.call(LITERAL_COLUMN_FOR, sort), `sort key "${sort}" has no test coverage`);
  });
});

describe('buildQuery(): dir total classification', () => {
  test('every literal-column SORTS key, dir asc and desc, produces the matching ORDER BY column and direction', () => {
    for (const sort of Object.keys(LITERAL_COLUMN_FOR)) {
      for (const dir of ['asc', 'desc']) {
        const { sql } = buildQuery({ ...BASE, sort, dir });
        const col = LITERAL_COLUMN_FOR[sort];
        const sqlDir = dir === 'asc' ? 'ASC' : 'DESC';
        if (sort === 'id') {
          assert.match(sql, new RegExp(`ORDER BY l\\.id ${sqlDir}\\s*$`, 'm'), `sort=${sort} dir=${dir}`);
        } else {
          assert.match(sql, new RegExp(`ORDER BY ${col.replace(/[.()]/g, '\\$&')} ${sqlDir} NULLS LAST, l\\.id ${sqlDir}`), `sort=${sort} dir=${dir}`);
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

describe('buildQuery(): sort=status pipeline-order CASE (full-column-sort spec, deliberately not alphabetical)', () => {
  test('the CASE maps every PIPELINE_STATUSES member to its ordinal, in pipeline order, via literal WHEN arms', () => {
    const { sql } = buildQuery({ ...BASE, sort: 'status', dir: 'desc' });
    const caseMatch = sql.match(/CASE WHEN l\.status IS NULL THEN NULL (.*?) ELSE (\d+) END/);
    assert.ok(caseMatch, 'sql contains a CASE expression for the status sort');
    const arms = [...caseMatch[1].matchAll(/WHEN l\.status = '([^']+)' THEN (\d+)/g)].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(arms.map(([status]) => status), [...PIPELINE_STATUSES], 'WHEN arms appear in exact PIPELINE_STATUSES order');
    arms.forEach(([, ordinal], i) => assert.equal(ordinal, i + 1, `arm ${i} has the expected 1-based ordinal`));
    assert.equal(Number(caseMatch[2]), PIPELINE_STATUSES.length + 1, 'ELSE arm is one past the last known status ordinal');
  });

  test('every WHEN arm is built only from the closed PIPELINE_STATUSES array -- no other literal sneaks in', () => {
    const { sql } = buildQuery({ ...BASE, sort: 'status', dir: 'asc' });
    const caseText = sql.match(/CASE WHEN l\.status IS NULL THEN NULL .*? END/)?.[0] ?? '';
    const armValues = [...caseText.matchAll(/WHEN l\.status = '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(new Set(armValues), new Set(PIPELINE_STATUSES));
  });

  test('NULL (untriaged) is guarded before the ordinal arms, ahead of the fallback ELSE, in both directions', () => {
    for (const dir of ['asc', 'desc']) {
      const { sql } = buildQuery({ ...BASE, sort: 'status', dir });
      assert.match(sql, /CASE WHEN l\.status IS NULL THEN NULL WHEN l\.status = /, `dir=${dir}`);
    }
  });

  test('untriaged (NULL status) sorts last in BOTH directions: the CASE returns NULL for it, and NULLS LAST is unconditional on the resulting expression', () => {
    for (const dir of ['asc', 'desc']) {
      const sqlDir = dir === 'asc' ? 'ASC' : 'DESC';
      const { sql } = buildQuery({ ...BASE, sort: 'status', dir });
      // The NULLS LAST modifier binds to the whole CASE...END expression immediately preceding it, so a
      // NULL result from the CASE (produced only by the `WHEN l.status IS NULL THEN NULL` arm) sorts
      // after every row that hit a real WHEN or ELSE arm, in both ASC and DESC -- Postgres's NULLS LAST
      // semantics are direction-independent by definition, which is exactly why this sort key relies on
      // it instead of building direction-specific NULL handling itself.
      assert.match(sql, new RegExp(`CASE WHEN l\\.status IS NULL THEN NULL .*? END ${sqlDir} NULLS LAST, l\\.id ${sqlDir}`), `dir=${dir}`);
    }
  });

  test('status sort/dir never leak into params -- no interpolation of raw input into query values', () => {
    const { params } = buildQuery({ ...BASE, sort: 'status', dir: 'asc' });
    for (const p of params) assert.ok(typeof p !== 'string' || !PIPELINE_STATUSES.includes(/** @type {any} */ (p)), `params must not carry a bare status literal from the sort key: got ${JSON.stringify(p)}`);
  });
});

describe('buildQuery(): sort/dir are never interpolated into params for any new sort key', () => {
  test('params never contain the raw sortKey string itself', () => {
    for (const sort of ['title', 'company', 'source', 'status', 'location', 'first_seen']) {
      const { params } = buildQuery({ ...BASE, sort, dir: 'asc' });
      assert.ok(!params.includes(sort), `sort key "${sort}" must never appear in params`);
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

describe('buildQuery(): hideSkip (default Jobs view hides status=skip rows)', () => {
  test('hideSkip alone adds the IS-NULL-OR-not-skip predicate, keeping untriaged rows matchable', () => {
    const { sql } = buildQuery({ ...BASE, hideSkip: true });
    assert.match(sql, /\(l\.status IS NULL OR l\.status <> 'skip'\)/);
  });

  test('hideSkip absent or false adds no predicate', () => {
    for (const hideSkip of [undefined, false]) {
      const { sql } = buildQuery({ ...BASE, hideSkip });
      assert.doesNotMatch(sql, /l\.status <> 'skip'/, `hideSkip=${JSON.stringify(hideSkip)}`);
    }
  });

  test('hideSkip + status containing "skip": suppressed (explicit request to see skip rows wins)', () => {
    const { sql } = buildQuery({ ...BASE, hideSkip: true, status: ['skip', 'dead'] });
    assert.doesNotMatch(sql, /l\.status <> 'skip'/);
    assert.match(sql, /l\.status = ANY\(\$\d+::text\[\]\)/);
  });

  test('hideSkip + status NOT containing "skip": applied alongside the status filter', () => {
    const { sql } = buildQuery({ ...BASE, hideSkip: true, status: ['dead', 'lost'] });
    assert.match(sql, /l\.status <> 'skip'/);
    assert.match(sql, /l\.status = ANY\(\$\d+::text\[\]\)/);
  });

  test('every real STATUS_GROUPS group: hideSkip is suppressed only for a group whose members include "skip"', () => {
    for (const [group, members] of Object.entries(STATUS_GROUPS)) {
      const { sql } = buildQuery({ ...BASE, hideSkip: true, group });
      if (/** @type {readonly string[]} */ (members).includes('skip')) {
        assert.doesNotMatch(sql, /l\.status <> 'skip'/, `group=${group} includes skip, predicate must be suppressed`);
      } else {
        assert.match(sql, /l\.status <> 'skip'/, `group=${group} does not include skip, predicate must apply`);
      }
    }
  });

  test('hideSkip + untriaged=1: applied (untriaged discards group entirely, hideSkip is harmless there)', () => {
    const { sql } = buildQuery({ ...BASE, hideSkip: true, untriaged: true });
    assert.match(sql, /l\.status <> 'skip'/);
    assert.match(sql, /l\.status IS NULL/);
  });

  test('hideSkip + untriaged=1 + a group whose members include "skip": still applied -- group is dead in this combination', () => {
    const groupWithSkip = Object.entries(STATUS_GROUPS).find(([, members]) => /** @type {readonly string[]} */ (members).includes('skip'))?.[0];
    assert.ok(groupWithSkip, 'sanity: at least one STATUS_GROUPS group includes skip');
    const { sql } = buildQuery({ ...BASE, hideSkip: true, untriaged: true, group: groupWithSkip });
    assert.match(sql, /l\.status <> 'skip'/);
  });

  test('a bogus group with hideSkip set does not throw (adversary must-fix A1: hasOwnProperty guard before indexing STATUS_GROUPS)', () => {
    assert.doesNotThrow(() => buildQuery({ ...BASE, hideSkip: true, group: 'bogus' }));
    const { sql } = buildQuery({ ...BASE, hideSkip: true, group: 'bogus' });
    assert.match(sql, /l\.status <> 'skip'/);
  });
});

describe('buildQuery(): hideReview (jobs-unscored-visibility PR, Change 4 -- mirrors hideSkip exactly)', () => {
  test('hideReview alone adds the IS-NULL-OR-not-review predicate, keeping untriaged rows matchable', () => {
    const { sql } = buildQuery({ ...BASE, hideReview: true });
    assert.match(sql, /\(l\.status IS NULL OR l\.status <> 'review'\)/);
  });

  test('hideReview absent or false adds no predicate', () => {
    for (const hideReview of [undefined, false]) {
      const { sql } = buildQuery({ ...BASE, hideReview });
      assert.doesNotMatch(sql, /l\.status <> 'review'/, `hideReview=${JSON.stringify(hideReview)}`);
    }
  });

  test('hideReview + status containing "review": suppressed (explicit request to see review rows wins)', () => {
    const { sql } = buildQuery({ ...BASE, hideReview: true, status: ['review', 'dead'] });
    assert.doesNotMatch(sql, /l\.status <> 'review'/);
    assert.match(sql, /l\.status = ANY\(\$\d+::text\[\]\)/);
  });

  test('hideReview + status NOT containing "review": applied alongside the status filter', () => {
    const { sql } = buildQuery({ ...BASE, hideReview: true, status: ['dead', 'lost'] });
    assert.match(sql, /l\.status <> 'review'/);
    assert.match(sql, /l\.status = ANY\(\$\d+::text\[\]\)/);
  });

  test('every real STATUS_GROUPS group: hideReview is suppressed only for a group whose members include "review"', () => {
    for (const [group, members] of Object.entries(STATUS_GROUPS)) {
      const { sql } = buildQuery({ ...BASE, hideReview: true, group });
      if (/** @type {readonly string[]} */ (members).includes('review')) {
        assert.doesNotMatch(sql, /l\.status <> 'review'/, `group=${group} includes review, predicate must be suppressed`);
      } else {
        assert.match(sql, /l\.status <> 'review'/, `group=${group} does not include review, predicate must apply`);
      }
    }
  });

  test('hideReview + untriaged=1: applied (untriaged discards group entirely, hideReview is harmless there)', () => {
    const { sql } = buildQuery({ ...BASE, hideReview: true, untriaged: true });
    assert.match(sql, /l\.status <> 'review'/);
    assert.match(sql, /l\.status IS NULL/);
  });

  test('hideReview and hideSkip together both apply, independently -- neither predicate suppresses the other', () => {
    const { sql } = buildQuery({ ...BASE, hideReview: true, hideSkip: true });
    assert.match(sql, /l\.status <> 'skip'/);
    assert.match(sql, /l\.status <> 'review'/);
  });

  test('a bogus group with hideReview set does not throw', () => {
    assert.doesNotThrow(() => buildQuery({ ...BASE, hideReview: true, group: 'bogus' }));
    const { sql } = buildQuery({ ...BASE, hideReview: true, group: 'bogus' });
    assert.match(sql, /l\.status <> 'review'/);
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
